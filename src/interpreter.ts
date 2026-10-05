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
import {
  durationMillis,
  holds,
  lookup,
  renderTemplate,
  RunState,
  Workflow,
  type AgentStep,
  type DecideStep,
  type HumanStep,
  type Step,
  type WaitUntilStep,
  type WebhookStep,
} from "./workflow.ts";

/**
 * Runs a saved workflow as one `effect/workflow` execution. The DSL is the payload: this module
 * walks its step tree and maps each kind onto a durable primitive.
 *
 * - agent, webhook, and decide steps are Activities, so a replayed run reuses their results.
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

/** What a human step asks for, handed to whatever delivers it (the studio inbox, a signed link). */
export interface HumanRequest {
  readonly token: DurableDeferred.Token;
  readonly step: HumanStep;
  readonly prompt: string;
  readonly assignee: string | undefined;
}

/** Executes the steps that reach outside the workflow. */
export class StepRunner extends Context.Service<
  StepRunner,
  {
    /** `idempotencyKey` is stable across retries and replays of the same step in the same run. */
    readonly agent: (
      step: AgentStep,
      state: RunState,
      idempotencyKey: string,
    ) => Effect.Effect<string, StepFailed>;
    readonly webhook: (
      step: WebhookStep,
      state: RunState,
      idempotencyKey: string,
    ) => Effect.Effect<string, StepFailed>;
    readonly decide: (step: DecideStep, state: RunState) => Effect.Effect<Decision, StepFailed>;
    readonly requestHuman: (request: HumanRequest) => Effect.Effect<void, StepFailed>;
  }
>()("automations/StepRunner") {}

export const RunAutomation = EffectWorkflow.make("RunAutomation", {
  payload: { runId: Schema.String, workflow: Workflow, input: Schema.Json },
  idempotencyKey: ({ runId }) => runId,
  success: RunState,
  error: StepFailed,
});

type Requirements = StepRunner | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance;

const retried = { times: 2 } as const;

const record = (state: RunState, step: Step, result: Schema.Json): RunState => ({
  ...state,
  steps: { ...state.steps, [step.id]: result },
});

const failed = (step: Step, message: string) => new StepFailed({ step: step.id, message });

const runSteps = (
  steps: ReadonlyArray<Step>,
  state: RunState,
): Effect.Effect<RunState, StepFailed, Requirements> =>
  Effect.reduce(
    steps,
    () => state,
    (current, step) => runStep(step, current),
  );

const runStep = (
  step: Step,
  state: RunState,
): Effect.Effect<RunState, StepFailed, Requirements> => {
  switch (step.kind) {
    case "agent":
    case "webhook":
      return Effect.gen(function* () {
        const runner = yield* StepRunner;
        const output = yield* Activity.make({
          name: step.id,
          success: Schema.String,
          error: StepFailed,
          execute: Effect.flatMap(Activity.idempotencyKey(step.id), (key) =>
            step.kind === "agent"
              ? runner.agent(step, state, key)
              : runner.webhook(step, state, key),
          ),
        }).pipe(Activity.retry(retried));
        return record(state, step, { output });
      });
    case "wait":
      return "until" in step
        ? waitUntil(step, state)
        : DurableClock.sleep({ name: step.id, duration: durationMillis(step.duration) }).pipe(
            Effect.as(state),
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
      );
    case "if": {
      const matched = step.cases.findIndex((branch) => holds(branch.when, state));
      const steps = step.cases[matched]?.steps ?? step.otherwise ?? [];
      return runSteps(steps, record(state, step, { matched: matched === -1 ? null : matched }));
    }
    case "decide":
      return decide(step, state);
    case "human":
      return askHuman(step, state);
  }
};

const decide = Effect.fnUntraced(function* (step: DecideStep, state: RunState) {
  const runner = yield* StepRunner;
  const decision = yield* Activity.make({
    name: step.id,
    success: Decision,
    error: StepFailed,
    execute: runner.decide(step, state),
  }).pipe(Activity.retry(retried));
  const option = step.options.find((candidate) => candidate.id === decision.choice);
  if (option === undefined) {
    return yield* failed(step, `The decision model chose an unknown option: ${decision.choice}`);
  }
  return yield* runSteps(option.steps, record(state, step, decision));
});

const waitUntil = Effect.fnUntraced(function* (step: WaitUntilStep, state: RunState) {
  const value = lookup(state, step.until);
  const date = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(date)) {
    return yield* failed(step, `${step.until} is not a date`);
  }
  const target = date + (step.offset === undefined ? 0 : durationMillis(step.offset));
  // The current time is an Activity so a replay computes the same remaining wait.
  const now = yield* Activity.make({
    name: `${step.id}.now`,
    success: Schema.Finite,
    execute: Clock.currentTimeMillis,
  });
  if (target > now) {
    yield* DurableClock.sleep({ name: step.id, duration: target - now });
  }
  return state;
});

const humanDeferred = (name: string) => DurableDeferred.make(name, { success: HumanResponse });

const askHuman = Effect.fnUntraced(function* (step: HumanStep, state: RunState) {
  const runner = yield* StepRunner;
  const deferred = humanDeferred(step.id);
  const token = yield* DurableDeferred.token(deferred);
  yield* Activity.make({
    name: `${step.id}.request`,
    error: StepFailed,
    execute: runner.requestHuman({
      token,
      step,
      prompt: renderTemplate(step.prompt, state.input),
      assignee:
        step.assignee === undefined ? undefined : renderTemplate(step.assignee, state.input),
    }),
  }).pipe(Activity.retry(retried));
  const answered = DurableDeferred.await(deferred).pipe(
    Effect.map((response) => ({ ...response, timedOut: false })),
  );
  const outcome =
    step.timeout === undefined
      ? yield* answered
      : yield* DurableDeferred.raceAll({
          name: `${step.id}.outcome`,
          success: HumanOutcome,
          error: Schema.Never,
          effects: [
            answered,
            DurableClock.sleep({
              name: `${step.id}.timeout`,
              duration: durationMillis(step.timeout),
            }).pipe(Effect.as({ timedOut: true })),
          ],
        });
  return record(state, step, outcome);
});

/** Completes a human step from the token its `HumanRequest` carried. */
export const respondToHuman = (token: DurableDeferred.Token, response: HumanResponse) =>
  DurableDeferred.succeed(
    humanDeferred(DurableDeferred.TokenParsed.fromString(token).deferredName),
    { token, value: response },
  );

export const RunAutomationLive = RunAutomation.toLayer(({ workflow, input }) =>
  runSteps(workflow.steps, { input, steps: {} }),
);
