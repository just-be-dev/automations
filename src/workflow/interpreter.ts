/** Walks a saved workflow with durable activities, clocks, and human responses; StepRunner owns outside effects. */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Activity,
  DurableClock,
  DurableDeferred,
  Workflow as EffectWorkflow,
  type WorkflowEngine,
} from "effect/workflow";
import { permissionOf } from "../connections/registry.ts";
import { Subject } from "../entities/model.ts";
import {
  actionTemplates,
  durationMillis,
  holds,
  loneRef,
  patternCondition,
  renderTemplate,
  stepNeeds,
  stepRefs,
  usesNow,
  Workflow,
  type ActionInput,
  type ActionStep,
  type AgentStep,
  type DecideStep,
  type HumanStep,
  type IfStep,
  type Permission,
  type Step,
  type WaitUntilStep,
} from "./model.ts";
import { RunId, type RunStep } from "./run.ts";
import { ExecutionValues } from "./execution.ts";

/**
 * Runs a saved workflow as one `effect/workflow` execution. The DSL is the payload: this module
 * walks its step tree and maps each kind onto a durable primitive.
 *
 * - Before a step runs, the refs it reads are resolved in an Activity, so a replay sees the same
 *   values even if an entity changed since.
 * - agent, action, and decide steps are Activities, so a replayed run reuses their results. An
 *   action's match picks its case from the resolved values, before its Activity. Templates are
 *   expanded before a run starts (`expandTemplates`), so an action that still uses one fails.
 * - An action whose operation the workflow's permissions set to ask first parks on a
 *   DurableDeferred until a member of the role approves or declines it with `respondToHuman`. A
 *   declined action records nothing.
 * - A step that needs a value from a step that didn't run (see `stepNeeds`) is skipped, and
 *   records nothing either, so the steps that need it are skipped in turn.
 * - parallel branches run concurrently and merge what they recorded.
 * - wait steps are DurableClocks.
 * - human steps park on a DurableDeferred until `respondToHuman` completes it.
 * - A stop step fails the execution with `RunStopped`, which interrupts every branch.
 *
 * Everything outside an Activity runs again on every replay, so it must stay deterministic.
 */

export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  step: Schema.String,
  message: Schema.String,
}) {}

/** A stop step ended the run. */
export class RunStopped extends Schema.TaggedError<RunStopped>()("RunStopped", {
  step: Schema.String,
  reason: Schema.String,
}) {}

type RunError = StepFailed | RunStopped;

export const Decision = Schema.Struct({
  choice: Schema.String,
  confidence: Schema.Finite,
  probabilities: Schema.Record(Schema.String, Schema.Finite),
});
export interface Decision extends Schema.Schema.Type<typeof Decision> {}

export const HumanResponse = Schema.Struct({
  approved: Schema.optionalKey(Schema.Boolean),
  values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  respondedBy: Schema.optionalKey(Schema.String),
});
export interface HumanResponse extends Schema.Schema.Type<typeof HumanResponse> {}

const HumanOutcome = Schema.Struct({ ...HumanResponse.fields, timedOut: Schema.Boolean });

/** Resolved ref values for one step, keyed by ref. */
export type Values = Readonly<Record<string, Schema.Json>>;

/** What a human step asks for, handed to whatever delivers it (the studio inbox, Slack). */
export interface HumanRequest {
  readonly runId: RunId;
  readonly token: DurableDeferred.Token;
  readonly step: HumanStep;
  readonly prompt: string;
  /** The resolved assignee: usually an entity with `$title` and `email`. */
  readonly assignee: Schema.Json;
  readonly defaults: Readonly<Record<string, string>>;
}

/** Asks a role's members whether an action step may perform its operation with these inputs. */
export interface PermissionRequest {
  readonly runId: RunId;
  readonly token: DurableDeferred.Token;
  readonly step: ActionStep;
  /** The role whose members approve it. */
  readonly role: string;
  /** The step's title with its templates filled in. */
  readonly title: string;
  readonly inputs: Readonly<Record<string, Schema.Json>>;
}

/** Progress the interpreter reports as it goes. A replay reports finished steps again. */
export interface StepEvent {
  readonly runId: RunId;
  readonly step: string;
  readonly status: RunStep["status"];
  readonly record?: Schema.Json;
}

