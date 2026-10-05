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
import { Subject } from "./entities.ts";
import {
  durationMillis,
  holds,
  loneRef,
  renderTemplate,
  RunState,
  stepRefs,
  usesNow,
  Workflow,
  type ActionInput,
  type ActionStep,
  type AgentStep,
  type DecideStep,
  type HumanStep,
  type IfStep,
  type Step,
  type WaitUntilStep,
} from "./workflow.ts";

/**
 * Runs a saved workflow as one `effect/workflow` execution. The DSL is the payload: this module
 * walks its step tree and maps each kind onto a durable primitive.
 *
 * - Before a step runs, the refs it reads are resolved in an Activity, so a replay sees the same
 *   values even if an entity changed since.
 * - agent, action, and decide steps are Activities, so a replayed run reuses their results.
 * - parallel branches run concurrently and merge what they recorded.
 * - wait steps are DurableClocks.
 * - human steps park on a DurableDeferred until `respondToHuman` completes it.
 *
 * Everything outside an Activity runs again on every replay, so it must stay deterministic.
 */

export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  step: Schema.String,
  message: Schema.String,
}) {}

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
  readonly runId: string;
  readonly token: DurableDeferred.Token;
  readonly step: HumanStep;
  readonly prompt: string;
  /** The resolved assignee: usually an entity with `$title` and `email`. */
  readonly assignee: Schema.Json;
  readonly defaults: Readonly<Record<string, string>>;
}

/** Progress the interpreter reports as it goes. A replay reports finished steps again. */
export interface StepEvent {
  readonly runId: string;
  readonly step: string;
  readonly status: "running" | "waiting" | "done";
  readonly record?: Schema.Json;
}

/** Executes the steps that reach outside the workflow. */
export class StepRunner extends Context.Service<
  StepRunner,
  {
    /** Reads refs against the run state, loading entities that `ref` fields point to. */
    readonly resolve: (
      refs: ReadonlyArray<string>,
      state: RunState,
    ) => Effect.Effect<Record<string, Schema.Json>, StepFailed>;
    /** `idempotencyKey` is stable across replays of the same attempt of the step. */
    readonly agent: (
      request: { readonly step: AgentStep; readonly instruction: string; readonly state: RunState },
      idempotencyKey: string,
    ) => Effect.Effect<Schema.Json, StepFailed>;
    /** `idempotencyKey` is stable across retries and replays of the same step in the same run. */
    readonly action: (
      request: {
        readonly step: ActionStep;
        readonly inputs: Record<string, Schema.Json>;
        readonly state: RunState;
      },
      idempotencyKey: string,
    ) => Effect.Effect<Schema.Json, StepFailed>;
    readonly decide: (request: {
      readonly step: DecideStep;
      readonly question: string;
      readonly state: RunState;
    }) => Effect.Effect<Decision, StepFailed>;
    readonly requestHuman: (request: HumanRequest) => Effect.Effect<void, StepFailed>;
    readonly report: (event: StepEvent) => Effect.Effect<void>;
  }
>()("automations/StepRunner") {}

export const RunAutomation = EffectWorkflow.make("RunAutomation", {
  payload: { runId: Schema.String, workflow: Workflow, subject: Schema.NullOr(Subject) },
  idempotencyKey: ({ runId }) => runId,
  success: RunState,
  error: StepFailed,
});

type Requirements = StepRunner | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance;

const retried = { times: 2 } as const;

const failed = (step: Step, message: string) => new StepFailed({ step: step.id, message });

const report = (event: StepEvent) => StepRunner.use((runner) => runner.report(event));

const record = (state: RunState, step: Step, result: Schema.Json) =>
  report({ runId: state.runId, step: step.id, status: "done", record: result }).pipe(
    Effect.as<RunState>({ ...state, steps: { ...state.steps, [step.id]: result } }),
  );

const ResolvedValues = Schema.Record(Schema.String, Schema.Json);

/** Resolves the refs a step reads once, in an Activity, so replays reuse the values. */
const resolveRefs = (step: Step, state: RunState) => {
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
  state: RunState,
): Effect.Effect<RunState, StepFailed, Requirements> =>
  Effect.reduce(
    steps,
    () => state,
    (current, step) => runStep(step, current),
  );

const runStep = (step: Step, state: RunState): Effect.Effect<RunState, StepFailed, Requirements> =>
  Effect.andThen(
    report({ runId: state.runId, step: step.id, status: "running" }),
    Effect.flatMap(resolveRefs(step, state), (values) => runResolved(step, state, values)),
  );

const runResolved = (
  step: Step,
  state: RunState,
  values: Values,
): Effect.Effect<RunState, StepFailed, Requirements> => {
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
        const inputs = Object.fromEntries(
          Object.entries(step.with).map(([name, value]) => [name, renderInput(value, values)]),
        );
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
          finished.reduce<RunState>(
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
  }
};

const runIf = Effect.fnUntraced(function* (step: IfStep, state: RunState, values: Values) {
  const time = step.cases.some((branch) => usesNow(branch.when)) ? yield* now(step) : Number.NaN;
  const matched = step.cases.findIndex((branch) => holds(branch.when, (ref) => values[ref], time));
  const steps = step.cases[matched]?.steps ?? step.otherwise ?? [];
  return yield* runSteps(
    steps,
    yield* record(state, step, { matched: matched === -1 ? null : matched }),
  );
});

const decide = Effect.fnUntraced(function* (step: DecideStep, state: RunState, values: Values) {
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
  state: RunState,
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

const askHuman = Effect.fnUntraced(function* (step: HumanStep, state: RunState, values: Values) {
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

/** Completes a human step from the token its `HumanRequest` carried. */
export const respondToHuman = (token: DurableDeferred.Token, response: HumanResponse) =>
  DurableDeferred.succeed(
    humanDeferred(DurableDeferred.TokenParsed.fromString(token).deferredName),
    { token, value: response },
  );

export const RunAutomationLive = RunAutomation.toLayer(({ runId, workflow, subject }) =>
  runSteps(workflow.steps, { runId, subject, steps: {} }),
);
