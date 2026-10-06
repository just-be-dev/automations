import { describe, expect, expectTypeOf, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { TestClock } from "effect/testing";
import { ProgressClassifier } from "../agents/planner/progress-classifier.ts";
import { PiAgent, type PromptOptions } from "../ai/pi.ts";
import { EntityStore, EntityStoreError, layerMemory } from "../entities/store.ts";
import type { Workflow } from "../workflow/model.ts";
import { ExecutionId, ExecutionValues } from "../workflow/execution.ts";
import { RunId } from "../workflow/run.ts";
import { answerHubLayer } from "./answer-hub.ts";
import { makeAutomation } from "./application.ts";
import { AutomationHost } from "./host.ts";
import { AutomationIndex, AutomationIndexError } from "./index.ts";
import { makePlanning } from "./planning.ts";
import { makeRunStore, StoredRun } from "./run-store.ts";

const workflow: Workflow = {
  name: "Saved workflow",
  trigger: { kind: "manual" },
  steps: [{ id: "stop", title: "Stop", kind: "stop", reason: "Snapshot finished" }],
};

/** A transactional host: cloned values and jobs roll back together, as the host contract requires. */
const harness = () => {
  let data = new Map<string, unknown>();
  const replies: Array<{ automationId: string; chatId: string }> = [];
  const advances: Array<string> = [];
  const clocks: Array<{ executionId: string; deferredName: string; at: number }> = [];
  /** The pending schedule occurrence: one at a time, like the host's single job ID. */
  const ticks = { pending: undefined as number | undefined };
  const prompts: Array<PromptOptions> = [];
  const recorded: Array<{ id: string; name: string }> = [];
  const lock = Semaphore.makeUnsafe(1);
  let failSchedule = false;
  const host = AutomationHost.of({
    storage: {
      get: (key) => Effect.sync(() => structuredClone(data.get(key))),
      put: (key, value) => Effect.sync(() => void data.set(key, structuredClone(value))),
      delete: (key) => Effect.sync(() => data.delete(key)),
      list: ({ prefix }) =>
        Effect.sync(
          () =>
            new Map(
              [...data]
                .filter(([key]) => key.startsWith(prefix))
                .toSorted(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => [key, structuredClone(value)]),
            ),
        ),
      transaction: (effect) =>
        lock.withPermit(
          Effect.gen(function* () {
            const before = new Map(data);
            const counts = [replies.length, advances.length, clocks.length] as const;
            const pendingTick = ticks.pending;
            const result = yield* Effect.exit(effect);
            if (Exit.isFailure(result)) {
              data = before;
              replies.length = counts[0];
              advances.length = counts[1];
              clocks.length = counts[2];
              ticks.pending = pendingTick;
            }
            return yield* result;
          }),
        ),
    },
    jobs: {
      planReply: (automationId, chatId) =>
        Effect.suspend(() => {
          if (failSchedule) return Effect.die("Scheduling failed");
          return Effect.sync(() => void replies.push({ automationId, chatId }));
        }),
      advance: (executionId) => Effect.sync(() => void advances.push(executionId)),
      clock: (executionId, deferredName, at) =>
        Effect.sync(() => void clocks.push({ executionId, deferredName, at })),
      tick: (at) => Effect.sync(() => void (ticks.pending = at)),
      cancelTick: Effect.sync(() => void (ticks.pending = undefined)),
    },
  });
  type Call = (name: string, args?: unknown) => Effect.Effect<string>;
  // By default the planner renames the workflow through its tools.
  let answer = (call: Call) =>
    Effect.gen(function* () {
      yield* call("set_workflow", {
        name: "New draft",
        trigger: workflow.trigger,
        steps: ["stop"],
      });
      yield* call("put_steps", { steps: workflow.steps });
      return "Designed";
    });
  const planner = Layer.effect(
    PiAgent,
    Effect.gen(function* () {
      const { tools } = yield* makePlanning();
      // Call IDs repeat when a script runs again for the same request, as pi's do when it reruns
      // a call after a restart.
      let request = "";
      let calls = 0;
      const call: Call = (name, args = {}) =>
        Effect.suspend(() => {
          const tool = tools.find((candidate) => candidate.name === name);
          calls += 1;
          return tool === undefined
            ? Effect.die(`No tool ${name}`)
            : Effect.orDie(tool.execute(args, { id: `${request}#${calls}` }));
        });
      return PiAgent.of({
        createConversation: Effect.succeed(7),
        instruct: () => Effect.void,
        liveAnswer: Effect.succeed(undefined),
        prompt: (options) =>
          Effect.suspend(() => {
            prompts.push(options);
            request = options.requestId ?? "";
            calls = 0;
            return answer(call);
          }),
      });
    }),
  );
  const services = Layer.mergeAll(
    answerHubLayer,
    Layer.succeed(
      ProgressClassifier,
      ProgressClassifier.of({ classify: () => Effect.die("No reasoning to classify") }),
    ),
    Layer.succeed(
      AutomationIndex,
      AutomationIndex.of({
        list: Effect.succeed([]),
        create: () => Effect.succeed(true),
        record: (id, name) => Effect.sync(() => void recorded.push({ id, name })),
        recordIfMissing: () => Effect.void,
      }),
    ),
    layerMemory({
      types: [
        {
          name: "person",
          label: "Person",
          title: "name",
          fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "email", label: "Email", type: "text" },
          ],
        },
      ],
      entities: [
        {
          type: "person",
          id: "sam",
          data: { name: "Sam", email: "sam@example.com" },
          updatedAt: 0,
        },
      ],
      roles: [{ name: "ops", label: "Ops", members: [{ type: "person", id: "sam" }] }],
    }),
  ).pipe(Layer.provideMerge(Layer.succeed(AutomationHost, host)));
  const layer = planner.pipe(Layer.provideMerge(services));
  return {
    host,
    layer,
    replies,
    advances,
    clocks,
    ticks,
    prompts,
    recorded,
    failSchedule: () => {
      failSchedule = true;
    },
    answerWith: (next: typeof answer) => {
      answer = next;
    },
  };
};

