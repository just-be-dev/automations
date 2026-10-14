/** Exercises design, saving, scheduling, approvals, and durable runs over an in-memory automation host. */
import { describe, expect, expectTypeOf, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { TestClock } from "effect/testing";
import { Classifier, type ClassifyRequest } from "../ai/classifier.ts";
import { PiAgent, type PromptOptions } from "../ai/pi.ts";
import { EntityStore, EntityStoreError, layerMemory } from "../entities/store.ts";
import { EntitySubscribers } from "../entities/subscribers.ts";
import { makeChanges } from "../changes/application.ts";
import type { ChangeStorage } from "../changes/host.ts";
import { deliverEvent } from "../events/delivery.ts";
import type { Event } from "../events/model.ts";
import { Events } from "../events/service.ts";
import type { Workflow } from "../workflow/model.ts";
import { ExecutionId, ExecutionValues } from "../workflow/execution.ts";
import { RunId } from "../workflow/run.ts";
import { answerHubLayer } from "../ai/ask-question/answer-hub.ts";
import {
  approvalButtons,
  decideFromSlack,
  SlackWorkspace,
  SlackWorkspaceError,
  SlackBlockJson,
  type SlackTaskAction,
} from "../channels/slack-approvals.ts";
import { makeAutomation } from "./application.ts";
import { AutomationError } from "./model.ts";
import { AutomationHost } from "./host.ts";
import { AutomationIndex, AutomationIndexError } from "./index.ts";
import { LocalDevelopment } from "./local-development.ts";
import { Automations } from "./service.ts";
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
  const transcripts: Array<number | undefined> = [];
  const recorded: Array<{ id: string; name: string }> = [];
  const emitted: Array<Event> = [];
  const classified: Array<ClassifyRequest> = [];
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
        transcript: (conversation) =>
          Effect.sync(() => {
            transcripts.push(conversation);
            return {
              events: [{ _tag: "Prompt" as const, id: "1", at: 0, text: `In ${conversation}` }],
              truncated: false,
            };
          }),
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
    Layer.succeed(Events, { publish: (event) => Effect.sync(() => void emitted.push(event)) }),
    // Decide steps pick their first option; there's no reasoning for progress to classify.
    Layer.succeed(
      Classifier,
      Classifier.of({
        classify: (request) =>
          Effect.suspend(() => {
            const criteria = request.questions["decision"]?.criteria;
            if (criteria === undefined) return Effect.die("No reasoning to classify");
            classified.push(request);
            const choice = Object.keys(criteria)[0] ?? "";
            return Effect.succeed({
              answers: { decision: { choice, confidence: 0.7, probabilities: { [choice]: 0.9 } } },
            });
          }),
      }),
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
    transcripts,
    recorded,
    emitted,
    classified,
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
    expect(result.resumed.pendingChat).toEqual({
      id: result.pendingChat.id,
      prompt: "Email new people",
      status: "working",
      asked: [{ questions, answer: { kind: "answers", answers: ["Ops"] } }],
    });
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
    expect(result.sent).toEqual({
      pendingChat: {
        id: result.pendingChat.id,
        prompt: "Write a greeting",
        status: "working",
        asked: [
          { questions, answer: { kind: "message", text: "Somewhere in between, and short" } },
        ],
      },
    });
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

  test("traces read the planner's conversation and the one a run's agent steps share", async () => {
    const h = harness();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* makeAutomation();
        const records = yield* makeRunStore();
        const run = {
          workflow,
          subject: null,
          status: "completed" as const,
          steps: {},
          tasks: [],
          startedAt: 0,
        };
        yield* records.write({ ...run, id: RunId.make("no-agents") });
        yield* records.write({ ...run, id: RunId.make("with-agents"), conversation: 7 });
        return {
          planner: yield* app.plannerTrace(),
          missing: yield* app.runTrace(RunId.make("missing")),
          withoutAgents: yield* app.runTrace(RunId.make("no-agents")),
          withAgents: yield* app.runTrace(RunId.make("with-agents")),
        };
      }).pipe(Effect.provide(h.layer)),
    );
    expect(h.transcripts).toEqual([undefined, 7]);
    expect(result.planner.events).toEqual([
      { _tag: "Prompt", id: "1", at: 0, text: "In undefined" },
    ]);
    expect(result.missing).toBeUndefined();
    expect(result.withoutAgents).toEqual({ events: [], truncated: false });
    expect(result.withAgents?.events).toEqual([{ _tag: "Prompt", id: "1", at: 0, text: "In 7" }]);
  });

  test("a decide step asks its own classifier model, not the run's agent", async () => {
    const h = harness();
    const routed: Workflow = {
      ...workflow,
      steps: [
        {
          id: "route",
          title: "Route",
          kind: "decide",
          model: "clef",
          question: "Which way?",
          options: [
            {
              id: "stop-here",
              description: "Stop now",
              steps: [{ id: "stop", title: "Stop", kind: "stop", reason: "Routed" }],
            },
            { id: "carry-on", description: "Keep going", steps: [] },
          ],
        },
      ],
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("draft", routed);
        const app = yield* makeAutomation();
        yield* app.save("a1");
        const started = yield* app.start(undefined);
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
        yield* app.callbacks.advance({ executionId });
        return yield* app.run(started.id);
      }).pipe(Effect.provide(h.layer)),
    );
    expect(h.classified.map((request) => request.model)).toEqual(["clef"]);
    expect(h.classified[0]?.questions["decision"]?.instructions).toBe("Which way?");
    expect(h.prompts).toEqual([]);
    expect(result?.steps.route?.record).toEqual({
      choice: "stop-here",
      confidence: 0.7,
      probabilities: { "stop-here": 0.9 },
    });
    expect(result?.stopReason).toBe("Routed");
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

  test("in local development, resuming a wait fires its clock now and the scheduled delivery later changes nothing", async () => {
    const h = harness();
    const saved: Workflow = {
      name: "Settle in",
      trigger: { kind: "manual" },
      permissions: { "slack.sendMessage": "auto" },
      steps: [
        { id: "settle", title: "Give them three days", kind: "wait", duration: "3 days" },
        {
          id: "check_in",
          title: "Check in",
          kind: "action",
          use: "slack.sendMessage",
          with: { to: "#managers", text: "How is it going?" },
        },
      ],
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("saved", saved);
        const app = yield* makeAutomation().pipe(Effect.provideService(LocalDevelopment, true));
        const started = yield* app.start(undefined);
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
        yield* app.callbacks.advance({ executionId });
        const waiting = yield* app.run(started.id);
        const notAWait = yield* Effect.flip(app.resumeNow(started.id, "check_in"));
        const resumed = yield* app.resumeNow(started.id, "settle");
        // The host replays on the advance the early clock scheduled.
        yield* app.callbacks.advance({ executionId });
        const finished = yield* app.run(started.id);
        const journal = yield* h.host.storage.list({ prefix: `wf:${executionId}:` });
        // Three days later, the clock's own delivery arrives anyway.
        yield* TestClock.setTime(3 * 86_400_000);
        const deferredName = yield* Schema.decodeUnknownEffect(Schema.String)(
          h.clocks[0]?.deferredName,
        );
        yield* app.callbacks.clock({ executionId, deferredName });
        const again = yield* Effect.flip(app.resumeNow(started.id, "settle"));
        return {
          waiting,
          notAWait,
          resumed,
          finished,
          journal,
          journalAfter: yield* h.host.storage.list({ prefix: `wf:${executionId}:` }),
          after: yield* app.run(started.id),
          again,
        };
      }).pipe(Effect.provide(Layer.merge(h.layer, TestClock.layer()))),
    );
    expect(result.waiting?.status).toBe("waiting");
    expect(result.waiting?.resumesAt).toEqual({ settle: 3 * 86_400_000 });
    expect(result.notAWait.message).toBe("That step isn't waiting on a clock");
    expect(result.resumed).toEqual({ ok: true });
    expect(result.finished?.status).toBe("completed");
    expect(result.finished?.steps.settle).toEqual({ status: "done", record: null });
    expect(result.finished?.steps.check_in?.record).toMatchObject({ simulated: true });
    expect(result.finished?.resumesAt).toEqual({});
    // The late delivery wrote nothing and scheduled no replay.
    expect(h.advances).toHaveLength(2);
    expect(result.journalAfter).toEqual(result.journal);
    expect(result.after).toEqual(result.finished);
    expect(result.again.message).toBe("That step isn't waiting on a clock");
  });

  test("resuming a wait early refuses outside local development, and a human step's timeout is not a wait", async () => {
    /** Starts a run of `steps` and replays it until it waits. */
    const waitingRun = (h: ReturnType<typeof harness>, steps: Workflow["steps"]) =>
      Effect.gen(function* () {
        yield* h.host.storage.put("saved", { name: "Waits", trigger: { kind: "manual" }, steps });
        const started = yield* (yield* makeAutomation()).start(undefined);
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
        yield* (yield* makeAutomation()).callbacks.advance({ executionId });
        return started.id;
      });
    const deployed = harness();
    const asking = harness();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const settling = yield* waitingRun(deployed, [
          { id: "settle", title: "Settle in", kind: "wait", duration: "3 days" },
        ]).pipe(Effect.provide(deployed.layer));
        const app = yield* makeAutomation().pipe(Effect.provide(deployed.layer));
        const refused = yield* Effect.flip(app.resumeNow(settling, "settle")).pipe(
          Effect.provide(deployed.layer),
        );
        const asked = yield* waitingRun(asking, [
          {
            id: "ask",
            title: "Ask",
            kind: "human",
            prompt: "How is it going?",
            response: "approval",
            timeout: "2 days",
          },
        ]).pipe(Effect.provide(asking.layer));
        const local = yield* makeAutomation().pipe(
          Effect.provideService(LocalDevelopment, true),
          Effect.provide(asking.layer),
        );
        const timeout = yield* Effect.flip(local.resumeNow(asked, "ask")).pipe(
          Effect.provide(asking.layer),
        );
        const missing = yield* Effect.flip(local.resumeNow(RunId.make("no-such-run"), "ask")).pipe(
          Effect.provide(asking.layer),
        );
        return {
          refused,
          timeout,
          missing,
          settling: yield* app.run(settling).pipe(Effect.provide(deployed.layer)),
          asked: yield* local.run(asked).pipe(Effect.provide(asking.layer)),
        };
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result.refused.message).toBe("Resuming a wait early only works in local development");
    expect(result.settling?.status).toBe("waiting");
    expect(result.settling?.resumesAt).toEqual({ settle: 3 * 86_400_000 });
    expect(deployed.advances).toHaveLength(1);
    expect(result.timeout.message).toBe("That step isn't waiting on a clock");
    expect(result.missing.message).toBe("That step isn't waiting on a clock");
    expect(asking.clocks.map((clock) => clock.deferredName)).toEqual(["DurableClock/ask/timeout"]);
    expect(result.asked?.status).toBe("waiting");
    expect(result.asked?.resumesAt).toEqual({});
    expect(asking.advances).toHaveLength(1);
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
        const values = yield* Schema.decodeEffect(ExecutionValues)({
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
    expect(result.finished?.tasks[0]?.decision).toMatchObject({
      approved: true,
      by: "SAM@example.com",
    });
    expect(result.finished?.steps.send?.record).toMatchObject({ simulated: true });
    expect(h.advances).toHaveLength(2);
  });
});