/** Executes the steps that reach outside the workflow. */
export class StepRunner extends Context.Service<
  StepRunner,
  {
    /** Reads refs against execution values, loading entities that `ref` fields point to. */
    readonly resolve: (
      refs: ReadonlyArray<string>,
      state: ExecutionValues,
    ) => Effect.Effect<Record<string, Schema.Json>, StepFailed>;
    /** `idempotencyKey` is stable across replays of the same attempt of the step. */
    readonly agent: (
      request: {
        readonly step: AgentStep;
        readonly instruction: string;
        readonly state: ExecutionValues;
      },
      idempotencyKey: string,
    ) => Effect.Effect<Schema.Json, StepFailed>;
    /** `idempotencyKey` is stable across retries and replays of the same step in the same run. */
    readonly action: (
      request: {
        readonly step: ActionStep;
        readonly inputs: Record<string, Schema.Json>;
        readonly state: ExecutionValues;
      },
      idempotencyKey: string,
    ) => Effect.Effect<Schema.Json, StepFailed>;
    readonly decide: (request: {
      readonly step: DecideStep;
      readonly question: string;
      readonly state: ExecutionValues;
    }) => Effect.Effect<Decision, StepFailed>;
    readonly requestHuman: (request: HumanRequest) => Effect.Effect<void, StepFailed>;
    readonly requestPermission: (request: PermissionRequest) => Effect.Effect<void, StepFailed>;
    readonly report: (event: StepEvent) => Effect.Effect<void>;
  }
>()("automations/StepRunner") {}

export const RunAutomation = EffectWorkflow.make("RunAutomation", {
  payload: { runId: RunId, workflow: Workflow, subject: Schema.NullOr(Subject) },
  idempotencyKey: ({ runId }) => runId,
  success: ExecutionValues,
  error: Schema.Union([StepFailed, RunStopped]),
});

/** The permissions of the workflow a run executes. */
class RunPermissions extends Context.Service<
  RunPermissions,
  { readonly of: (operationId: string) => Permission | undefined }
>()("automations/RunPermissions") {}

type Requirements =
  | StepRunner
  | RunPermissions
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance;

const retried = { times: 2 } as const;

const failed = (step: Step, message: string) => new StepFailed({ step: step.id, message });

const report = (event: StepEvent) => StepRunner.use((runner) => runner.report(event));

const record = (state: ExecutionValues, step: Step, result: Schema.Json) =>
  report({ runId: state.runId, step: step.id, status: "done", record: result }).pipe(
    Effect.as<ExecutionValues>({ ...state, steps: { ...state.steps, [step.id]: result } }),
  );

const ResolvedValues = Schema.Record(Schema.String, Schema.Json);

/** Resolves the refs a step reads once, in an Activity, so replays reuse the values. */
const resolveRefs = (step: Step, state: ExecutionValues) => {
  const refs = stepRefs(step);
  if (refs.length === 0) {
    return Effect.succeed<Values>({});
  }
  return StepRunner.use((runner) =>
    Activity.make({
      name: `${step.id}/refs`,
      success: ResolvedValues,
      error: StepFailed,
      execute: runner.resolve(refs, state),
    }).pipe(Activity.retry(retried)),
  );
};

/** The current time, read once per step so a replay computes the same thing. */
const now = (step: Step) =>
  Activity.make({
    name: `${step.id}/now`,
    success: Schema.Finite,
    execute: Clock.currentTimeMillis,
  });

/** A lone `{{ref}}` passes its value through; anything else renders to text. */
export const renderInput = (value: ActionInput, values: Values): Schema.Json => {
  const one = (text: string): Schema.Json => {
    const ref = loneRef(text);
    return ref === undefined ? renderTemplate(text, values) : (values[ref] ?? null);
  };
  return typeof value === "string" ? one(value) : value.map(one);
};

const runSteps = (
  steps: ReadonlyArray<Step>,
  state: ExecutionValues,
): Effect.Effect<ExecutionValues, RunError, Requirements> =>
  Effect.reduce(
    steps,
    () => state,
    (current, step) => runStep(step, current),
  );

const runStep = (
  step: Step,
  state: ExecutionValues,
): Effect.Effect<ExecutionValues, RunError, Requirements> =>
  stepNeeds(step).some((id) => !Object.hasOwn(state.steps, id))
    ? report({ runId: state.runId, step: step.id, status: "skipped" }).pipe(Effect.as(state))
    : Effect.andThen(
        report({ runId: state.runId, step: step.id, status: "running" }),
        Effect.flatMap(resolveRefs(step, state), (values) => runResolved(step, state, values)),
      );

