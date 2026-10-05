import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { WorkflowEngine } from "effect/workflow";
import {
  RunAutomation,
  RunAutomationLive,
  StepRunner,
  respondToHuman,
  type Decision,
  type HumanRequest,
  type HumanResponse,
} from "./interpreter.ts";
import type { Step, Workflow } from "./workflow.ts";

const agent = (id: string, instruction = `Do ${id}`): Step => ({
  id,
  title: id,
  kind: "agent",
  instruction,
});

const workflow = (...steps: ReadonlyArray<Step>): Workflow => ({
  name: "Test",
  event: null,
  steps,
});

/** A fake StepRunner that records what ran and lets each test script decisions. */
const makeHarness = (decision: Decision = { choice: "a", confidence: 1, probabilities: {} }) => {
  const calls: Array<string> = [];
  const requests: Array<HumanRequest> = [];
  const runner = StepRunner.of({
    agent: (step, state) =>
      Effect.sync(() => {
        calls.push(step.id);
        return `${step.id} saw ${Object.keys(state.steps).join(",") || "nothing"}`;
      }),
    webhook: (step) => Effect.sync(() => (calls.push(step.id), `${step.id} ok`)),
    decide: (step) => Effect.sync(() => (calls.push(step.id), decision)),
    requestHuman: (request) => Effect.sync(() => void requests.push(request)),
  });
  const layer = RunAutomationLive.pipe(
    Layer.provide(Layer.succeed(StepRunner, runner)),
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.provideMerge(TestClock.layer()),
  );
  return { calls, requests, layer };
};

/** Lets forked workflow fibers run until they finish or park. */
const settle = Effect.repeat(Effect.yieldNow, { times: 100 });

const start = (steps: Workflow, input: Schema.Json = {}) =>
  Effect.gen(function* () {
    const executionId = yield* RunAutomation.execute(
      { runId: "run-1", workflow: steps, input },
      { discard: true },
    );
    yield* settle;
    return executionId;
  });

const outcome = (executionId: string) =>
  RunAutomation.poll(executionId).pipe(
    Effect.map(
      Option.match({
        onNone: () => "missing" as const,
        onSome: (result) => (result._tag === "Complete" ? result.exit : ("suspended" as const)),
      }),
    ),
  );

const finalSteps = (executionId: string) =>
  outcome(executionId).pipe(
    Effect.map((result) => {
      if (typeof result === "string" || Exit.isFailure(result)) {
        throw new Error(`Run did not complete: ${String(result)}`);
      }
      return result.value.steps;
    }),
  );

const respond = (request: HumanRequest | undefined, response: HumanResponse) =>
  Effect.gen(function* () {
    if (request === undefined) {
      throw new Error("No human request was made");
    }
    yield* respondToHuman(request.token, response);
    yield* settle;
  });

const runTest = <A, E>(
  harness: ReturnType<typeof makeHarness>,
  effect: Effect.Effect<A, E, RunAutomationServices>,
) => Effect.runPromise(effect.pipe(Effect.provide(harness.layer)));

type RunAutomationServices = WorkflowEngine.WorkflowEngine | TestClock.TestClock;