describe("Deciding approval tasks from Slack", () => {
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
  const decidedAt = Date.parse("2026-10-14T10:05:00Z");
  /** Slack's side: who each user is, and what was said back to them. */
  const workspace = () => {
    const emails: Record<string, string | undefined> = {
      "U-sam": "SAM@example.com",
      "U-eve": "eve@example.com",
    };
    const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown }> = [];
    const ephemeral: Array<{ url: string; text: string }> = [];
    const service = SlackWorkspace.of({
      emailOf: (user) => Effect.succeed(emails[user]),
      updateMessage: (channel, ts, message) =>
        Effect.sync(() => void updates.push({ channel, ts, ...message })),
      replyEphemeral: (url, text) => Effect.sync(() => void ephemeral.push({ url, text })),
    });
    return { service, updates, ephemeral };
  };
  const click = (
    run: string,
    user: string,
    approved: boolean,
    url = `https://hooks.slack.com/${user}`,
  ): SlackTaskAction => {
    const ref = { automation: "a1", run, step: "send" };
    // The message as Slack sends it back with the click: plain JSON.
    const blocks = Schema.decodeUnknownSync(Schema.Array(SlackBlockJson))([
      { type: "section", text: { type: "mrkdwn", text: "Approve the message?" } },
      {
        type: "actions",
        block_id: "task-actions",
        elements: [
          { type: "button", action_id: "task.open", url: "https://studio" },
          ...approvalButtons(ref),
        ],
      },
    ]);
    return { task: ref, approved, user, channel: `D-${user}`, ts: "1.0", responseUrl: url, blocks };
  };

  test("only a role member's click decides; others hear why, and the task stays open", async () => {
    const h = harness();
    const slack = workspace();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("saved", saved);
        const app = yield* makeAutomation();
        const started = yield* app.start(undefined);
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
        yield* app.callbacks.advance({ executionId });
        const decide = (action: SlackTaskAction) =>
          decideFromSlack(action).pipe(
            Effect.provideService(Automations, { get: () => app }),
            Effect.provideService(SlackWorkspace, slack.service),
          );
        // Not in the role, and no email address at all: neither may answer.
        yield* decide(click(started.id, "U-eve", true));
        yield* decide(click(started.id, "U-bot", true));
        return yield* app.run(started.id);
      }).pipe(Effect.provide(h.layer)),
    );
    expect(slack.ephemeral).toEqual([
      { url: "https://hooks.slack.com/U-eve", text: "Only members of Ops can answer this" },
      {
        url: "https://hooks.slack.com/U-bot",
        text: "Slack has no email address for you, so the studio can't check that you may answer this. Open it in the studio instead.",
      },
    ]);
    expect(slack.updates).toEqual([]);
    expect(result?.tasks[0]?.status).toBe("open");
    expect(result?.status).toBe("waiting");
  });

  test("the first click decides once; repeats and later clicks redraw that decision", async () => {
    const h = harness();
    const slack = workspace();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(decidedAt);
        yield* h.host.storage.put("saved", saved);
        const app = yield* makeAutomation();
        const started = yield* app.start(undefined);
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
        yield* app.callbacks.advance({ executionId });
        const decide = (action: SlackTaskAction) =>
          decideFromSlack(action).pipe(
            Effect.provideService(Automations, { get: () => app }),
            Effect.provideService(SlackWorkspace, slack.service),
          );
        // Sam rejects, and the same click arrives again alongside an Approve: one decision.
        const rejected = click(started.id, "U-sam", false);
        yield* Effect.all([decide(rejected), decide(click(started.id, "U-sam", true))], {
          concurrency: "unbounded",
        });
        yield* decide(rejected);
        // A non-member clicking after it's decided just sees the decision.
        yield* decide(click(started.id, "U-eve", true));
        yield* app.callbacks.advance({ executionId });
        return yield* app.run(started.id);
      }).pipe(Effect.provide(Layer.merge(h.layer, TestClock.layer()))),
    );
    const task = result?.tasks[0];
    expect(task?.status).toBe("closed");
    expect(task?.decision?.by).toBe("SAM@example.com");
    expect(task?.decision?.at).toBe(decidedAt);
    // One answer reached the journal: one advance after the run first parked.
    expect(h.advances).toHaveLength(2);
    expect(result?.status).toBe("completed");
    expect(slack.ephemeral).toEqual([]);
    expect(slack.updates).toHaveLength(4);
    // Every redraw shows the same decision and no Approve or Reject button.
    const texts = new Set(slack.updates.map((update) => update.text));
    expect(texts.size).toBe(1);
    const decision = task?.decision?.approved === false ? "Rejected" : "Approved";
    expect([...texts][0]).toBe(`${decision} by Sam on 2026-10-14 10:05 UTC`);
    expect(JSON.stringify(slack.updates.map((update) => update.blocks))).not.toContain(
      "task.approve",
    );
    expect(slack.updates.at(-1)).toMatchObject({ channel: "D-U-eve", ts: "1.0" });
    expect(result?.steps.send?.status).toBe(
      task?.decision?.approved === true ? "done" : "declined",
    );
  });

  test("a click that couldn't reach the automation fails, for the queue to retry, and tells no one", async () => {
    const h = harness();
    const slack = workspace();
    let unreachable = true;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("saved", saved);
        const app = yield* makeAutomation();
        const started = yield* app.start(undefined);
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
        yield* app.callbacks.advance({ executionId });
        const flaky: typeof app = {
          ...app,
          respond: (...args) =>
            unreachable
              ? Effect.sync(() => void (unreachable = false)).pipe(
                  Effect.andThen(
                    Effect.fail(new AutomationError({ message: "Durable Object reset" })),
                  ),
                )
              : app.respond(...args),
        };
        const decide = decideFromSlack(click(started.id, "U-sam", true)).pipe(
          Effect.provideService(Automations, { get: () => flaky }),
          Effect.provideService(SlackWorkspace, slack.service),
        );
        const failed = yield* decide.pipe(Effect.flip);
        const waiting = yield* app.run(started.id);
        yield* decide;
        return { failed, waiting, run: yield* app.run(started.id) };
      }).pipe(Effect.provide(h.layer)),
    );
    expect(result.failed).toMatchObject({ message: "Durable Object reset" });
    expect(result.waiting?.tasks[0]?.status).toBe("open");
    expect(slack.ephemeral).toEqual([]);
    expect(result.run?.tasks[0]?.decision?.approved).toBe(true);
    expect(slack.updates).toHaveLength(1);
  });

  test("a click whose message update failed is retried without deciding again", async () => {
    const h = harness();
    const slack = workspace();
    let failUpdate = true;
    const flaky = SlackWorkspace.of({
      ...slack.service,
      updateMessage: (channel, ts, message) =>
        failUpdate
          ? Effect.sync(() => void (failUpdate = false)).pipe(
              Effect.andThen(Effect.fail(new SlackWorkspaceError({ message: "Slack is down" }))),
            )
          : slack.service.updateMessage(channel, ts, message),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("saved", saved);
        const app = yield* makeAutomation();
        const started = yield* app.start(undefined);
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
        yield* app.callbacks.advance({ executionId });
        const decide = decideFromSlack(click(started.id, "U-sam", true)).pipe(
          Effect.provideService(Automations, { get: () => app }),
          Effect.provideService(SlackWorkspace, flaky),
        );
        const failed = yield* decide.pipe(Effect.flip);
        yield* decide;
        return { failed, run: yield* app.run(started.id) };
      }).pipe(Effect.provide(h.layer)),
    );
    expect(result.failed).toMatchObject({ message: "Slack is down" });
    expect(result.run?.tasks[0]?.decision?.approved).toBe(true);
    expect(h.advances).toHaveLength(2);
    expect(slack.updates.map((update) => update.text.split(" on ")[0])).toEqual([
      "Approved by Sam",
    ]);
    expect(slack.ephemeral).toEqual([]);
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

test("stable entity notification keys deduplicate concurrent delivery and survive reopening and trigger changes", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* h.host.storage.put("saved", {
        ...workflow,
        trigger: { kind: "entity", entity: "person" },
      });
      const app = yield* makeAutomation();
      const subject = {
        type: "person",
        id: "sam",
        data: { name: "Sam Updated", email: "sam@example.com" },
      };
      const delivered = yield* Effect.all(
        [
          app.entityChanged({ name: "Sam" }, subject, "confirmation-1"),
          app.entityChanged({ name: "Sam" }, subject, "confirmation-1"),
        ],
        { concurrency: "unbounded" },
      );
      expect(delivered).toMatchObject([
        { runId: "entity-confirmation-1" },
        { runId: "entity-confirmation-1" },
      ]);
      yield* h.host.storage.put("saved", workflow);
      const reopened = yield* makeAutomation();
      expect(yield* reopened.entityChanged({ name: "Sam" }, subject, "confirmation-1")).toEqual(
        delivered[0],
      );
      yield* h.host.storage.put("saved", {
        ...workflow,
        trigger: { kind: "entity", entity: "person" },
      });
      const first = yield* reopened.entityChanged({ name: "Sam" }, subject);
      const second = yield* reopened.entityChanged({ name: "Sam" }, subject);
      expect(first.runId).not.toBe(second.runId);
      expect((yield* reopened.inspectWorkflow()).runs.length).toBe(3);
    }).pipe(Effect.provide(h.layer)),
  );
});

