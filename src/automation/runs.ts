/** Starts saved workflows and owns run scheduling, human tasks, step services, and durable replay callbacks. */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { DurableDeferred, WorkflowEngine } from "effect/workflow";
import { agentOutput, agentPrompt, decideRequest, decision } from "../workflow/agent-step.ts";
import { Classifier } from "../ai/classifier.ts";
import { AutomationHost } from "./host.ts";
import { PiAgent } from "../ai/pi.ts";
import { emptyTrace } from "../ai/trace.ts";
import { checkWorkflow } from "../workflow/catalog.ts";
import { runAction } from "../connections/runner.ts";
import { SlackSender } from "../connections/slack.ts";
import { findOperation } from "../connections/registry.ts";
import { makeDurableEngine, type DurableEngine } from "../workflow/durable-engine.ts";
import {
  HumanResponse,
  respondToHuman,
  RunAutomation,
  RunAutomationLive,
  StepFailed,
  StepRunner,
  type HumanRequest,
  type PermissionRequest,
} from "../workflow/interpreter.ts";
import { EntityStore } from "../entities/store.ts";
import { Event, SuppliedEvent } from "../events/model.ts";
import { Events } from "../events/service.ts";
import {
  changedFields,
  isEmailField,
  type EntityData,
  type EntityType,
  type Subject,
} from "../entities/model.ts";
import { expandTemplates } from "../entities/templates.ts";
import {
  conditionRefs,
  holds,
  subjectType,
  isTimed,
  triggerSchedule,
  valueMatches,
  type Workflow,
} from "../workflow/model.ts";
import { MAX_SCHEDULED_RUNS, nextOccurrence, occursAt, tooManyRuns } from "../workflow/schedule.ts";
import { makeSubjects } from "./subjects.ts";
import { RunId, type Run, type HumanTask, type RunSummary } from "../workflow/run.ts";
import { ExecutionId } from "../workflow/execution.ts";
import { AutomationError } from "./model.ts";
import type { WorkflowStore } from "./workflow-store.ts";
import { makeRunStore, type StoredRun } from "./run-store.ts";

const decodeToken = Schema.decodeUnknownEffect(DurableDeferred.Token);

/** Payload of the `advance` callback, which replays a run's execution: a persisted contract. */
interface Advance {
  readonly executionId: ExecutionId;
}

/** Payload of the `clock` callback, which fires a durable clock: a persisted contract. */
interface ClockFired {
  readonly executionId: ExecutionId;
  readonly deferredName: string;
}

/** Payload of the `tick` callback, an occurrence of the saved schedule: a persisted contract. */
interface Tick {
  readonly at: number;
}

/**
 * An occurrence's run IDs are fixed by its time and subject, so a redelivered tick finds the runs
 * it already started instead of starting them again.
 */
const scheduledRunId = (at: number, subject: Subject | null) =>
  RunId.make(subject === null ? `scheduled-${at}` : `scheduled-${at}-${subject.id}`);

const summary = (types: ReadonlyArray<EntityType>, run: Run): RunSummary => {
  const type = types.find((candidate) => candidate.name === run.subject?.type);
  const title = type === undefined ? undefined : run.subject?.data[type.title];
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    subject: run.subject === null ? null : typeof title === "string" ? title : run.subject.id,
    openTasks: run.tasks.filter((task) => task.status === "open").length,
  };
};