describe("Automation application without a platform", () => {
  test("accepts one chat, persists the original message, and ignores duplicate delivery after completion", async () => {
    const h = harness();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* makeAutomation();
        const { pendingChat } = yield* app.chat("a1", "  Keep my wording  ");
        const busy = yield* app.chat("a1", "Another message").pipe(Effect.flip);
        const reopened = yield* makeAutomation();
        const pending = yield* reopened.inspectWorkflow();
        yield* reopened.callbacks.planReply({ automationId: "a1", chatId: "different" });
        yield* reopened.callbacks.planReply({ automationId: "a1", chatId: pendingChat.id });
        yield* reopened.callbacks.planReply({ automationId: "a1", chatId: pendingChat.id });
        return { pendingChat, busy, pending, finished: yield* reopened.inspectWorkflow() };
      }).pipe(Effect.provide(h.layer)),
    );
    expect(h.replies).toEqual([{ automationId: "a1", chatId: result.pendingChat.id }]);
    expect(result.busy.message).toBe("The agent is still answering the previous message");
    expect(result.pending.pendingChat?.prompt).toBe("  Keep my wording  ");
    expect(result.finished.pendingChat).toBeUndefined();
    expect(result.finished.draft?.name).toBe("New draft");
    expect(result.finished.conversation).toEqual([
      { prompt: "  Keep my wording  ", reply: "Designed" },
    ]);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.requestId).toBe(`chat:${result.pendingChat.id}`);
    expect(h.prompts[0]?.text).toEndWith("The person's message:\n\n  Keep my wording  ");
    expect(h.recorded).toEqual([{ id: "a1", name: "New draft" }]);
    expect(await Effect.runPromise(h.host.storage.get("plan"))).toBeUndefined();
  });

  test("an answer that changes nothing keeps the draft and records the exchange", async () => {
    const h = harness();
    h.answerWith(() => Effect.succeed("What should start it?"));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* makeAutomation();
        const { pendingChat } = yield* app.chat("a1", "Onboard people");
        yield* app.callbacks.planReply({ automationId: "a1", chatId: pendingChat.id });
        return yield* app.inspectWorkflow();
      }).pipe(Effect.provide(h.layer)),
    );
    expect(result.draft).toBeUndefined();
    expect(result.pendingChat).toBeUndefined();
    expect(result.conversation).toEqual([
      { prompt: "Onboard people", reply: "What should start it?" },
    ]);
    expect(h.recorded).toEqual([]);
  });

  test("a question parks the reply, and answering resumes the same turn", async () => {
    const h = harness();
    const questions = [
      {
        question: "Who should approve the email?",
        header: "Approver",
        options: [{ label: "Ops" }, { label: "Nobody", description: "Send it on its own" }],
      },
    ];
    const results: Array<string> = [];
    h.answerWith((call) =>
      Effect.gen(function* () {
        results.push(yield* call("ask_question", { questions }));
        return "Ops will approve it.";
      }),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* makeAutomation();
        const { pendingChat } = yield* app.chat("a1", "Email new people");
        const reply = { automationId: "a1", chatId: pendingChat.id };
        yield* app.callbacks.planReply(reply);
        const parked = yield* app.inspectWorkflow();
        // A delivery that finds the turn parked leaves it waiting.
        yield* app.callbacks.planReply(reply);
        const wrongCount = yield* app
          .answer("a1", pendingChat.id, { kind: "answers", answers: ["Ops", null] })
          .pipe(Effect.flip);
        const resumed = yield* app.answer("a1", pendingChat.id, {
          kind: "answers",
          answers: ["Ops"],
        });
        const again = yield* app
          .answer("a1", pendingChat.id, { kind: "answers", answers: ["Ops"] })
          .pipe(Effect.flip);
        yield* app.callbacks.planReply(reply);
        return {
          pendingChat,
          parked,
          wrongCount,
          resumed,
          again,
          finished: yield* app.inspectWorkflow(),
        };
      }).pipe(Effect.provide(h.layer)),
    );
    expect(result.parked.pendingChat).toEqual({
      id: result.pendingChat.id,
      prompt: "Email new people",
      status: "asking",
      questions,
    });
    expect(result.parked.conversation).toEqual([]);
    expect(result.wrongCount.message).toBe("Give one answer for each of the 1 questions");
    expect(result.resumed.pendingChat.status).toBe("working");
    expect(result.again.message).toBe("The agent isn't waiting for answers");
    expect(h.replies).toHaveLength(2);
    expect(h.prompts.map((prompt) => prompt.requestId)).toEqual([
      `chat:${result.pendingChat.id}`,
      `chat:${result.pendingChat.id}`,
    ]);
    expect(results).toEqual([
      "The person answered:\n- Who should approve the email? Ops\nCarry on with their answers.",
    ]);
    expect(result.finished.pendingChat).toBeUndefined();
    expect(result.finished.conversation).toEqual([
      {
        prompt: "Email new people",
        asked: [{ questions, answer: { kind: "answers", answers: ["Ops"] } }],
        reply: "Ops will approve it.",
      },
    ]);
    expect(await Effect.runPromise(h.host.storage.get("plan"))).toBeUndefined();
  });

  test("a message sent while the planner waits answers its questions in other words", async () => {
    const h = harness();
    const questions = [
      {
        question: "Which tone?",
        header: "Tone",
        options: [{ label: "Formal" }, { label: "Casual" }],
      },
    ];
    const results: Array<string> = [];
    h.answerWith((call) =>
      Effect.gen(function* () {
        results.push(yield* call("ask_question", { questions }));
        return "Done";
      }),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* makeAutomation();
        const { pendingChat } = yield* app.chat("a1", "Write a greeting");
        yield* app.callbacks.planReply({ automationId: "a1", chatId: pendingChat.id });
        const sent = yield* app.chat("a1", "Somewhere in between, and short");
        yield* app.callbacks.planReply({ automationId: "a1", chatId: pendingChat.id });
        return { pendingChat, sent, finished: yield* app.inspectWorkflow() };
      }).pipe(Effect.provide(h.layer)),
    );
    expect(result.sent.pendingChat).toEqual(result.pendingChat);
    expect(results[0]).toContain(
      "Instead of picking answers, the person wrote:\n\nSomewhere in between, and short",
    );
    expect(result.finished.conversation[0]?.asked).toEqual([
      { questions, answer: { kind: "message", text: "Somewhere in between, and short" } },
    ]);
  });

  test("a turn still waiting in memory wakes when its questions are answered", async () => {
    const h = harness();
    const questions = [
      {
        question: "Which tone?",
        header: "Tone",
        options: [{ label: "Formal" }, { label: "Casual" }],
      },
    ];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const planning = yield* makePlanning();
        const ask = planning.tools.find((tool) => tool.name === "ask_question");
        if (ask === undefined) {
          return yield* Effect.die("No ask_question tool");
        }
        yield* planning.start("c1", undefined);
        const parked = yield* planning.watchParked("c1");
        const waiting = yield* Effect.forkChild(ask.execute({ questions }, { id: "call-1" }));
        yield* parked;
        const open = yield* planning.openQuestions("c1");
        const callId = yield* planning.recordAnswer("c1", { kind: "answers", answers: [null] });
        yield* planning.deliver(callId, { kind: "answers", answers: [null] });
        return { open, text: yield* Fiber.join(waiting) };
      }).pipe(Effect.provide(h.layer)),
    );
    expect(result.open?.questions).toEqual(questions);
    expect(result.text).toStartWith("The person skipped your questions.");
  });

  test("a redelivered reply keeps the edits the interrupted delivery made", async () => {
    const h = harness();
    h.answerWith((call) =>
      Effect.gen(function* () {
        yield* call("set_workflow", { name: "Edited", trigger: workflow.trigger, steps: ["stop"] });
        yield* call("put_steps", { steps: workflow.steps });
        return yield* Effect.die("Restarted mid-answer");
      }),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* makeAutomation();
        const { pendingChat } = yield* app.chat("a1", "Design");
        const reply = { automationId: "a1", chatId: pendingChat.id };
        const interrupted = yield* Effect.exit(app.callbacks.planReply(reply));
        // pi finishes the original answer; this delivery only waits for it.
        h.answerWith(() => Effect.succeed("Designed"));
        yield* (yield* makeAutomation()).callbacks.planReply(reply);
        return { interrupted, finished: yield* app.inspectWorkflow() };
      }).pipe(Effect.provide(h.layer)),
    );
    expect(Exit.isFailure(result.interrupted)).toBe(true);
    expect(result.finished.draft?.name).toBe("Edited");
    expect(result.finished.conversation).toEqual([{ prompt: "Design", reply: "Designed" }]);
  });

  test("doesn't leave a pending message behind when durable scheduling fails", async () => {
    const h = harness();
    h.failSchedule();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* makeAutomation();
        const failure = yield* Effect.exit(app.chat("a1", "Design"));
        return { failure, inspected: yield* app.inspectWorkflow() };
      }).pipe(Effect.provide(h.layer)),
    );
    expect(Exit.isFailure(result.failure)).toBe(true);
    expect(result.inspected.pendingChat).toBeUndefined();
    expect(h.replies).toEqual([]);
  });

  test("saving directly subscribes the trigger, replaces it, and removes it for a manual workflow", async () => {
    const h = harness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.putType({
          name: "ticket",
          label: "Ticket",
          title: "title",
          fields: [{ name: "title", label: "Title", type: "text" }],
        });
        const app = yield* makeAutomation();
        for (const type of ["person", "ticket", undefined]) {
          const draft: Workflow = {
            ...workflow,
            trigger: type === undefined ? { kind: "manual" } : { kind: "entity", entity: type },
          };
          yield* h.host.storage.put("draft", draft);
          expect((yield* app.save("a1")).saved).toEqual(draft);
          // Repeat to check subscription replacement is idempotent, not an append.
          yield* app.save("a1");
          expect(yield* h.host.storage.get("saved")).toEqual(draft);
          expect(yield* entities.subscribers("person")).toEqual(type === "person" ? ["a1"] : []);
          expect(yield* entities.subscribers("ticket")).toEqual(type === "ticket" ? ["a1"] : []);
        }
      }).pipe(Effect.provide(h.layer)),
    );
    expect(h.recorded).toHaveLength(6);
    expect(h.recorded.every((record) => record.id === "a1" && record.name === workflow.name)).toBe(
      true,
    );
  });

  test("a rejected save leaves the previous snapshot, subscription and directory alone", async () => {
    const h = harness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* h.host.storage.put("saved", workflow);
        yield* entities.subscribe("a1", "person");
        const invalid: Workflow = {
          ...workflow,
          trigger: { kind: "entity", entity: "missing" },
        };
        yield* h.host.storage.put("draft", invalid);
        const app = yield* makeAutomation();
        const failure = yield* app.save("a1").pipe(Effect.flip);
        expect(failure.message).toContain("missing");
        expect(yield* h.host.storage.get("saved")).toEqual(workflow);
        expect(yield* entities.subscribers("person")).toEqual(["a1"]);
        expect(yield* entities.subscribers("missing")).toEqual([]);
      }).pipe(Effect.provide(h.layer)),
    );
    expect(h.recorded).toEqual([]);
  });

  test("subscription failure leaves the snapshot saved; retry repairs it even if the directory fails", async () => {
    const h = harness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        const index = yield* AutomationIndex;
        yield* h.host.storage.put("draft", workflow);
        yield* entities.subscribe("a1", "person");
        const app = yield* makeAutomation().pipe(
          Effect.provideService(EntityStore, {
            ...entities,
            subscribe: () =>
              Effect.fail(new EntityStoreError({ message: "Subscription unavailable" })),
          }),
        );
        const failure = yield* app.save("a1").pipe(Effect.flip);
        expect(failure.message).toBe("Subscription unavailable");
        expect(yield* h.host.storage.get("saved")).toEqual(workflow);
        expect(yield* entities.subscribers("person")).toEqual(["a1"]);
        expect(h.recorded).toEqual([]);
        const reopened = yield* makeAutomation().pipe(
          Effect.provideService(AutomationIndex, {
            ...index,
            record: () =>
              Effect.fail(new AutomationIndexError({ message: "Directory unavailable" })),
          }),
        );
        expect(yield* reopened.save("a1")).toEqual({ saved: workflow });
        expect(yield* entities.subscribers("person")).toEqual([]);
      }).pipe(Effect.provide(h.layer)),
    );
  });

  test("reopens a saved run from the journal, without executing a newer draft", async () => {
    const h = harness();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("draft", workflow);
        const app = yield* makeAutomation();
        yield* app.save("a1");
        yield* h.host.storage.put("draft", { ...workflow, name: "Unsaved", steps: [] });
        const started = yield* app.start(undefined);
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
        expect(yield* h.host.storage.get(`execution:${executionId}`)).toBe(started.id);
        expect(yield* h.host.storage.get(`wf:${executionId}:payload`)).toBeDefined();
        const reopened = yield* makeAutomation();
        yield* reopened.callbacks.advance({}); // Old callback payloads are still ignored.
        yield* reopened.callbacks.advance({ executionId });
        yield* reopened.callbacks.advance({ executionId });
        return yield* reopened.run(started.id);
      }).pipe(Effect.provide(h.layer)),
    );
    expect(result?.workflow.name).toBe("Saved workflow");
    expect(result?.status).toBe("stopped");
    expect(result?.stopReason).toBe("Snapshot finished");
    expect(result?.steps.stop?.status).toBe("done");
  });

  test("keeps a durable wait across reopen and resumes it at the scheduled time", async () => {
    const h = harness();
    const saved: Workflow = {
      name: "Wait",
      trigger: { kind: "manual" },
      steps: [{ id: "pause", title: "Pause", kind: "wait", duration: "3 minutes" }],
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("saved", saved);
        const app = yield* makeAutomation();
        const started = yield* app.start(undefined);
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
        yield* app.callbacks.advance({ executionId });
        const waiting = yield* app.run(started.id);
        const reopened = yield* makeAutomation();
        yield* TestClock.setTime(179_999);
        yield* reopened.callbacks.advance({ executionId });
        const early = yield* reopened.run(started.id);
        yield* TestClock.setTime(180_000);
        const deferredName = yield* Schema.decodeUnknownEffect(Schema.String)(
          h.clocks[0]?.deferredName,
        );
        yield* reopened.callbacks.clock({ executionId, deferredName });
        yield* reopened.callbacks.advance({ executionId });
        return { waiting, early, finished: yield* reopened.run(started.id) };
      }).pipe(Effect.provide(Layer.merge(h.layer, TestClock.layer()))),
    );
    expect(h.clocks).toHaveLength(1);
    expect(h.clocks[0]?.at).toBe(180_000);
    expect(result.waiting?.status).toBe("waiting");
    expect(result.early?.status).toBe("waiting");
    expect(result.finished?.status).toBe("completed");
    expect(result.finished?.steps.pause).toEqual({ status: "done", record: null });
    expect(h.advances).toHaveLength(2);
  });

  test("replay takes execution values from the journal, not the displayed run records", async () => {
    const h = harness();
    const saved: Workflow = {
      name: "Journal authority",
      trigger: { kind: "manual" },
      permissions: { "slack.sendMessage": "auto" },
      steps: [
        {
          id: "first",
          title: "First",
          kind: "action",
          use: "slack.sendMessage",
          with: { to: "#original", text: "First" },
        },
        { id: "pause", title: "Pause", kind: "wait", duration: "3 minutes" },
        {
          id: "last",
          title: "Last",
          kind: "action",
          use: "slack.sendMessage",
          with: { to: "#ops", text: "{{steps.first.channel}}" },
        },
      ],
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("saved", saved);
        const app = yield* makeAutomation();
        const started = yield* app.start(undefined);
        expect(started.status).toBe("running");
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
        expect(executionId).not.toBe(started.id);
        yield* app.callbacks.advance({ executionId });
        const waiting = yield* Schema.decodeUnknownEffect(StoredRun)(yield* app.run(started.id));
        yield* h.host.storage.put(`run:${started.id}`, {
          ...waiting,
          steps: { ...waiting.steps, first: { status: "done", record: { channel: "#forged" } } },
        });
        const reopened = yield* makeAutomation();
        yield* TestClock.setTime(180_000);
        const deferredName = yield* Schema.decodeUnknownEffect(Schema.String)(
          h.clocks[0]?.deferredName,
        );
        yield* reopened.callbacks.clock({ executionId, deferredName });
        yield* reopened.callbacks.advance({ executionId });
        const finished = yield* reopened.run(started.id);
        expect(finished?.status).toBe("completed");
        expect(finished?.steps.last?.record).toMatchObject({ text: "#original", simulated: true });
        expect(finished?.steps.first?.record).toMatchObject({ channel: "#original" });
      }).pipe(Effect.provide(Layer.merge(h.layer, TestClock.layer()))),
    );
  });

  test("run records merge parallel reports and keep execution lookup separate from run IDs", async () => {
    const h = harness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const records = yield* makeRunStore().pipe(
          Effect.provideService(AutomationHost, {
            ...h.host,
            storage: {
              ...h.host.storage,
              // Yield after the read so parallel reports race unless updates hold the lock.
              get: (key) =>
                h.host.storage.get(key).pipe(Effect.tap(() => Effect.sleep("1 millis"))),
            },
          }),
        );
        const id = RunId.make("run-alpha");
        const executionId = ExecutionId.make("execution-beta");
        yield* records.write({
          id,
          workflow,
          subject: null,
          status: "running",
          steps: {},
          tasks: [],
          startedAt: 17,
        });
        yield* records.linkExecution(executionId, id);
        expect(yield* records.runForExecution(executionId)).toBe(id);
        expect(yield* records.runForExecution(ExecutionId.make("run-alpha"))).toBeUndefined();
        expect(yield* records.read(RunId.make("execution-beta"))).toBeUndefined();
        yield* Effect.all(
          [
            records.report({ runId: id, step: "left", status: "done", record: { value: 3 } }),
            records.report({ runId: id, step: "right", status: "done", record: { value: 11 } }),
          ],
          { concurrency: "unbounded" },
        );
        // A replay's earlier progress cannot erase a completed record.
        yield* records.report({ runId: id, step: "left", status: "running" });
        const found = yield* records.read(id);
        expect(found?.steps).toEqual({
          left: { status: "done", record: { value: 3 } },
          right: { status: "done", record: { value: 11 } },
        });
        expect(found?.status).toBe("running"); // Step reports don't settle overall status.
        expectTypeOf<RunId>().not.toMatchTypeOf<ExecutionId>();
        expectTypeOf<ExecutionId>().not.toMatchTypeOf<RunId>();
        expectTypeOf<Parameters<typeof records.read>[0]>().toEqualTypeOf<RunId>();
        expectTypeOf<Parameters<typeof records.runForExecution>[0]>().toEqualTypeOf<ExecutionId>();
        const values = yield* Schema.decodeUnknownEffect(ExecutionValues)({
          runId: "run-alpha",
          subject: null,
          steps: { left: { value: 3 } },
        });
        expect(yield* Schema.encodeEffect(ExecutionValues)(values)).toEqual({
          runId: "run-alpha",
          subject: null,
          steps: { left: { value: 3 } },
        });
      }).pipe(Effect.provide(h.layer)),
    );
  });

  test("records and authorizes approval tasks, then resumes on the same durable journal", async () => {
    const h = harness();
    const saved: Workflow = {
      name: "Approval",
      trigger: { kind: "manual" },
      permissions: { "slack.sendMessage": { ask: "ops" } },
      steps: [
        {
          id: "send",
          title: "Send",
          kind: "action",
          use: "slack.sendMessage",
          with: { to: "#ops", text: "Ready" },
        },
      ],
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("saved", saved);
        const app = yield* makeAutomation();
        const started = yield* app.start(undefined);
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
        yield* app.callbacks.advance({ executionId });
        const waiting = yield* app.run(started.id);
        const rejected = yield* app
          .respond(started.id, "send", { approved: true }, "other@example.com")
          .pipe(Effect.flip);
        const reopened = yield* makeAutomation();
        yield* reopened.respond(started.id, "send", { approved: true }, "SAM@example.com");
        yield* reopened.callbacks.advance({ executionId });
        return { waiting, rejected, finished: yield* reopened.run(started.id) };
      }).pipe(Effect.provide(h.layer)),
    );
    expect(result.waiting?.status).toBe("waiting");
    expect(result.waiting?.tasks[0]?.approvers?.members).toEqual([
      { name: "Sam", email: "sam@example.com" },
    ]);
    expect(result.rejected.message).toBe("Only members of Ops can answer this");
    expect(result.finished?.status).toBe("completed");
    expect(result.finished?.tasks[0]?.status).toBe("closed");
    expect(result.finished?.steps.send?.record).toMatchObject({ simulated: true });
    expect(h.advances).toHaveLength(2);
  });
});