const runResolved = (
  step: Step,
  state: ExecutionValues,
  values: Values,
): Effect.Effect<ExecutionValues, RunError, Requirements> => {
  switch (step.kind) {
    case "agent":
      return Effect.gen(function* () {
        const runner = yield* StepRunner;
        const output = yield* Activity.make({
          name: step.id,
          success: Schema.Json,
          error: StepFailed,
          // Each attempt gets its own key, so a retry asks the agent again instead of waiting on
          // the failed submission.
          execute: Effect.flatMap(
            Activity.idempotencyKey(step.id, { includeAttempt: true }),
            (key) =>
              runner.agent(
                { step, instruction: renderTemplate(step.instruction, values), state },
                key,
              ),
          ),
        }).pipe(Activity.retry(retried));
        return yield* record(state, step, { output });
      });
    case "action":
      return Effect.gen(function* () {
        const runner = yield* StepRunner;
        if (actionTemplates(step).length > 0) {
          return yield* failed(step, "Its templates weren't expanded before the run started");
        }
        const source = yield* matchedSource(step, values);
        const inputs = Object.fromEntries(
          Object.entries({ ...step.with, ...source?.with }).map(([name, value]) => [
            name,
            renderInput(value, values),
          ]),
        );
        const permission = (yield* RunPermissions).of(step.use);
        if (permission === undefined) {
          return yield* failed(step, `The workflow sets no permission for ${step.use}`);
        }
        if (
          permission !== "auto" &&
          !(yield* askPermission(
            step,
            state,
            permission.ask,
            renderTemplate(step.title, values),
            inputs,
          ))
        ) {
          return state;
        }
        const output = yield* Activity.make({
          name: step.id,
          success: Schema.Json,
          error: StepFailed,
          execute: Effect.flatMap(Activity.idempotencyKey(step.id), (key) =>
            runner.action({ step, inputs, state }, key),
          ),
        }).pipe(Activity.retry(retried));
        return yield* record(state, step, output);
      });
    case "wait":
      return "until" in step
        ? waitUntil(step, state, values)
        : report({ runId: state.runId, step: step.id, status: "waiting" }).pipe(
            Effect.andThen(
              DurableClock.sleep({ name: step.id, duration: durationMillis(step.duration) }),
            ),
            Effect.andThen(record(state, step, null)),
          );
    case "parallel":
      return Effect.forEach(step.branches, (branch) => runSteps(branch, state), {
        concurrency: "unbounded",
      }).pipe(
        Effect.map((finished) =>
          finished.reduce<ExecutionValues>(
            (merged, branch) => ({ ...merged, steps: { ...merged.steps, ...branch.steps } }),
            state,
          ),
        ),
        Effect.tap(() =>
          report({ runId: state.runId, step: step.id, status: "done", record: null }),
        ),
      );
    case "if":
      return runIf(step, state, values);
    case "decide":
      return decide(step, state, values);
    case "human":
      return askHuman(step, state, values);
    case "stop": {
      const reason = renderTemplate(step.reason, values);
      return record(state, step, { reason }).pipe(
        Effect.andThen(Effect.fail(new RunStopped({ step: step.id, reason }))),
      );
    }
  }
};

/** The inputs a match supplies: its first case whose pattern fits, else `otherwise`. */
const matchedSource = Effect.fnUntraced(function* (step: ActionStep, values: Values) {
  const match = step.match;
  if (match === undefined) {
    return undefined;
  }
  const conditions = match.cases.map((branch) => patternCondition(match.on, branch.when));
  const time = conditions.some(usesNow) ? yield* now(step) : Number.NaN;
  const matched = conditions.findIndex((condition) => holds(condition, (ref) => values[ref], time));
  return match.cases[matched] ?? match.otherwise;
});

const runIf = Effect.fnUntraced(function* (step: IfStep, state: ExecutionValues, values: Values) {
  const time = step.cases.some((branch) => usesNow(branch.when)) ? yield* now(step) : Number.NaN;
  const matched = step.cases.findIndex((branch) => holds(branch.when, (ref) => values[ref], time));
  const steps = step.cases[matched]?.steps ?? step.otherwise ?? [];
  return yield* runSteps(
    steps,
    yield* record(state, step, { matched: matched === -1 ? null : matched }),
  );
});