describe("RunAutomation", () => {
  test("runs a flat workflow in order, recording each output", async () => {
    const harness = makeHarness();
    const steps = await runTest(
      harness,
      Effect.flatMap(
        start(
          workflow(agent("summarize"), {
            id: "notify",
            title: "Notify",
            kind: "webhook",
            url: "https://example.com/hook",
          }),
        ),
        finalSteps,
      ),
    );
    expect(harness.calls).toEqual(["summarize", "notify"]);
    expect(steps).toEqual({
      summarize: { output: "summarize saw nothing" },
      notify: { output: "notify ok" },
    });
  });

  test("runs parallel branches and gives later steps every branch's results", async () => {
    const harness = makeHarness();
    const steps = await runTest(
      harness,
      Effect.flatMap(
        start(
          workflow(
            {
              id: "prep",
              title: "Prep",
              kind: "parallel",
              branches: [[agent("laptop")], [agent("buddy"), agent("brief-buddy")]],
            },
            agent("report"),
          ),
        ),
        finalSteps,
      ),
    );
    expect(harness.calls.toSorted()).toEqual(["brief-buddy", "buddy", "laptop", "report"]);
    expect(harness.calls.at(-1)).toBe("report");
    expect(steps["report"]).toEqual({ output: "report saw laptop,buddy,brief-buddy" });
  });

  test("an if step runs the first matching case, or otherwise", async () => {
    const triage = workflow({
      id: "triage",
      title: "Triage",
      kind: "if",
      cases: [
        { when: { ref: "input.priority", op: "equals", value: "high" }, steps: [agent("page")] },
      ],
      otherwise: [agent("queue")],
    });

    const high = makeHarness();
    const highSteps = await runTest(
      high,
      Effect.flatMap(start(triage, { priority: "high" }), finalSteps),
    );
    expect(high.calls).toEqual(["page"]);
    expect(highSteps["triage"]).toEqual({ matched: 0 });

    const low = makeHarness();
    const lowSteps = await runTest(
      low,
      Effect.flatMap(start(triage, { priority: "low" }), finalSteps),
    );
    expect(low.calls).toEqual(["queue"]);
    expect(lowSteps["triage"]).toEqual({ matched: null });
  });

  const routing = workflow({
    id: "route",
    title: "Route",
    kind: "decide",
    model: "clef-flash",
    question: "Does this need a person?",
    options: [
      { id: "auto", description: "Handle automatically", steps: [agent("reply")] },
      { id: "escalate", description: "Needs a person", steps: [agent("page")] },
    ],
  });

  test("a decide step records the decision and runs the chosen option", async () => {
    const decision = { choice: "escalate", confidence: 0.9, probabilities: { escalate: 0.9 } };
    const harness = makeHarness(decision);
    const steps = await runTest(harness, Effect.flatMap(start(routing), finalSteps));
    expect(harness.calls).toEqual(["route", "page"]);
    expect(steps["route"]).toEqual(decision);
  });

  test("a decision for an unknown option fails the run", async () => {
    const harness = makeHarness({ choice: "shrug", confidence: 1, probabilities: {} });
    const result = await runTest(harness, Effect.flatMap(start(routing), outcome));
    expect(Exit.isExit(result) && Exit.isFailure(result)).toBe(true);
    expect(harness.calls).toEqual(["route"]);
  });

  test("a wait step holds the run until the duration passes", async () => {
    const harness = makeHarness();
    await runTest(
      harness,
      Effect.gen(function* () {
        const executionId = yield* start(
          workflow(
            { id: "pause", title: "Pause", kind: "wait", duration: "3 days" },
            agent("after"),
          ),
        );
        expect(yield* outcome(executionId)).toBe("suspended");
        yield* TestClock.adjust("2 days");
        yield* settle;
        expect(harness.calls).toEqual([]);
        yield* TestClock.adjust("1 day");
        yield* settle;
        expect(harness.calls).toEqual(["after"]);
      }),
    );
  });

  test("a wait-until step waits for a date from the input, shifted by its offset", async () => {
    const harness = makeHarness();
    await runTest(
      harness,
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-01T00:00:00Z"));
        const executionId = yield* start(
          workflow(
            {
              id: "week-before",
              title: "One week out",
              kind: "wait",
              until: "input.start_date",
              offset: "-7 days",
            },
            agent("welcome"),
          ),
          { start_date: "2026-10-12T00:00:00Z" },
        );
        yield* TestClock.adjust("3 days");
        yield* settle;
        expect(yield* outcome(executionId)).toBe("suspended");
        yield* TestClock.adjust("1 day");
        yield* settle;
        expect(harness.calls).toEqual(["welcome"]);
      }),
    );
  });

  test("a human step parks the run until someone responds", async () => {
    const harness = makeHarness();
    const steps = await runTest(
      harness,
      Effect.gen(function* () {
        const executionId = yield* start(
          workflow(
            agent("draft"),
            {
              id: "approve",
              title: "Approve",
              kind: "human",
              prompt: "Approve the welcome note for {{new_hire}}?",
              assignee: "{{manager}}",
              response: "approval",
            },
            {
              id: "check",
              title: "Check",
              kind: "if",
              cases: [
                {
                  when: { ref: "steps.approve.approved", op: "equals", value: true },
                  steps: [agent("send")],
                },
              ],
            },
          ),
          { new_hire: "Ada", manager: "grace@example.com" },
        );
        expect(yield* outcome(executionId)).toBe("suspended");
        expect(harness.requests.map(({ prompt, assignee }) => ({ prompt, assignee }))).toEqual([
          { prompt: "Approve the welcome note for Ada?", assignee: "grace@example.com" },
        ]);
        yield* respond(harness.requests[0], { approved: true, respondedBy: "grace" });
        return yield* finalSteps(executionId);
      }),
    );
    expect(harness.calls).toEqual(["draft", "send"]);
    expect(steps["approve"]).toEqual({ approved: true, respondedBy: "grace", timedOut: false });
  });

  test("a human step with a timeout records that nobody answered", async () => {
    const harness = makeHarness();
    const steps = await runTest(
      harness,
      Effect.gen(function* () {
        const executionId = yield* start(
          workflow({
            id: "confirm",
            title: "Confirm",
            kind: "human",
            prompt: "Confirm the start date",
            response: { fields: [{ name: "start_date", label: "Start date", type: "date" }] },
            timeout: "2 days",
          }),
        );
        yield* TestClock.adjust("2 days");
        yield* settle;
        return yield* finalSteps(executionId);
      }),
    );
    expect(steps["confirm"]).toEqual({ timedOut: true });
  });
});