describe("Scheduled automations", () => {
  const monday = Date.parse("2026-10-05T13:00:00Z");
  const nextMonday = Date.parse("2026-10-12T13:00:00Z");
  const weekly: Workflow = {
    ...workflow,
    trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "America/New_York" },
  };
  const withClock = (h: ReturnType<typeof harness>) => Layer.merge(h.layer, TestClock.layer());

  test("saving books the next occurrence, and saving another trigger cancels it", async () => {
    const h = harness();
    const overview = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(monday - 3_600_000);
        yield* h.host.storage.put("draft", weekly);
        const app = yield* makeAutomation();
        yield* app.save("a1");
        expect(h.ticks.pending).toBe(monday);
        const scheduled = yield* app.overview();
        yield* h.host.storage.put("draft", workflow);
        yield* app.save("a1");
        expect(h.ticks.pending).toBeUndefined();
        return scheduled;
      }).pipe(Effect.provide(withClock(h))),
    );
    expect(overview.saved).toEqual({ trigger: weekly.trigger, nextRunAt: monday });
  });

  test("an occurrence starts its run once, then books the next", async () => {
    const h = harness();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("draft", weekly);
        const app = yield* makeAutomation();
        yield* app.save("a1");
        yield* TestClock.setTime(monday);
        yield* app.callbacks.tick({ at: monday });
        // Delivery is at least once.
        yield* (yield* makeAutomation()).callbacks.tick({ at: monday });
        const booked = h.ticks.pending;
        // A tick for a time the schedule doesn't have starts nothing.
        yield* app.callbacks.tick({ at: monday + 60_000 });
        const { runs } = yield* app.inspectWorkflow();
        return { booked, runs, run: yield* app.run(RunId.make(`scheduled-${monday}`)) };
      }).pipe(Effect.provide(withClock(h))),
    );
    expect(result.booked).toBe(nextMonday);
    expect(result.runs.map((run) => run.id)).toEqual([RunId.make(`scheduled-${monday}`)]);
    expect(result.run?.subject).toBeNull();
    expect(h.advances).toHaveLength(1);
  });

  test("a late occurrence starts once and books the next one after now", async () => {
    const h = harness();
    const runs = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("draft", weekly);
        const app = yield* makeAutomation();
        yield* app.save("a1");
        yield* TestClock.setTime(nextMonday + 3_600_000);
        yield* app.callbacks.tick({ at: monday });
        return (yield* app.inspectWorkflow()).runs;
      }).pipe(Effect.provide(withClock(h))),
    );
    expect(runs).toHaveLength(1);
    expect(h.ticks.pending).toBe(Date.parse("2026-10-19T13:00:00Z"));
  });

  test("a schedule over an entity type starts a run for each entity its condition holds for", async () => {
    const h = harness();
    const ids = await Effect.runPromise(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.putEntity("person", "ada", { name: "Ada", email: "ada@example.com" });
        yield* entities.putEntity("person", "kim", { name: "Kim", email: "kim@other.org" });
        yield* h.host.storage.put("draft", {
          ...weekly,
          trigger: {
            ...weekly.trigger,
            entity: "person",
            when: { ref: "person.email", op: "contains", value: "@example.com" },
          },
        });
        const app = yield* makeAutomation();
        yield* app.save("a1");
        yield* TestClock.setTime(monday);
        yield* app.callbacks.tick({ at: monday });
        const { runs } = yield* app.inspectWorkflow();
        const ada = yield* app.run(RunId.make(`scheduled-${monday}-ada`));
        return { runs: runs.map((run) => run.id).toSorted(), subject: ada?.subject?.id };
      }).pipe(Effect.provide(withClock(h))),
    );
    expect(ids.runs).toEqual([`scheduled-${monday}-ada`, `scheduled-${monday}-sam`]);
    expect(ids.subject).toBe("ada");
  });

  test("a tick after the schedule was replaced starts and books nothing", async () => {
    const h = harness();
    const runs = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("saved", workflow);
        const app = yield* makeAutomation();
        yield* TestClock.setTime(monday);
        yield* app.callbacks.tick({ at: monday });
        return (yield* app.inspectWorkflow()).runs;
      }).pipe(Effect.provide(withClock(h))),
    );
    expect(runs).toEqual([]);
    expect(h.ticks.pending).toBeUndefined();
  });
});