test("event filters, subjects and ignored receipts survive restart; a matching run emits the original payload once", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const saved: Workflow = {
        name: "Handle a paid order",
        trigger: {
          kind: "event",
          event: "order.paid",
          subject: "person",
          when: { ref: "event.data.total", op: "greaterThan", value: 100 },
        },
        permissions: { "events.emit": "auto" },
        steps: [
          {
            id: "emit",
            title: "Hand off",
            kind: "action",
            use: "events.emit",
            with: { name: "order.fulfilled", data: "{{event.data}}" },
          },
        ],
      };
      yield* h.host.storage.put("draft", saved);
      const app = yield* makeAutomation();
      yield* app.save("orders");
      const subject = { type: "person", id: "sam", data: { name: "Original Sam" } };
      const event: Event = {
        id: "paid-81",
        name: "order.paid",
        data: { total: 137, items: ["book", "pen"] },
        subject,
        depth: 4,
      };
      expect(
        yield* app.eventReceived({ ...event, id: "wrong-name", name: "order.refunded" }),
      ).toEqual({ runId: null });
      expect(
        yield* app.eventReceived({
          ...event,
          id: "wrong-type",
          subject: { ...subject, type: "invoice" },
        }),
      ).toEqual({ runId: null });
      expect(yield* app.eventReceived({ ...event, id: "small", data: { total: 100 } })).toEqual({
        runId: null,
      });
      expect(
        yield* app.eventReceived({
          id: "no-subject",
          name: event.name,
          data: event.data,
          depth: 0,
        }),
      ).toEqual({ runId: null });
      const results = yield* Effect.all([app.eventReceived(event), app.eventReceived(event)], {
        concurrency: "unbounded",
      });
      expect(results).toEqual([
        { runId: RunId.make("event-paid-81") },
        { runId: RunId.make("event-paid-81") },
      ]);
      expect(h.advances).toHaveLength(1);
      yield* (yield* EntityStore).putEntity("person", "sam", { name: "Changed Sam" });
      yield* h.host.storage.delete(`event:${event.id}`);
      const reopened = yield* makeAutomation();
      yield* h.host.storage.put("saved", {
        ...saved,
        trigger: { kind: "event", event: "order.refunded" },
      });
      expect(yield* reopened.eventReceived(event)).toEqual(results[0]);
      expect(h.advances).toHaveLength(1);
      expect(
        yield* reopened.eventReceived({ ...event, id: "wrong-name", name: "order.refunded" }),
      ).toEqual({ runId: null });
      const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
      yield* reopened.callbacks.advance({ executionId });
      yield* reopened.callbacks.advance({ executionId });
      const run = yield* reopened.run(RunId.make("event-paid-81"));
      expect(run?.status).toBe("completed");
      expect(run?.event).toEqual(event);
      expect(run?.subject).toEqual(subject);
      expect(h.emitted).toEqual([
        {
          id: expect.stringMatching(/^action:/),
          name: "order.fulfilled",
          data: event.data,
          subject,
          depth: 5,
        },
      ]);
      expect(run?.steps.emit?.record).toMatchObject({
        eventId: h.emitted[0]?.id,
        name: "order.fulfilled",
      });
    }).pipe(Effect.provide(h.layer)),
  );
});

