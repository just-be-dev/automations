import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { DurableDeferred, WorkflowEngine } from "effect/workflow";
import { agentOutput, agentPrompt, decidePrompt, decision } from "../workflow/agent-step.ts";
import { AutomationIndex } from "./index.ts";
import { AutomationHost } from "./host.ts";
import { PiAgent } from "../ai/pi.ts";
import { ProgressClassifier } from "./progress-classifier.ts";
import { checkWorkflow } from "../workflow/catalog.ts";
import { runAction } from "../connections/runner.ts";
import { findOperation } from "../connections/registry.ts";
import {
  designDraft,
  fixedProgress,
  pickProgress,
  progressPhrases,
  type ProgressPhrase,
} from "./design.ts";
import { makeDurableEngine, type DurableEngine } from "../workflow/durable-engine.ts";
import {
  HumanResponse,
  respondToHuman,
  RunAutomation,
  RunStopped,
  RunAutomationLive,
  StepFailed,
  StepRunner,
  type HumanRequest,
  type PermissionRequest,
  type StepEvent,
} from "../workflow/interpreter.ts";
import { EntityStore } from "../entities/store.ts";
import {
  changedFields,
  isEmailField,
  readRef,
  type EntityData,
  type EntityType,
  type Subject,
} from "../entities/model.ts";
import { expandTemplates } from "../entities/templates.ts";
import {
  conditionRefs,
  holds,
  type Permissions,
  subjectType,
  valueMatches,
  Workflow,
} from "../workflow/model.ts";
import { Run, type HumanTask, type RunState, type RunSummary } from "../workflow/run.ts";
import { Exchange, PendingChat } from "./model.ts";

// How much more reasoning the designer writes before the classifier looks again.
const PICK_EVERY_CHARS = 300;

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String,
}) {}

// NOTE: workflows and runs written before triggers were entity-based don't decode any more. They were
// discarded on purpose, so reading one drops it instead of failing.
const decodeOrDrop =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (value: unknown) =>
    value === undefined
      ? Effect.succeed(undefined)
      : Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.map((decoded): A | undefined => decoded),
          Effect.orElseSucceed(() => undefined),
        );

// Storage holds only values this object wrote, so a decoding failure is a defect.
const StoredExchangeCount = Schema.UndefinedOr(Schema.Int);
const decodeStoredExchangeCount = (value: unknown) =>
  Schema.decodeUnknownEffect(StoredExchangeCount)(value).pipe(Effect.orDie);
const StoredPendingChat = Schema.UndefinedOr(PendingChat);
const decodeStoredPendingChat = (value: unknown) =>
  Schema.decodeUnknownEffect(StoredPendingChat)(value).pipe(Effect.orDie);
const decodeStoredExchanges = (values: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(Exchange))(values).pipe(Effect.orDie);
const StoredRunId = Schema.UndefinedOr(Schema.String);
const decodeStoredRunId = (value: unknown) =>
  Schema.decodeUnknownEffect(StoredRunId)(value).pipe(Effect.orDie);
const decodeToken = Schema.decodeUnknownEffect(DurableDeferred.Token);

const runPrefix = "run:";
const runKey = (id: string) => `${runPrefix}${id}`;
const executionKey = (executionId: string) => `execution:${executionId}`;
// Each exchange gets its own key because a single storage value is capped at 128 KiB. The padding
// keeps `list` returning them in order.
const exchangePrefix = "exchange:";
const exchangeKey = (index: number) => `${exchangePrefix}${String(index).padStart(6, "0")}`;

const failureMessage = (error: { readonly message: string }) => error.message;

const causeMessage = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause);
  return failure instanceof StepFailed
    ? `Step ${failure.step} failed: ${failure.message}`
    : Cause.pretty(cause);
};

/** Payload of the `designReply` callback: a persisted contract, so keep it compatible. */
interface DesignReply {
  readonly automationId: string;
  readonly chatId: string;
}

/**
 * Payload of the `advance` callback, which replays a run's execution: a persisted contract. Jobs
 * from before entity-based triggers carried only a `runId`; their runs were discarded.
 */
interface Advance {
  readonly executionId?: string;
}

/** Payload of the `clock` callback, which fires a durable clock: a persisted contract. */
interface ClockFired {
  readonly executionId: string;
  readonly deferredName: string;
}

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

