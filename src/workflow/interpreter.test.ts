import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { WorkflowEngine } from "effect/workflow";
import { makeDurableEngine, type EngineStore } from "./durable-engine.ts";
import {
  RunAutomation,
  RunAutomationLive,
  RunStopped,
  StepRunner,
  respondToHuman,
  type Decision,
  type HumanRequest,
  type HumanResponse,
  type PermissionRequest,
  type StepEvent,
} from "./interpreter.ts";
import { readJsonPath, type Subject } from "../entities/model.ts";
import type { ActionStep, Step, Workflow } from "./model.ts";
import { RunId } from "./run.ts";
import type { ExecutionId, ExecutionValues } from "./execution.ts";

const agent = (id: string, instruction = `Do ${id}`): Step => ({
  id,
  title: id,
  kind: "agent",
  instruction,
});

const workflow = (...steps: ReadonlyArray<Step>): Workflow => ({
  name: "Test",
  trigger: { kind: "entity", entity: "employee" },
  steps,
});

/** A workflow whose actions run without asking. */
const automatic = (...steps: ReadonlyArray<Step>): Workflow => ({
  ...workflow(...steps),
  permissions: { "slack.sendMessage": "auto", "calendar.createEvent": "auto" },
});

const ada: Subject = {
  type: "employee",
  id: "ada",
  data: { name: "Ada", manager: "grace", start_date: "2026-10-12", priority: "high" },
};

/** Resolves refs the simple way: the subject's own fields and step records, no `ref` fields. */
const readRef = (state: ExecutionValues, ref: string): Schema.Json => {
  const [root, ...path] = ref.split(".");
  return root === "steps"
    ? readJsonPath(state.steps, path)
    : readJsonPath(state.subject?.data ?? null, path);
};

/**
 * A durable engine over an in-memory store, plus a fake StepRunner. Values are structured-cloned
 * on the way in and out, like Durable Object storage. `drain` plays the host: it fires due clocks
 * and replays woken executions until nothing is left to do.
 */
const makeHarness = (decision: Decision = { choice: "a", confidence: 1, probabilities: {} }) => {
  const calls: Array<string> = [];
  const requests: Array<HumanRequest> = [];
  const permissionRequests: Array<PermissionRequest> = [];
  const events: Array<StepEvent> = [];
  const data = new Map<string, unknown>();
  const woken = new Set<ExecutionId>();
  const clocks: Array<{ executionId: ExecutionId; deferredName: string; at: number }> = [];
  const store: EngineStore = {
    get: (key) => Effect.sync(() => structuredClone(data.get(key))),
    put: (key, value) => Effect.sync(() => void data.set(key, structuredClone(value))),
    wake: (executionId) => Effect.sync(() => void woken.add(executionId)),
    wakeAt: (clock) => Effect.sync(() => void clocks.push(clock)),
  };
  const durable = makeDurableEngine(store);
  const runner = StepRunner.of({
    resolve: (refs, state) =>
      Effect.succeed(Object.fromEntries(refs.map((ref) => [ref, readRef(state, ref)]))),
    agent: ({ step, instruction, state }) =>
      Effect.sync(() => {
        calls.push(step.id);
        return `${instruction} after ${Object.keys(state.steps).join(",") || "nothing"}`;
      }),
    action: ({ step, inputs }) => Effect.sync(() => (calls.push(step.id), { sent: inputs })),
    decide: ({ step }) => Effect.sync(() => (calls.push(step.id), decision)),
    requestHuman: (request) => Effect.sync(() => void requests.push(request)),
    requestPermission: (request) => Effect.sync(() => void permissionRequests.push(request)),
    report: (event) => Effect.sync(() => void events.push(event)),
  });
  const layer = RunAutomationLive.pipe(
    Layer.provide(Layer.succeed(StepRunner, runner)),
    Layer.provideMerge(Layer.succeed(WorkflowEngine.WorkflowEngine, durable.engine)),
    Layer.provideMerge(TestClock.layer()),
  );
  const drain = Effect.gen(function* () {
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      const due = clocks.filter((clock) => clock.at <= now);
      for (const clock of due) {
        clocks.splice(clocks.indexOf(clock), 1);
        yield* durable.fireClock(RunAutomation, clock.executionId, clock.deferredName);
      }
      const [next] = woken;
      if (next === undefined) {
        return;
      }
      woken.delete(next);
      yield* durable.replay(RunAutomation, next);
    }
  });
  return { calls, requests, permissionRequests, events, layer, drain, data };
};