/** Coordinates saved runs, their human tasks, and durable replay for one automation. */
export const makeRuns = Effect.fn("Automation.makeRuns")(function* (workflows: WorkflowStore) {
  const host = yield* AutomationHost;
  const storage = host.storage;
  const entities = yield* EntityStore;
  const events = yield* Events;
  // A Reference: null (Slack simulated) unless the host provides a sender.
  const slack = yield* SlackSender;
  const pi = yield* PiAgent;
  const classifier = yield* Classifier;
  const { read: readWorkflow, catalog } = workflows;
  const records = yield* makeRunStore();
  const { loadEntity, resolve, due } = yield* makeSubjects();
  const { read: readRun, write: writeRun, update: updateRun } = records;

  /** A role's members as approvers: their names and email addresses, as stored now. */
  const approversOf = Effect.fn("Automation.approversOf")(function* (roleName: string) {
    const { types, roles } = yield* catalog;
    const role = roles.find((candidate) => candidate.name === roleName);
    if (role === undefined) {
      return yield* new AutomationError({ message: `No role ${roleName}` });
    }
    const members = yield* Effect.forEach(role.members, (member) =>
      entities.getEntity(member.type, member.id).pipe(
        Effect.map((found) => {
          const type = types.find((candidate) => candidate.name === member.type);
          const email = type?.fields.find(isEmailField);
          const address = email === undefined ? undefined : found?.data[email.name];
          const name = type === undefined ? undefined : found?.data[type.title];
          return typeof address === "string"
            ? [{ name: typeof name === "string" ? name : member.id, email: address }]
            : [];
        }),
      ),
    );
    return { role: role.name, label: role.label, members: members.flat() };
  });

  // Agent steps in a run share one conversation, so later steps can build on earlier answers.
  const conversationLock = Semaphore.makeUnsafe(1);
  const conversationFor = (runId: RunId) =>
    conversationLock.withPermit(
      Effect.gen(function* () {
        const existing = (yield* readRun(runId))?.conversation;
        if (existing !== undefined) {
          return existing;
        }
        const created = yield* pi.createConversation;
        yield* updateRun(runId, (run) => ({ ...run, conversation: created }));
        return created;
      }),
    );

  const requestHuman = (request: HumanRequest) =>
    updateRun(request.runId, (run) => {
      if (run.tasks.some((task) => task.step === request.step.id)) {
        return run;
      }
      // NOTE: `notify` is recorded, not sent, even when Slack is connected.
      const task: HumanTask = {
        step: request.step.id,
        token: request.token,
        title: request.step.title,
        prompt: request.prompt,
        assignee: request.assignee,
        response: request.step.response,
        defaults: request.defaults,
        ...(request.step.notify === undefined ? {} : { notify: request.step.notify }),
        status: "open",
      };
      return { ...run, tasks: [...run.tasks, task] };
    });

  const requestPermission = (request: PermissionRequest) =>
    Effect.flatMap(approversOf(request.role), (approvers) =>
      updateRun(request.runId, (run) => {
        if (run.tasks.some((task) => task.step === request.step.id)) {
          return run;
        }
        const operation = findOperation(request.step.use)?.title ?? request.step.use;
        const task: HumanTask = {
          step: request.step.id,
          token: request.token,
          title: request.title,
          prompt: `${operation} with the details below? Rejecting skips this step and the steps that need its result.`,
          assignee: null,
          response: "approval",
          defaults: {},
          action: { use: request.step.use, inputs: request.inputs },
          approvers,
          status: "open",
        };
        return { ...run, tasks: [...run.tasks, task] };
      }),
    );

  const stepFailed = (step: string) => (error: { readonly message: string }) =>
    new StepFailed({ step, message: error.message });

  const runner = StepRunner.of({
    resolve: (refs, known) => resolve(refs, known).pipe(Effect.mapError(stepFailed("refs"))),
    agent: ({ step, instruction, state: known }, idempotencyKey) =>
      Effect.gen(function* () {
        const conversation = yield* conversationFor(known.runId);
        const answer = yield* pi.prompt({
          conversation,
          requestId: `agent:${idempotencyKey}`,
          text: agentPrompt(step, instruction, known),
        });
        return yield* agentOutput(step, answer);
      }).pipe(Effect.mapError(stepFailed(step.id))),
    action: ({ step, inputs, state: known }, idempotencyKey) =>
      runAction(step, inputs, known, idempotencyKey).pipe(
        Effect.provideService(Events, events),
        Effect.provideService(SlackSender, slack),
      ),
    // A classifier call keeps no conversation, so asking again on a replay repeats nothing.
    decide: ({ step, question, state: known }) =>
      classifier
        .classify(decideRequest(step, question, known))
        .pipe(Effect.flatMap(decision), Effect.mapError(stepFailed(step.id))),
    requestHuman,
    requestPermission: (request) =>
      requestPermission(request).pipe(Effect.mapError(stepFailed(request.step.id))),
    report: records.report,
  });

  const durable: DurableEngine = makeDurableEngine({
    get: storage.get,
    put: storage.put,
    wake: host.jobs.advance,
    wakeAt: ({ executionId, deferredName, at }) => host.jobs.clock(executionId, deferredName, at),
  });
  const provideEngine = Effect.provideService(WorkflowEngine.WorkflowEngine, durable.engine);
  yield* Layer.build(
    RunAutomationLive.pipe(
      Layer.provide(Layer.succeed(StepRunner, runner)),
      Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, durable.engine)),
    ),
  ).pipe(Effect.scoped);

  // Delivery is at least once, and a replay only reruns what the journal lacks: Activities
  // that finished keep their results. An action interrupted by eviction runs again with the
  // same idempotency key.
  const advance = Effect.fn("Automation.advance")(function* ({ executionId }: Advance) {
    const runId = yield* records.runForExecution(executionId);
    if (runId === undefined) {
      return;
    }
    yield* updateRun(runId, (run) =>
      run.status === "waiting" ? { ...run, status: "running" } : run,
    );
    const result = yield* durable.replay(RunAutomation, executionId);
    yield* records.settle(runId, result);
  });

  const clock = Effect.fn("Automation.clock")(function* ({
    executionId,
    deferredName,
  }: ClockFired) {
    yield* durable.fireClock(RunAutomation, executionId, deferredName);
  });

  /** Records a run that failed before it started, so the studio shows why. */
  const recordFailedRun = Effect.fn("Automation.recordFailedRun")(function* (
    id: RunId,
    workflow: Workflow,
    subject: Subject | null,
    error: string,
    event?: Event,
  ) {
    const run: StoredRun = {
      id,
      workflow,
      subject,
      ...(event === undefined ? {} : { event }),
      status: "failed",
      steps: {},
      tasks: [],
      error,
      startedAt: yield* Clock.currentTimeMillis,
    };
    yield* writeRun(run);
    return { id, status: run.status };
  });

  /**
   * Starts a run of the saved workflow. Entity types and templates may have changed since the
   * save, so the workflow is checked again, and a run that no longer checks is recorded as
   * failed instead of starting. The run executes the workflow with its templates expanded, so
   * it keeps the wording it started with.
   */
  const beginRun = Effect.fn("Automation.beginRun")(function* (
    saved: Workflow,
    subject: Subject | null,
    id: RunId = RunId.make(crypto.randomUUID()),
    event?: Event,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    const current = yield* catalog;
    const prepared = yield* checkWorkflow(current, saved).pipe(
      Effect.flatMap((checked) => expandTemplates(checked, current.templates)),
      Effect.result,
    );
    if (Result.isFailure(prepared)) {
      return yield* recordFailedRun(
        id,
        saved,
        subject,
        `The saved workflow no longer fits the entity types and templates. Update it and save again.\n${prepared.failure.message}`,
        event,
      );
    }
    const workflow = prepared.success;
    const payload = { runId: id, workflow, subject, ...(event === undefined ? {} : { event }) };
    const executionId = ExecutionId.make(yield* RunAutomation.executionId(payload));
    const run: StoredRun = {
      id,
      workflow,
      subject,
      ...(event === undefined ? {} : { event }),
      status: "running",
      steps: {},
      tasks: [],
      startedAt,
    };
    yield* storage
      .transaction(
        Effect.gen(function* () {
          yield* writeRun(run);
          yield* records.linkExecution(executionId, id);
          yield* RunAutomation.execute(payload, { discard: true }).pipe(provideEngine);
        }),
      )
      .pipe(Effect.orDie);
    return { id, status: run.status };
  });

  // Run titles only label runs, so a D1 failure shows subject IDs instead of failing the read.
  const entityTypesForTitles = entities.listTypes.pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Couldn't read entity types for run titles", error),
    ),
    Effect.orElseSucceed(() => []),
  );

  /** Every run, newest first. */
  const runSummaries = Effect.gen(function* () {
    const runs = yield* records.all;
    const types = yield* entityTypesForTitles;
    return runs.map((run) => summary(types, run));
  });

  /** Runs only this saved workflow, with supplied event data rather than publishing an event. */
  const start = Effect.fn("Automation.start")(function* (
    subjectId: string | undefined,
    suppliedEvent?: SuppliedEvent,
  ) {
    const saved = yield* readWorkflow("saved");
    if (saved === undefined) {
      return yield* new AutomationError({ message: "Save the workflow before starting it" });
    }
    const trigger = saved.trigger;
    if (trigger.kind === "event" && suppliedEvent === undefined) {
      return yield* new AutomationError({
        message: `Supply event data for ${trigger.event} to run this workflow`,
      });
    }
    if (trigger.kind !== "event" && suppliedEvent !== undefined) {
      return yield* new AutomationError({ message: "This workflow does not take event data" });
    }
    const type = subjectType(saved.trigger);
    const subject = yield* Effect.gen(function* () {
      if (type === undefined) return null;
      if (subjectId === undefined) {
        return yield* new AutomationError({ message: `Pick the ${type} this run is about` });
      }
      const loaded = yield* loadEntity(type, subjectId);
      if (loaded === undefined) {
        return yield* new AutomationError({ message: `No ${type} ${subjectId}` });
      }
      return loaded;
    });
    if (trigger.kind === "event" && suppliedEvent !== undefined) {
      const supplied = yield* Schema.decodeEffect(SuppliedEvent)(suppliedEvent);
      const event: Event = {
        id: crypto.randomUUID(),
        name: trigger.event,
        data: supplied.data,
        depth: 0,
        ...(subject === null ? {} : { subject }),
      };
      if (trigger.when !== undefined) {
        const values = yield* resolve(conditionRefs(trigger.when), { subject, event, steps: {} });
        const now = yield* Clock.currentTimeMillis;
        if (!holds(trigger.when, (ref) => values[ref], now)) {
          return yield* new AutomationError({
            message: "The supplied event and subject do not match the saved trigger's condition",
          });
        }
      }
      return yield* beginRun(saved, subject, undefined, event);
    }
    return yield* beginRun(saved, subject);
  });

  /**
   * Starts a run when the saved workflow's entity trigger matches a change: the entity is new,
   * or a watched field changed, and the trigger's condition holds for the new version.
   */
  const notificationLock = Semaphore.makeUnsafe(1);
  const eventReceived = Effect.fn("Automation.eventReceived")(
    function* (input: unknown) {
      const event = yield* Schema.decodeUnknownEffect(Event)(input);
      const key = `event:${event.id}`;
      const receipt = yield* storage.get(key);
      if (receipt !== undefined)
        return yield* Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.NullOr(RunId) }))(
          receipt,
        );
      const id = RunId.make(`event-${event.id}`);
      // The run and its journal can commit before the receipt. Recover that window first.
      if ((yield* readRun(id)) !== undefined) return { runId: id };
      const saved = yield* readWorkflow("saved");
      const trigger = saved?.trigger;
      let runId: RunId | null = null;
      if (
        saved !== undefined &&
        trigger?.kind === "event" &&
        trigger.event === event.name &&
        (trigger.subject === undefined || event.subject?.type === trigger.subject)
      ) {
        const subject = trigger.subject === undefined ? null : (event.subject ?? null);
        const refs = conditionRefs(trigger.when ?? { all: [] });
        const values = yield* resolve(refs, { subject, event, steps: {} });
        const now = yield* Clock.currentTimeMillis;
        if (trigger.when === undefined || holds(trigger.when, (ref) => values[ref], now)) {
          runId = (yield* beginRun(saved, subject, id, event)).id;
        }
      }
      yield* storage.put(key, { runId });
      return { runId };
    },
    (effect) => notificationLock.withPermit(effect),
  );
  const entityChanged = Effect.fn("Automation.entityChanged")(
    function* (before: EntityData | undefined, after: Subject, key?: string, event?: Event) {
      const id = key === undefined ? undefined : RunId.make(`entity-${key}`);
      // Check before re-evaluating a trigger: its workflow or referenced values may have changed.
      if (id !== undefined && (yield* readRun(id)) !== undefined) return { runId: id };
      const saved = yield* readWorkflow("saved");
      const trigger = saved?.trigger;
      if (saved === undefined || trigger?.kind !== "entity" || trigger.entity !== after.type) {
        return { runId: null };
      }
      const changed = changedFields(before, after.data);
      const watched = trigger.fields ?? changed;
      if (before !== undefined && !watched.some((field) => changed.includes(field))) {
        return { runId: null };
      }
      if (trigger.when !== undefined) {
        const values = yield* resolve(conditionRefs(trigger.when), { subject: after, steps: {} });
        const now = yield* Clock.currentTimeMillis;
        if (!holds(trigger.when, (ref) => values[ref], now)) {
          return { runId: null };
        }
      }
      const origin = event === undefined ? undefined : yield* Schema.decodeEffect(Event)(event);
      const started = yield* beginRun(saved, after, id, origin);
      return { runId: started.id };
    },
    (effect) => notificationLock.withPermit(effect),
  );

  /**
   * Starts the runs an occurrence of the saved timed trigger calls for, then books the next one.
   * An occurrence that matches more entities than it may start starts none and records a failed
   * run that says so. A late tick starts its runs once and books the next occurrence after now,
   * so the runs it missed aren't started in a burst. A tick the saved schedule no longer has
   * starts nothing; a saved workflow without a timed trigger books nothing, because saving it
   * cancelled the schedule.
   */
  const tick = Effect.fn("Automation.tick")(function* ({ at }: Tick) {
    const saved = yield* readWorkflow("saved");
    const trigger = saved?.trigger;
    if (saved === undefined || trigger === undefined || !isTimed(trigger)) {
      return;
    }
    const schedule = triggerSchedule(trigger);
    if (occursAt(schedule, at)) {
      const subjects = yield* due(trigger, at);
      if (subjects.length > MAX_SCHEDULED_RUNS) {
        const id = scheduledRunId(at, null);
        if ((yield* readRun(id)) === undefined) {
          yield* recordFailedRun(id, saved, null, tooManyRuns(subjects.length));
        }
      } else {
        for (const subject of subjects) {
          const id = scheduledRunId(at, subject);
          if ((yield* readRun(id)) === undefined) {
            yield* beginRun(saved, subject, id);
          }
        }
      }
    }
    const now = yield* Clock.currentTimeMillis;
    yield* host.jobs.tick(nextOccurrence(schedule, Math.max(at, now)));
  });

  /**
   * Answers a run's open human step or permission request. `responder` is the email address of
   * whoever answers, when the studio knows it; only a role's members may answer for it.
   */
  const respond = Effect.fn("Automation.respond")(function* (
    runId: RunId,
    stepId: string,
    answer: HumanResponse,
    responder: string | undefined,
  ) {
    const run = yield* readRun(runId);
    const task = run?.tasks.find((candidate) => candidate.step === stepId);
    if (run === undefined || task === undefined || task.status !== "open") {
      return yield* new AutomationError({ message: "That task isn't waiting for an answer" });
    }
    const approvers = task.approvers;
    if (
      approvers !== undefined &&
      responder !== undefined &&
      !approvers.members.some((member) => member.email.toLowerCase() === responder.toLowerCase())
    ) {
      return yield* new AutomationError({
        message: `Only members of ${approvers.label} can answer this`,
      });
    }
    const response: HumanResponse =
      responder === undefined ? answer : { ...answer, respondedBy: responder };
    if (task.response === "approval") {
      if (response.approved === undefined) {
        return yield* new AutomationError({ message: "Approve or reject the request" });
      }
    } else {
      const values = response.values ?? {};
      const wrong = task.response.fields.filter(
        (field) => !valueMatches(field.type, values[field.name]),
      );
      if (wrong.length > 0) {
        return yield* new AutomationError({
          message: `Fill in ${wrong.map((field) => field.label).join(", ")}`,
        });
      }
    }
    const token = yield* decodeToken(task.token).pipe(Effect.orDie);
    yield* respondToHuman(token, response).pipe(provideEngine);
    yield* updateRun(runId, (current) => ({
      ...current,
      tasks: current.tasks.map((candidate): HumanTask =>
        candidate.step === stepId ? { ...candidate, status: "closed" } : candidate,
      ),
    }));
    return { ok: true };
  });

  /** A run, with its subject's title as the run list shows it. */
  const run = Effect.fn("Automation.run")(function* (id: RunId) {
    const found = yield* readRun(id);
    if (found === undefined) {
      return undefined;
    }
    const types = yield* entityTypesForTitles;
    return { ...found, subjectTitle: summary(types, found).subject };
  });

  /** What the run's agent steps asked and answered; empty before the first one. */
  const runTrace = Effect.fn("Automation.runTrace")(function* (id: RunId) {
    const found = yield* readRun(id);
    if (found === undefined) {
      return undefined;
    }
    return found.conversation === undefined ? emptyTrace : yield* pi.transcript(found.conversation);
  });

  return {
    callbacks: { advance, clock, tick },
    summaries: runSummaries,
    start,
    entityChanged,
    eventReceived,
    respond,
    run,
    runTrace,
  };
});