describe("Timed triggers and their limits", () => {
  const monday = Date.parse("2026-10-05T13:00:00Z");
  const tuesday = Date.parse("2026-10-06T13:00:00Z");
  const everyone: Workflow = {
    ...workflow,
    trigger: {
      kind: "schedule",
      cron: "0 9 * * 1",
      timezone: "America/New_York",
      entity: "person",
    },
  };
  const withClock = (h: ReturnType<typeof harness>) => Layer.merge(h.layer, TestClock.layer());
  const addPeople = (count: number, email: (index: number) => string) =>
    Effect.gen(function* () {
      const entities = yield* EntityStore;
      for (let index = 0; index < count; index++) {
        yield* entities.putEntity("person", `p${index}`, {
          name: `P${index}`,
          email: email(index),
        });
      }
    });

  test("saving a schedule that already matches too many entities is refused", async () => {
    const h = harness();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* addPeople(50, (index) => `p${index}@example.com`);
        yield* h.host.storage.put("draft", everyone);
        const app = yield* makeAutomation();
        const error = yield* Effect.flip(app.save("a1"));
        expect(yield* h.host.storage.get("saved")).toBeUndefined();
        return error;
      }).pipe(Effect.provide(withClock(h))),
    );
    expect(failure).toMatchObject({
      message: expect.stringContaining("51 entities are due at once"),
    });
    expect(h.ticks.pending).toBeUndefined();
  });

  test("an occurrence that matches too many entities starts none and records why", async () => {
    const h = harness();
    const runs = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("draft", {
          ...everyone,
          trigger: {
            ...everyone.trigger,
            when: { ref: "person.email", op: "contains", value: "@later.org" },
          },
        });
        const app = yield* makeAutomation();
        yield* app.save("a1");
        yield* addPeople(51, (index) => `p${index}@later.org`);
        yield* TestClock.setTime(monday);
        yield* app.callbacks.tick({ at: monday });
        yield* app.callbacks.tick({ at: monday });
        return (yield* app.inspectWorkflow()).runs;
      }).pipe(Effect.provide(withClock(h))),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: `scheduled-${monday}`, status: "failed" });
    expect(h.advances).toEqual([]);
    expect(h.ticks.pending).toBe(Date.parse("2026-10-12T13:00:00Z"));
  });

  test("a date trigger starts a run on the day each date falls, and follows a changed date", async () => {
    const h = harness();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.putType({
          name: "person",
          label: "Person",
          title: "name",
          fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "email", label: "Email", type: "text" },
            { name: "start_date", label: "Start date", type: "date" },
          ],
        });
        yield* entities.putEntity("person", "ada", {
          name: "Ada",
          email: "ada@example.com",
          start_date: "2026-10-02",
        });
        yield* h.host.storage.put("draft", {
          ...workflow,
          trigger: {
            kind: "date",
            entity: "person",
            on: "person.start_date",
            offset: "3 days",
            timezone: "America/New_York",
          },
        });
        yield* TestClock.setTime(monday - 3_600_000);
        const app = yield* makeAutomation();
        yield* app.save("a1");
        const booked = h.ticks.pending;
        yield* TestClock.setTime(monday);
        yield* app.callbacks.tick({ at: monday });
        const first = (yield* app.inspectWorkflow()).runs.map((run) => run.id);
        // A date that moves to a day already checked doesn't start a run late.
        yield* entities.putEntity("person", "ada", { start_date: "2026-10-01" });
        yield* entities.putEntity("person", "sam", { start_date: "2026-10-03" });
        yield* TestClock.setTime(tuesday);
        yield* app.callbacks.tick({ at: tuesday });
        const second = (yield* app.inspectWorkflow()).runs.map((run) => run.id);
        return { booked, first, second, watchers: yield* entities.subscribers("person") };
      }).pipe(Effect.provide(withClock(h))),
    );
    expect(result.booked).toBe(Date.parse("2026-10-05T13:00:00Z"));
    expect(result.first).toEqual([`scheduled-${monday}-ada`]);
    expect(result.second.toSorted()).toEqual([
      `scheduled-${monday}-ada`,
      `scheduled-${tuesday}-sam`,
    ]);
    expect(h.ticks.pending).toBe(Date.parse("2026-10-07T13:00:00Z"));
    expect(result.watchers).toEqual(["a1"]);
  });

  test("saving subscribes to the type a schedule is about, so the type can't be deleted", async () => {
    const h = harness();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* h.host.storage.put("draft", everyone);
        yield* (yield* makeAutomation()).save("a1");
        const watchers = yield* entities.subscribers("person");
        yield* entities.deleteEntity("person", "sam").pipe(Effect.ignore);
        const deleted = yield* Effect.exit(entities.deleteType("person"));
        return { watchers, deleted };
      }).pipe(Effect.provide(withClock(h))),
    );
    expect(result.watchers).toEqual(["a1"]);
    expect(Exit.isFailure(result.deleted)).toBe(true);
  });
});