const applyEvent = (run: Run, event: StepEvent): Run => {
  const current = run.steps[event.step];
  // A replay reports finished steps again on its way through them.
  if (current?.status === "done" && event.status !== "done") {
    return run;
  }
  const steps = {
    ...run.steps,
    [event.step]:
      event.record === undefined
        ? { status: event.status }
        : { status: event.status, record: event.record },
  };
  const tasks =
    event.status === "done"
      ? run.tasks.map((task): HumanTask =>
          task.step === event.step ? { ...task, status: "closed" } : task,
        )
      : run.tasks;
  return { ...run, steps, tasks };
};

/**
 * One automation: its draft and saved workflow, its runs, and the pi agent that designs it and
 * runs its agent steps. Runs execute `RunAutomation` on a durable engine journaled in this
 * object's storage.
 */
export const makeAutomation = Effect.fn("Automation.make")(function* () {
  const host = yield* AutomationHost;
  const storage = host.storage;
  const entities = yield* EntityStore;
  const index = yield* AutomationIndex;
  const pi = yield* PiAgent;
  const { classify } = yield* ProgressClassifier;

  const readWorkflow = (key: "draft" | "saved") =>
    storage.get(key).pipe(Effect.flatMap(decodeOrDrop(Workflow)));
  const readRun = (id: string) => storage.get(runKey(id)).pipe(Effect.flatMap(decodeOrDrop(Run)));
  const writeRun = (run: Run) => storage.put(runKey(run.id), run);

  // Steps in parallel branches report at the same time, so updates to a run take turns.
  const runLock = Semaphore.makeUnsafe(1);
  const updateRun = (id: string, update: (run: Run) => Run) =>
    runLock.withPermit(
      Effect.gen(function* () {
        const run = yield* readRun(id);
        if (run === undefined) {
          return;
        }
        const next = update(run);
        if (next !== run) {
          yield* writeRun(next);
        }
      }),
    );

  const catalog = Effect.all({
    types: entities.listTypes,
    templates: entities.listTemplates,
    roles: entities.listRoles,
  });

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

  const loadEntity = (type: string, id: string) =>
    entities
      .getEntity(type, id)
      .pipe(
        Effect.map((found): Subject | undefined =>
          found === undefined ? undefined : { type: found.type, id: found.id, data: found.data },
        ),
      );

  const resolve = (refs: ReadonlyArray<string>, known: Pick<RunState, "subject" | "steps">) =>
    Effect.gen(function* () {
      const types = yield* entities.listTypes;
      const values = yield* Effect.forEach(refs, (ref) =>
        readRef(types, known, ref, loadEntity).pipe(Effect.map((value) => [ref, value] as const)),
      );
      return Object.fromEntries(values);
    });

  // Agent steps in a run share one conversation, so later steps can build on earlier answers.
  const conversationLock = Semaphore.makeUnsafe(1);
  const conversationFor = (runId: string) =>
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
      // NOTE: Slack and email are simulated connections, so `notify` is recorded, not sent.
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
      runAction(step, inputs, known, idempotencyKey),
    decide: ({ step, question, state: known }) =>
      Effect.gen(function* () {
        const conversation = yield* conversationFor(known.runId);
        const answer = yield* pi.prompt({
          conversation,
          text: decidePrompt(step, question, known),
        });
        return yield* decision(answer);
      }).pipe(Effect.mapError(stepFailed(step.id))),
    requestHuman,
    requestPermission: (request) =>
      requestPermission(request).pipe(Effect.mapError(stepFailed(request.step.id))),
    report: (event) => updateRun(event.runId, (run) => applyEvent(run, event)),
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

  const settle = (runId: string, result: Effect.Success<ReturnType<DurableEngine["replay"]>>) =>
    updateRun(runId, (run): Run => {
      if (result === undefined) {
        return run;
      }
      if (result._tag === "Suspended") {
        return { ...run, status: "waiting" };
      }
      // A run that ended answers no more tasks, such as those in branches a stop step cut off.
      const ended = {
        ...run,
        tasks: run.tasks.map((task): HumanTask => ({ ...task, status: "closed" })),
      };
      if (Exit.isSuccess(result.exit)) {
        return { ...ended, status: "completed" };
      }
      const failure = Cause.squash(result.exit.cause);
      return failure instanceof RunStopped
        ? { ...ended, status: "stopped", stopReason: failure.reason }
        : { ...ended, status: "failed", error: causeMessage(result.exit.cause) };
    });

  // Delivery is at least once, and a replay only reruns what the journal lacks: Activities
  // that finished keep their results. An action interrupted by eviction runs again with the
  // same idempotency key.
  const advance = Effect.fn("Automation.advance")(function* ({ executionId }: Advance) {
    if (executionId === undefined) {
      return;
    }
    const runId = yield* storage
      .get(executionKey(executionId))
      .pipe(Effect.flatMap(decodeStoredRunId));
    // A run that was discarded leaves its journal behind; there's nothing to resume.
    if (runId === undefined || (yield* readRun(runId)) === undefined) {
      return;
    }
    yield* updateRun(runId, (run) =>
      run.status === "waiting" ? { ...run, status: "running" } : run,
    );
    const result = yield* durable.replay(RunAutomation, executionId);
    yield* settle(runId, result);
  });

  const clock = Effect.fn("Automation.clock")(function* ({
    executionId,
    deferredName,
  }: ClockFired) {
    yield* durable.fireClock(RunAutomation, executionId, deferredName);
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
  ) {
    const id = crypto.randomUUID();
    const startedAt = yield* Clock.currentTimeMillis;
    const current = yield* catalog;
    const prepared = yield* checkWorkflow(current, saved).pipe(
      Effect.flatMap((checked) => expandTemplates(checked, current.templates)),
      Effect.result,
    );
    if (Result.isFailure(prepared)) {
      const run: Run = {
        id,
        workflow: saved,
        subject,
        status: "failed",
        steps: {},
        tasks: [],
        error: `The saved workflow no longer fits the entity types and templates. Update it and save again.\n${prepared.failure.message}`,
        startedAt,
      };
      yield* writeRun(run);
      return { id, status: run.status };
    }
    const workflow = prepared.success;
    const payload = { runId: id, workflow, subject };
    const executionId = yield* RunAutomation.executionId(payload);
    const run: Run = {
      id,
      workflow,
      subject,
      status: "running",
      steps: {},
      tasks: [],
      startedAt,
    };
    yield* storage
      .transaction(
        Effect.gen(function* () {
          yield* writeRun(run);
          yield* storage.put(executionKey(executionId), id);
          yield* RunAutomation.execute(payload, { discard: true }).pipe(provideEngine);
        }),
      )
      .pipe(Effect.orDie);
    return { id, status: run.status };
  });

  const readConversation = storage
    .list({ prefix: exchangePrefix })
    .pipe(Effect.flatMap((entries) => decodeStoredExchanges([...entries.values()])));

  const readPendingChat = storage.get("pendingChat").pipe(Effect.flatMap(decodeStoredPendingChat));

  /** Every run, newest first. */
  const runSummaries = Effect.gen(function* () {
    const entries = yield* storage.list({ prefix: runPrefix });
    const runs = yield* Effect.forEach([...entries.values()], decodeOrDrop(Run));
    // The titles only label the list, so a D1 failure shows IDs instead.
    const types = yield* entities.listTypes.pipe(Effect.orElseSucceed(() => []));
    return runs
      .filter((run): run is Run => run !== undefined)
      .toSorted((left, right) => right.startedAt - left.startedAt)
      .map((run) => summary(types, run));
  });

  const listRuns = runSummaries.pipe(Effect.map((runs) => runs.slice(0, 20)));

  const inspectWorkflow = Effect.fn("Automation.inspectWorkflow")(function* () {
    const draft = yield* readWorkflow("draft");
    const saved = yield* readWorkflow("saved");
    const conversation = yield* readConversation;
    const pendingChat = yield* readPendingChat;
    const runs = yield* listRuns;
    const progress =
      pendingChat?.status === "working" ? yield* readProgress(pendingChat.id) : undefined;
    return { draft, saved, conversation, pendingChat, runs, progress };
  });

  /**
   * What the studio's overview shows: the saved trigger, every run still in flight however old,
   * and the latest run.
   */
  const overview = Effect.fn("Automation.overview")(function* () {
    const saved = yield* readWorkflow("saved");
    const runs = yield* runSummaries;
    return {
      ...(saved === undefined ? {} : { saved: { trigger: saved.trigger } }),
      activeRuns: runs.filter((run) => run.status === "running" || run.status === "waiting"),
      ...(runs[0] === undefined ? {} : { lastRun: runs[0] }),
    };
  });

  // Progress is a hint that only matters while this instance answers, so it stays in memory.
  const progress = yield* Ref.make<
    { readonly chatId: string; readonly phrase: ProgressPhrase } | undefined
  >(undefined);

  // Polls the designer's answer while it works. The classifier only runs once the reasoning has
  // grown, and one call at a time, however many tabs are watching. Between attempts, and when the
  // classifier fails or isn't sure, the last phrase stays.
  const trackProgress = Effect.fn("Automation.trackProgress")(function* (chatId: string) {
    const pickedAt = yield* Ref.make(0);
    const update = Effect.gen(function* () {
      const answer = yield* pi.liveAnswer;
      if (answer === undefined) {
        return;
      }
      const fixed = fixedProgress(answer);
      if (fixed !== undefined) {
        return yield* Ref.set(progress, { chatId, phrase: fixed });
      }
      if (answer.thinking.length - (yield* Ref.get(pickedAt)) < PICK_EVERY_CHARS) {
        return;
      }
      yield* Ref.set(pickedAt, answer.thinking.length);
      const phrase = yield* pickProgress(classify, answer.thinking);
      yield* Ref.set(progress, { chatId, phrase });
    }).pipe(Effect.ignore({ log: "Debug", message: "Progress update failed" }));
    yield* update.pipe(Effect.repeat(Schedule.spaced("2 seconds")));
    return yield* Effect.never;
  });

  const readProgress = (chatId: string) =>
    Ref.get(progress).pipe(
      Effect.map(
        (current) => progressPhrases[current?.chatId === chatId ? current.phrase : "reading"],
      ),
    );

  const isWorking = (pending: PendingChat | undefined, chatId: string) =>
    pending?.id === chatId && pending.status === "working";

  // Delivery is at least once. A redelivered reply reuses the pi request IDs, so the agent answers
  // each message (and its one retry) once, and only the delivery that still finds the message
  // pending writes it.
  const designReply = Effect.fn("Automation.designReply")(function* ({
    automationId,
    chatId,
  }: DesignReply) {
    const pending = yield* readPendingChat;
    if (pending === undefined || !isWorking(pending, chatId)) {
      return;
    }
    const draft = yield* readWorkflow("draft");
    const permissions = draft?.permissions ?? {};
    const reply = yield* catalog.pipe(
      Effect.flatMap((current) => designDraft(pi, current, permissions, chatId, pending.prompt)),
      Effect.result,
      Effect.raceFirst(trackProgress(chatId)),
    );
    const wrote = yield* storage
      .transaction(
        Effect.gen(function* () {
          if (!isWorking(yield* readPendingChat, chatId)) {
            return false;
          }
          if (Result.isFailure(reply)) {
            const failed: PendingChat = {
              id: chatId,
              prompt: pending.prompt,
              status: "failed",
              error: failureMessage(reply.failure),
            };
            yield* storage.put("pendingChat", failed);
            return false;
          }
          // The designer may leave out permissions it isn't changing.
          const previous = yield* readWorkflow("draft");
          const designed: Workflow = {
            ...reply.success.workflow,
            permissions: { ...previous?.permissions, ...reply.success.workflow.permissions },
          };
          const exchangeCount =
            (yield* storage.get("exchangeCount").pipe(Effect.flatMap(decodeStoredExchangeCount))) ??
            0;
          yield* storage.put("draft", designed);
          yield* storage.put(exchangeKey(exchangeCount), {
            prompt: pending.prompt,
            reply: reply.success.reply,
          });
          yield* storage.put("exchangeCount", exchangeCount + 1);
          yield* storage.delete("pendingChat");
          return true;
        }),
      )
      .pipe(Effect.orDie);
    if (wrote && Result.isSuccess(reply)) {
      // The index only feeds the studio's list, so a failure to update it must not fail the reply.
      yield* index.record(automationId, reply.success.workflow.name).pipe(Effect.ignore);
    }
  });

  const chat = Effect.fn("Automation.chat")(function* (automationId: string, message: string) {
    if (!message.trim() || message.length > 10_000) {
      return yield* new AutomationError({ message: "Message must be 1–10,000 characters" });
    }
    const pending: PendingChat = {
      id: crypto.randomUUID(),
      prompt: message,
      status: "working",
    };
    const accepted = yield* storage
      .transaction(
        Effect.gen(function* () {
          if ((yield* readPendingChat)?.status === "working") {
            return false;
          }
          yield* storage.put("pendingChat", pending);
          yield* host.jobs.designReply(automationId, pending.id);
          return true;
        }),
      )
      .pipe(Effect.orDie);
    if (!accepted) {
      return yield* new AutomationError({
        message: "The agent is still answering the previous message",
      });
    }
    return { pendingChat: pending };
  });

  /** Saves the draft once it checks against the current entity types and templates. */
  const save = Effect.fn("Automation.save")(function* () {
    const draft = yield* readWorkflow("draft");
    if (draft === undefined) {
      return yield* new AutomationError({ message: "No draft to save" });
    }
    yield* checkWorkflow(yield* catalog, draft);
    yield* storage.put("saved", draft);
    return { saved: draft };
  });

  /**
   * Sets whether operations run on their own or ask first, over what the designer suggested.
   * Saving applies them.
   */
  const setPermissions = Effect.fn("Automation.setPermissions")(function* (
    permissions: Permissions,
  ) {
    const unknown = Object.keys(permissions).filter((id) => findOperation(id) === undefined);
    if (unknown.length > 0) {
      return yield* new AutomationError({
        message: `Unknown operations: ${unknown.join(", ")}`,
      });
    }
    const roles = yield* entities.listRoles;
    const unknownRoles = Object.values(permissions).flatMap((permission) =>
      permission === "auto" || roles.some((role) => role.name === permission.ask)
        ? []
        : [permission.ask],
    );
    if (unknownRoles.length > 0) {
      return yield* new AutomationError({ message: `No role ${unknownRoles.join(", ")}` });
    }
    return yield* storage
      .transaction(
        Effect.gen(function* () {
          const current = yield* readWorkflow("draft");
          if (current === undefined) {
            return yield* new AutomationError({ message: "No draft to set permissions on" });
          }
          const draft: Workflow = {
            ...current,
            permissions: { ...current.permissions, ...permissions },
          };
          yield* storage.put("draft", draft);
          return { draft };
        }),
      )
      .pipe(Effect.catchTag("AutomationStorageError", Effect.die));
  });

  /** Starts the saved workflow by hand, for the entity `subjectId` names when it has a subject. */
  const start = Effect.fn("Automation.start")(function* (subjectId: string | undefined) {
    const saved = yield* readWorkflow("saved");
    if (saved === undefined) {
      return yield* new AutomationError({ message: "Save the workflow before starting it" });
    }
    const type = subjectType(saved.trigger);
    if (type === undefined) {
      return yield* beginRun(saved, null);
    }
    if (subjectId === undefined) {
      return yield* new AutomationError({ message: `Pick the ${type} this run is about` });
    }
    const subject = yield* loadEntity(type, subjectId);
    if (subject === undefined) {
      return yield* new AutomationError({ message: `No ${type} ${subjectId}` });
    }
    return yield* beginRun(saved, subject);
  });

  /**
   * Starts a run when the saved workflow's entity trigger matches a change: the entity is new,
   * or a watched field changed, and the trigger's condition holds for the new version.
   */
  const entityChanged = Effect.fn("Automation.entityChanged")(function* (
    before: EntityData | undefined,
    after: Subject,
  ) {
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
    const started = yield* beginRun(saved, after);
    return { runId: started.id };
  });

  /** Answers a run's open human step. */
  /**
   * Answers a run's open human step or permission request. `responder` is the email address of
   * whoever answers, when the studio knows it; only a role's members may answer for it.
   */
  const respond = Effect.fn("Automation.respond")(function* (
    runId: string,
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
  const run = Effect.fn("Automation.run")(function* (id: string) {
    const found = yield* readRun(id);
    if (found === undefined) {
      return undefined;
    }
    // The title only labels the run, so a D1 failure shows the subject's ID instead.
    const types = yield* entities.listTypes.pipe(Effect.orElseSucceed(() => []));
    return { ...found, subjectTitle: summary(types, found).subject };
  });

  return {
    callbacks: { advance, clock, designReply },
    inspectWorkflow,
    overview,
    chat,
    save,
    setPermissions,
    start,
    entityChanged,
    respond,
    run,
  };
});

/** Public operations shared by the local application and a remote automation client. */
export type AutomationApplication = Omit<
  Effect.Success<ReturnType<typeof makeAutomation>>,
  "callbacks"
>;