type Harness = ReturnType<typeof makeHarness>;

const start = (harness: Harness, steps: Workflow, subject: Subject | null = ada) =>
  Effect.gen(function* () {
    const executionId = yield* RunAutomation.execute(
      { runId: RunId.make("run-1"), workflow: steps, subject },
      { discard: true },
    );
    yield* harness.drain;
    return executionId;
  });

const outcome = (executionId: string) =>
  RunAutomation.poll(executionId).pipe(
    Effect.map((result) =>
      result._tag === "None" || result.value._tag === "Suspended"
        ? ("suspended" as const)
        : result.value.exit,
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

const respond = (
  harness: Harness,
  request: HumanRequest | PermissionRequest | undefined,
  response: HumanResponse,
) =>
  Effect.gen(function* () {
    if (request === undefined) {
      throw new Error("No human request was made");
    }
    yield* respondToHuman(request.token, response);
    yield* harness.drain;
  });

const runTest = <A, E>(
  harness: Harness,
  effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine | TestClock.TestClock>,
) => Effect.runPromise(effect.pipe(Effect.provide(harness.layer)));

describe("RunAutomation", () => {
  test("runs steps in order, filling templates from the subject", async () => {
    const harness = makeHarness();
    const steps = await runTest(
      harness,
      Effect.flatMap(
        start(
          harness,
          automatic(agent("summarize", "Welcome {{employee.name}}"), {
            id: "notify",
            title: "Notify",
            kind: "action",
            use: "slack.sendMessage",
            with: { to: "{{employee.manager}}", text: "{{steps.summarize.output}}" },
          }),
        ),
        finalSteps,
      ),
    );
    expect(harness.calls).toEqual(["summarize", "notify"]);
    expect(steps).toEqual({
      summarize: { output: "Welcome Ada after nothing" },
      notify: { sent: { to: "grace", text: "Welcome Ada after nothing" } },
    });
  });

  test("a replay reuses recorded results instead of running steps again", async () => {
    const harness = makeHarness();
    await runTest(
      harness,
      Effect.gen(function* () {
        const executionId = yield* start(
          harness,
          workflow(agent("draft"), {
            id: "pause",
            title: "Pause",
            kind: "wait",
            duration: "1 day",
          }),
        );
        expect(yield* outcome(executionId)).toBe("suspended");
        yield* TestClock.adjust("1 day");
        yield* harness.drain;
        expect(Exit.isExit(yield* outcome(executionId))).toBe(true);
      }),
    );
    expect(harness.calls).toEqual(["draft"]);
  });

  test("runs parallel branches and gives later steps every branch's results", async () => {
    const harness = makeHarness();
    const steps = await runTest(
      harness,
      Effect.flatMap(
        start(
          harness,
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
    expect(steps["report"]).toEqual({ output: "Do report after laptop,buddy,brief-buddy" });
  });

  test("an if step runs the first matching case, or otherwise", async () => {
    const triage = workflow({
      id: "triage",
      title: "Triage",
      kind: "if",
      cases: [
        {
          when: { ref: "employee.priority", op: "equals", value: "high" },
          steps: [agent("page")],
        },
      ],
      otherwise: [agent("queue")],
    });

    const high = makeHarness();
    const highSteps = await runTest(high, Effect.flatMap(start(high, triage), finalSteps));
    expect(high.calls).toEqual(["page"]);
    expect(highSteps["triage"]).toEqual({ matched: 0 });

    const low = makeHarness();
    const lowSubject = { ...ada, data: { ...ada.data, priority: "low" } };
    const lowSteps = await runTest(low, Effect.flatMap(start(low, triage, lowSubject), finalSteps));
    expect(low.calls).toEqual(["queue"]);
    expect(lowSteps["triage"]).toEqual({ matched: null });
  });

  test("an action's match supplies the inputs of the first case that fits, or otherwise", async () => {
    const notify = automatic({
      id: "notify",
      title: "Notify",
      kind: "action",
      use: "slack.sendMessage",
      with: { to: "{{employee.manager}}" },
      match: {
        on: "employee.priority",
        cases: [
          { when: { op: "equals", value: "high" }, with: { text: "Now: {{employee.name}}" } },
          { when: { op: "exists" }, with: { text: "Soon" } },
        ],
        otherwise: { with: { text: "Whenever" } },
      },
    });

    const high = makeHarness();
    const highSteps = await runTest(high, Effect.flatMap(start(high, notify), finalSteps));
    expect(highSteps["notify"]).toEqual({ sent: { to: "grace", text: "Now: Ada" } });

    const low = makeHarness();
    const lowSubject = { ...ada, data: { ...ada.data, priority: "low" } };
    const lowSteps = await runTest(low, Effect.flatMap(start(low, notify, lowSubject), finalSteps));
    expect(lowSteps["notify"]).toEqual({ sent: { to: "grace", text: "Soon" } });

    const unset = makeHarness();
    const unsetSubject = { ...ada, data: { ...ada.data, priority: null } };
    const unsetSteps = await runTest(
      unset,
      Effect.flatMap(start(unset, notify, unsetSubject), finalSteps),
    );
    expect(unsetSteps["notify"]).toEqual({ sent: { to: "grace", text: "Whenever" } });
  });

  test("an action whose template wasn't expanded fails instead of sending", async () => {
    const harness = makeHarness();
    const result = await runTest(
      harness,
      Effect.flatMap(
        start(
          harness,
          workflow({
            id: "welcome",
            title: "Welcome",
            kind: "action",
            use: "email.send",
            with: { to: "{{employee}}" },
            template: { use: "welcome_email", with: { hire: "{{employee}}" } },
          }),
        ),
        outcome,
      ),
    );
    expect(Exit.isExit(result) && Exit.isFailure(result)).toBe(true);
    expect(harness.calls).toEqual([]);
  });

  test("an if step compares dates with now", async () => {
    const harness = makeHarness();
    await runTest(
      harness,
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-01T00:00:00Z"));
        const executionId = yield* start(
          harness,
          workflow({
            id: "upcoming",
            title: "Upcoming?",
            kind: "if",
            cases: [
              {
                when: { ref: "employee.start_date", op: "after", value: "now" },
                steps: [agent("prepare")],
              },
            ],
          }),
        );
        yield* finalSteps(executionId);
      }),
    );
    expect(harness.calls).toEqual(["prepare"]);
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
    const steps = await runTest(harness, Effect.flatMap(start(harness, routing), finalSteps));
    expect(harness.calls).toEqual(["route", "page"]);
    expect(steps["route"]).toEqual(decision);
  });

  test("a decision for an unknown option fails the run", async () => {
    const harness = makeHarness({ choice: "shrug", confidence: 1, probabilities: {} });
    const result = await runTest(harness, Effect.flatMap(start(harness, routing), outcome));
    expect(Exit.isExit(result) && Exit.isFailure(result)).toBe(true);
    expect(harness.calls).toEqual(["route"]);
  });

  test("a wait step holds the run until the duration passes", async () => {
    const harness = makeHarness();
    await runTest(
      harness,
      Effect.gen(function* () {
        const executionId = yield* start(
          harness,
          workflow(
            { id: "pause", title: "Pause", kind: "wait", duration: "3 days" },
            agent("after"),
          ),
        );
        expect(yield* outcome(executionId)).toBe("suspended");
        yield* TestClock.adjust("2 days");
        yield* harness.drain;
        expect(harness.calls).toEqual([]);
        yield* TestClock.adjust("1 day");
        yield* harness.drain;
        expect(harness.calls).toEqual(["after"]);
      }),
    );
    expect(harness.events).toContainEqual({
      runId: RunId.make("run-1"),
      step: "pause",
      status: "waiting",
    });
  });

  test("a wait-until step waits for a date on the subject, shifted by its offset", async () => {
    const harness = makeHarness();
    await runTest(
      harness,
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-01T00:00:00Z"));
        const executionId = yield* start(
          harness,
          workflow(
            {
              id: "week-before",
              title: "One week out",
              kind: "wait",
              until: "employee.start_date",
              offset: "-7 days",
            },
            agent("welcome"),
          ),
        );
        yield* TestClock.adjust("3 days");
        yield* harness.drain;
        expect(yield* outcome(executionId)).toBe("suspended");
        yield* TestClock.adjust("1 day");
        yield* harness.drain;
        expect(harness.calls).toEqual(["welcome"]);
      }),
    );
  });

  test("a human step parks the run until its assignee responds", async () => {
    const harness = makeHarness();
    const steps = await runTest(
      harness,
      Effect.gen(function* () {
        const executionId = yield* start(
          harness,
          automatic(
            agent("propose"),
            {
              id: "confirm",
              title: "Confirm",
              kind: "human",
              prompt: "Is this time good for {{employee.name}}?",
              assignee: "employee.manager",
              response: {
                fields: [
                  {
                    name: "start",
                    label: "Start",
                    type: "datetime",
                    default: "{{steps.propose.output}}",
                  },
                ],
              },
            },
            {
              id: "book",
              title: "Book",
              kind: "action",
              use: "calendar.createEvent",
              with: { start: "{{steps.confirm.values.start}}" },
            },
          ),
        );
        expect(yield* outcome(executionId)).toBe("suspended");
        expect(
          harness.requests.map(({ prompt, assignee, defaults }) => ({
            prompt,
            assignee,
            defaults,
          })),
        ).toEqual([
          {
            prompt: "Is this time good for Ada?",
            assignee: "grace",
            defaults: { start: "Do propose after nothing" },
          },
        ]);
        yield* respond(harness, harness.requests[0], {
          values: { start: "2026-10-13T10:00:00Z" },
          respondedBy: "grace",
        });
        return yield* finalSteps(executionId);
      }),
    );
    expect(harness.calls).toEqual(["propose", "book"]);
    expect(steps["book"]).toEqual({ sent: { start: "2026-10-13T10:00:00Z" } });
  });

  test("a human step with a timeout records that nobody answered", async () => {
    const harness = makeHarness();
    const steps = await runTest(
      harness,
      Effect.gen(function* () {
        const executionId = yield* start(
          harness,
          workflow({
            id: "confirm",
            title: "Confirm",
            kind: "human",
            prompt: "Did you greet {{employee.name}}?",
            response: "approval",
            timeout: "2 days",
          }),
        );
        yield* TestClock.adjust("2 days");
        yield* harness.drain;
        return yield* finalSteps(executionId);
      }),
    );
    expect(steps["confirm"]).toEqual({ timedOut: true });
  });

  test("a form that times out keeps its prefilled defaults", async () => {
    const harness = makeHarness();
    const steps = await runTest(
      harness,
      Effect.gen(function* () {
        const executionId = yield* start(
          harness,
          workflow({
            id: "confirm",
            title: "Confirm",
            kind: "human",
            prompt: "Keep the start date?",
            response: {
              fields: [
                { name: "start", label: "Start", type: "date", default: "{{employee.start_date}}" },
              ],
            },
            timeout: "1 day",
          }),
        );
        yield* TestClock.adjust("1 day");
        yield* harness.drain;
        return yield* finalSteps(executionId);
      }),
    );
    expect(steps["confirm"]).toEqual({ timedOut: true, values: { start: "2026-10-12" } });
  });

  const welcome: ActionStep = {
    id: "welcome",
    title: "Welcome {{employee.name}}",
    kind: "action",
    use: "email.send",
    with: { to: "{{employee.manager}}", subject: "Hi", body: "{{employee.name}} starts soon" },
  };

  test("an action set to ask first waits for approval, then runs with the inputs shown", async () => {
    const harness = makeHarness();
    const steps = await runTest(
      harness,
      Effect.gen(function* () {
        const executionId = yield* start(harness, {
          ...workflow(welcome, agent("after")),
          permissions: { "email.send": { ask: "people_ops" } },
        });
        expect(yield* outcome(executionId)).toBe("suspended");
        expect(harness.calls).toEqual([]);
        expect(
          harness.permissionRequests.map(({ step, role, title, inputs }) => ({
            step: step.id,
            role,
            title,
            inputs,
          })),
        ).toEqual([
          {
            step: "welcome",
            role: "people_ops",
            title: "Welcome Ada",
            inputs: { to: "grace", subject: "Hi", body: "Ada starts soon" },
          },
        ]);
        yield* respond(harness, harness.permissionRequests[0], { approved: true });
        return yield* finalSteps(executionId);
      }),
    );
    expect(harness.calls).toEqual(["welcome", "after"]);
    expect(steps["welcome"]).toEqual({
      sent: { to: "grace", subject: "Hi", body: "Ada starts soon" },
    });
    expect(harness.events).toContainEqual({
      runId: RunId.make("run-1"),
      step: "welcome",
      status: "waiting",
    });
  });

  test("declining an action skips it and the steps that need its record; the rest goes on", async () => {
    const harness = makeHarness();
    const steps = await runTest(
      harness,
      Effect.gen(function* () {
        const executionId = yield* start(harness, {
          ...workflow(
            welcome,
            agent("log", "Log {{steps.welcome.messageId}}"),
            agent("chain", "Read {{steps.log.output}}"),
            agent("other"),
            {
              id: "unsent",
              title: "If the welcome wasn't sent",
              kind: "if",
              cases: [
                {
                  when: { not: { ref: "steps.welcome", op: "exists" } },
                  steps: [agent("follow-up")],
                },
              ],
            },
          ),
          permissions: { "email.send": { ask: "people_ops" } },
        });
        yield* respond(harness, harness.permissionRequests[0], { approved: false });
        return yield* finalSteps(executionId);
      }),
    );
    expect(harness.calls).toEqual(["other", "follow-up"]);
    expect(Object.keys(steps)).toEqual(["other", "unsent", "follow-up"]);
    expect(harness.events.filter((event) => event.status === "declined")).toEqual([
      { runId: RunId.make("run-1"), step: "welcome", status: "declined" },
    ]);
    expect(harness.events.filter((event) => event.status === "skipped")).toEqual([
      { runId: RunId.make("run-1"), step: "log", status: "skipped" },
      { runId: RunId.make("run-1"), step: "chain", status: "skipped" },
    ]);
  });

  test("an operation set to auto runs without asking, and one with no permission fails", async () => {
    const automatic = makeHarness();
    await runTest(
      automatic,
      Effect.flatMap(
        start(automatic, { ...workflow(welcome), permissions: { "email.send": "auto" } }),
        finalSteps,
      ),
    );
    expect(automatic.permissionRequests).toEqual([]);
    expect(automatic.calls).toEqual(["welcome"]);

    const unset = makeHarness();
    const result = await runTest(unset, Effect.flatMap(start(unset, workflow(welcome)), outcome));
    expect(Exit.isExit(result) && Exit.isFailure(result)).toBe(true);
    expect(unset.calls).toEqual([]);
  });

  test("a stop step ends the run, with every branch", async () => {
    const harness = makeHarness();
    const result = await runTest(
      harness,
      Effect.flatMap(
        start(
          harness,
          workflow(
            {
              id: "both",
              title: "Both",
              kind: "parallel",
              branches: [
                [
                  agent("first"),
                  { id: "halt", title: "Halt", kind: "stop", reason: "No {{employee.name}}" },
                ],
                [{ id: "pause", title: "Pause", kind: "wait", duration: "1 day" }, agent("late")],
              ],
            },
            agent("after"),
          ),
        ),
        outcome,
      ),
    );
    if (typeof result === "string" || Exit.isSuccess(result)) {
      throw new Error(`The run didn't stop: ${String(result)}`);
    }
    const failure = Cause.squash(result.cause);
    expect(failure).toBeInstanceOf(RunStopped);
    expect(failure).toMatchObject({ step: "halt", reason: "No Ada" });
    expect(harness.calls).toEqual(["first"]);
  });

  test("journals the payload, each Activity result, and the final result", async () => {
    const harness = makeHarness();
    const executionId = await runTest(harness, start(harness, workflow(agent("one"))));
    expect([...harness.data.keys()].toSorted()).toEqual([
      `wf:${executionId}:activity:one:1`,
      `wf:${executionId}:payload`,
      `wf:${executionId}:result`,
    ]);
  });
});
