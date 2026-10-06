import { describe, expect, expectTypeOf, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { makeAutomation } from "./application.ts";
import { AutomationHost } from "./host.ts";
import { AutomationIndex, AutomationIndexError } from "./index.ts";
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
            const result = yield* Effect.exit(effect);
            if (Exit.isFailure(result)) {
              data = before;
              replies.length = counts[0];
              advances.length = counts[1];
              clocks.length = counts[2];
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
    },
  });
  const layer = Layer.mergeAll(
    Layer.succeed(AutomationHost, host),
    Layer.succeed(
      PiAgent,
      PiAgent.of({
        createConversation: Effect.succeed(7),
        instruct: () => Effect.void,
        liveAnswer: Effect.succeed(undefined),
        prompt: (options) =>
          Effect.sync(() => {
            prompts.push(options);
            return JSON.stringify({
              reply: "Designed",
              workflow: { ...workflow, name: "New draft" },
            });
          }),
      }),
    ),
    Layer.succeed(
      ProgressClassifier,
      ProgressClassifier.of({ classify: () => Effect.die("No reasoning to classify") }),
    ),
    Layer.succeed(
      AutomationIndex,
      AutomationIndex.of({
        list: Effect.succeed([]),
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
  );
  return {
    host,
    layer,
    replies,
    advances,
    clocks,
    prompts,
    recorded,
    failSchedule: () => {
      failSchedule = true;
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
    expect(h.prompts[0]).toMatchObject({
      requestId: `chat:${result.pendingChat.id}`,
      text: "  Keep my wording  ",
    });
    expect(h.recorded).toEqual([{ id: "a1", name: "New draft" }]);
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