test("event-only runs need no subject; JSON strings from refs and matched inputs remain values", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* h.host.storage.put("saved", {
        name: "Relay",
        trigger: { kind: "event", event: "message.received" },
        permissions: { "events.emit": "auto" },
        steps: [
          {
            id: "relay",
            title: "Relay",
            kind: "action",
            use: "events.emit",
            with: { name: "message.forwarded" },
            match: {
              on: "event.data",
              cases: [{ when: { op: "equals", value: "hello" }, with: { data: "{{event.data}}" } }],
              otherwise: { with: { data: '"fallback"' } },
            },
          },
        ],
      });
      const app = yield* makeAutomation();
      const result = yield* app.eventReceived({
        id: "message-1",
        name: "message.received",
        data: "hello",
        depth: 0,
      });
      expect(result.runId).toBe(RunId.make("event-message-1"));
      yield* app.start(undefined).pipe(Effect.flip);
      const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
      yield* app.callbacks.advance({ executionId });
      expect(h.emitted[0]).toMatchObject({ name: "message.forwarded", data: "hello", depth: 1 });
      expect((yield* app.run(RunId.make("event-message-1")))?.subject).toBeNull();
      const manual = yield* app.start(undefined, { data: "hello" });
      yield* app.callbacks.advance({
        executionId: yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances.at(-1)),
      });
      expect(h.emitted).toHaveLength(2);
      expect(h.emitted[1]).toMatchObject({ name: "message.forwarded", data: "hello", depth: 1 });
      expect((yield* app.run(manual.id))?.status).toBe("completed");
    }).pipe(Effect.provide(h.layer)),
  );
});