const decide = Effect.fnUntraced(function* (
  step: DecideStep,
  state: ExecutionValues,
  values: Values,
) {
  const runner = yield* StepRunner;
  const decision = yield* Activity.make({
    name: step.id,
    success: Decision,
    error: StepFailed,
    execute: runner.decide({ step, question: renderTemplate(step.question, values), state }),
  }).pipe(Activity.retry(retried));
  const option = step.options.find((candidate) => candidate.id === decision.choice);
  if (option === undefined) {
    return yield* failed(step, `The decision model chose an unknown option: ${decision.choice}`);
  }
  return yield* runSteps(option.steps, yield* record(state, step, decision));
});

const waitUntil = Effect.fnUntraced(function* (
  step: WaitUntilStep,
  state: ExecutionValues,
  values: Values,
) {
  const value = values[step.until];
  const date = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(date)) {
    return yield* failed(step, `${step.until} is not a date`);
  }
  const target = date + (step.offset === undefined ? 0 : durationMillis(step.offset));
  const current = yield* now(step);
  if (target > current) {
    yield* report({ runId: state.runId, step: step.id, status: "waiting" });
    yield* DurableClock.sleep({ name: step.id, duration: target - current });
  }
  return yield* record(state, step, null);
});

const humanDeferred = (name: string) => DurableDeferred.make(name, { success: HumanResponse });

const fieldDefaults = (step: HumanStep, values: Values): Record<string, string> =>
  step.response === "approval"
    ? {}
    : Object.fromEntries(
        step.response.fields.flatMap((field) =>
          field.default === undefined ? [] : [[field.name, renderTemplate(field.default, values)]],
        ),
      );

const askHuman = Effect.fnUntraced(function* (
  step: HumanStep,
  state: ExecutionValues,
  values: Values,
) {
  const runner = yield* StepRunner;
  const deferred = humanDeferred(step.id);
  const token = yield* DurableDeferred.token(deferred);
  const defaults = fieldDefaults(step, values);
  yield* Activity.make({
    name: `${step.id}/request`,
    error: StepFailed,
    execute: runner.requestHuman({
      runId: state.runId,
      token,
      step,
      prompt: renderTemplate(step.prompt, values),
      assignee: step.assignee === undefined ? null : (values[step.assignee] ?? null),
      defaults,
    }),
  }).pipe(Activity.retry(retried));
  yield* report({ runId: state.runId, step: step.id, status: "waiting" });
  const answered = DurableDeferred.await(deferred).pipe(
    Effect.map((response) => ({ ...response, timedOut: false })),
  );
  const outcome =
    step.timeout === undefined
      ? yield* answered
      : yield* DurableDeferred.raceAll({
          name: `${step.id}/outcome`,
          success: HumanOutcome,
          error: Schema.Never,
          effects: [
            answered,
            DurableClock.sleep({
              name: `${step.id}/timeout`,
              duration: durationMillis(step.timeout),
              // Nobody answered, so a form keeps the answers it was prefilled with.
            }).pipe(
              Effect.as<typeof HumanOutcome.Type>(
                Object.keys(defaults).length === 0
                  ? { timedOut: true }
                  : { timedOut: true, values: defaults },
              ),
            ),
          ],
        });
  return yield* record(state, step, outcome);
});

/** Waits for the person to approve or decline an action, and says whether they approved it. */
const askPermission = Effect.fnUntraced(function* (
  step: ActionStep,
  state: ExecutionValues,
  role: string,
  title: string,
  inputs: Record<string, Schema.Json>,
) {
  const runner = yield* StepRunner;
  const deferred = humanDeferred(`${step.id}/approval`);
  const token = yield* DurableDeferred.token(deferred);
  yield* Activity.make({
    name: `${step.id}/approval-request`,
    error: StepFailed,
    execute: runner.requestPermission({ runId: state.runId, token, step, role, title, inputs }),
  }).pipe(Activity.retry(retried));
  yield* report({ runId: state.runId, step: step.id, status: "waiting" });
  const { approved } = yield* DurableDeferred.await(deferred);
  yield* report({ runId: state.runId, step: step.id, status: approved ? "running" : "declined" });
  return approved === true;
});

/** Completes a human step, or a permission request, from the token its request carried. */
export const respondToHuman = (token: DurableDeferred.Token, response: HumanResponse) =>
  DurableDeferred.succeed(
    humanDeferred(DurableDeferred.TokenParsed.fromString(token).deferredName),
    { token, value: response },
  );

export const RunAutomationLive = RunAutomation.toLayer(({ runId, workflow, subject }) =>
  runSteps(workflow.steps, { runId, subject, steps: {} }).pipe(
    Effect.provideService(RunPermissions, {
      of: (operationId) => permissionOf(workflow, operationId),
    }),
  ),
);