test("manual event runs retain supplied JSON, get fresh IDs, and never publish their input", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* h.host.storage.put("saved", {
        ...workflow,
        trigger: { kind: "event", event: "order.paid" },
      });
      const app = yield* makeAutomation();
      const missing = yield* app.start(undefined).pipe(Effect.flip);
      expect(missing.message).toContain("Supply event data");
      const payloads = [null, false, 17, "hello", [1, "two"], { total: 137 }];
      const ids: Array<string> = [];
      const eventIds: Array<string> = [];
      for (const data of payloads) {
        const started = yield* app.start(undefined, { data });
        ids.push(started.id);
        const run = yield* app.run(started.id);
        expect(run?.event).toMatchObject({ name: "order.paid", data, depth: 0 });
        expect(run?.event?.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(run?.subject).toBeNull();
        if (run?.event === undefined) throw new Error("Run lost its event");
        eventIds.push(run.event.id);
        const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances.at(-1));
        yield* app.callbacks.advance({ executionId });
        expect((yield* app.run(started.id))?.status).toBe("stopped");
      }
      expect(new Set(ids).size).toBe(payloads.length);
      expect(new Set(eventIds).size).toBe(payloads.length);
      expect(h.emitted).toEqual([]);
      expect((yield* h.host.storage.list({ prefix: "event:" })).size).toBe(0);
      const reopened = yield* makeAutomation();
      const first = yield* Schema.decodeUnknownEffect(RunId)(ids[0]);
      expect((yield* reopened.run(first))?.event?.data).toBeNull();
      yield* h.host.storage.put("saved", {
        ...workflow,
        trigger: { kind: "event", event: "order.paid" },
        steps: [
          { id: "old", title: "Retired operation", kind: "action", use: "retired.send", with: {} },
        ],
      });
      const failed = yield* reopened.start(undefined, { data: { total: 99 } });
      expect(failed.status).toBe("failed");
      expect((yield* reopened.run(failed.id))?.event).toMatchObject({
        name: "order.paid",
        data: { total: 99 },
        depth: 0,
      });
    }).pipe(Effect.provide(h.layer)),
  );
});

test("manual event runs require the saved subject and enforce the saved condition", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* h.host.storage.put("saved", {
        ...workflow,
        trigger: {
          kind: "event",
          event: "order.paid",
          subject: "person",
          when: {
            all: [
              { ref: "event.data.total", op: "greaterThan", value: 100 },
              { ref: "person.name", op: "equals", value: "Sam" },
            ],
          },
        },
      });
      const app = yield* makeAutomation();
      expect(
        (yield* app.start(undefined, { data: { total: 137 } }).pipe(Effect.flip)).message,
      ).toContain("Pick the person");
      expect(
        (yield* app.start("missing", { data: { total: 137 } }).pipe(Effect.flip)).message,
      ).toContain("No person missing");
      expect(
        (yield* app.start("sam", { data: { total: 100 } }).pipe(Effect.flip)).message,
      ).toContain("do not match");
      expect((yield* app.start("sam", { data: null }).pipe(Effect.flip)).message).toContain(
        "do not match",
      );
      expect(h.advances).toEqual([]);
      const started = yield* app.start("sam", { data: { total: 101 } });
      const run = yield* app.run(started.id);
      expect(run?.subject).toEqual({
        type: "person",
        id: "sam",
        data: { name: "Sam", email: "sam@example.com" },
      });
      expect(run?.event?.subject).toEqual({
        type: "person",
        id: "sam",
        data: { name: "Sam", email: "sam@example.com" },
      });
      expect(run?.event?.data).toEqual({ total: 101 });
      expect(h.emitted).toEqual([]);
      yield* h.host.storage.put("saved", workflow);
      expect((yield* app.start(undefined, { data: {} }).pipe(Effect.flip)).message).toContain(
        "does not take event data",
      );
    }).pipe(Effect.provide(h.layer)),
  );
});

test("entity triggers retain event depth and cannot restart a bounded event cycle", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* h.host.storage.put("saved", {
        name: "Cycle",
        trigger: { kind: "entity", entity: "person" },
        permissions: { "events.emit": "auto" },
        steps: [
          {
            id: "emit",
            title: "Emit",
            kind: "action",
            use: "events.emit",
            with: { name: "again", data: "{}" },
          },
        ],
      });
      const app = yield* makeAutomation();
      const subject = { type: "person", id: "sam", data: { name: "Sam" } };
      yield* app.entityChanged(undefined, subject, "last-hop", {
        id: "origin",
        name: "entity.put",
        data: {},
        depth: 16,
      });
      const executionId = yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]);
      yield* app.callbacks.advance({ executionId });
      expect(h.emitted).toHaveLength(0);
      expect((yield* app.run(RunId.make("entity-last-hop")))?.status).toBe("failed");
    }).pipe(Effect.provide(h.layer)),
  );
});

test("an entity fact starts an automation which emits an entity command through the shared writer; queue redelivery changes nothing twice", async () => {
  const h = harness();
  const data = new Map<string, Schema.Json>();
  const storage: ChangeStorage = {
    get: (key) => Effect.sync(() => structuredClone(data.get(key))),
    put: (key, value) => Effect.sync(() => void data.set(key, structuredClone(value))),
    list: (prefix) =>
      Effect.sync(() =>
        [...data]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, value]) => structuredClone(value)),
      ),
    transaction: (effect) => effect,
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* h.host.storage.put("saved", {
        name: "Welcome added people",
        trigger: { kind: "event", event: "entity.created", subject: "person" },
        permissions: { "events.emit": "auto" },
        steps: [
          {
            id: "update",
            title: "Record the greeting",
            kind: "action",
            use: "events.emit",
            with: {
              name: "entity.put",
              data: '{"type":"person","id":"sam","data":{"name":"Welcomed {{person.name}}"}}',
            },
          },
        ],
      });
      const app = yield* makeAutomation();
      const index = yield* AutomationIndex;
      const clients = Automations.of({ get: () => app });
      const layers = Layer.mergeAll(
        Layer.succeed(AutomationIndex, {
          ...index,
          list: Effect.succeed([{ id: "welcome", name: "Welcome", updatedAt: 0 }]),
        }),
        Layer.succeed(Automations, clients),
        EntitySubscribers.layer((_id, change, key, event) =>
          app.entityChanged(change.before, change.after, key, event),
        ),
      );
      yield* Effect.gen(function* () {
        const changes = yield* makeChanges(storage, yield* Events);
        const proposal = yield* changes.prepare("owner", {
          kind: "putEntity",
          type: "person",
          id: "ada",
          data: { name: "Ada" },
        });
        yield* changes.decide("owner", proposal.id, true);
        const fact = h.emitted[0];
        if (fact === undefined) return yield* Effect.die("Entity fact not emitted");
        const consume = (event: Event) =>
          deliverEvent(event, (origin, command) =>
            Effect.gen(function* () {
              const owner = `event:${origin.id}`;
              const change = yield* changes.prepare(
                owner,
                { kind: "putEntity", ...command },
                origin.id,
                origin,
              );
              yield* changes.decide(owner, change.id, true);
            }),
          );
        yield* consume(fact);
        yield* consume(fact);
        expect(h.advances).toHaveLength(1);
        yield* app.callbacks.advance({
          executionId: yield* Schema.decodeUnknownEffect(ExecutionId)(h.advances[0]),
        });
        const command = h.emitted[1];
        if (command === undefined) return yield* Effect.die("Entity command not emitted");
        expect(command).toMatchObject({
          name: "entity.put",
          depth: 1,
          data: { type: "person", id: "sam", data: { name: "Welcomed Ada" } },
        });
        yield* consume(command);
        yield* consume(command);
        expect((yield* (yield* EntityStore).getEntity("person", "sam"))?.data).toEqual({
          name: "Welcomed Ada",
          email: "sam@example.com",
        });
        expect(h.emitted).toHaveLength(3);
        expect(h.emitted[2]).toMatchObject({ name: "entity.updated", depth: 2 });
        expect(h.advances).toHaveLength(1);
      }).pipe(Effect.provide(layers));
    }).pipe(Effect.provide(h.layer)),
  );
});
