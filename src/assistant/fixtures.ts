/** Disposable, transactional fixtures for assistant tests and real-tool evals. Never used by hosts. */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { Namer } from "../agents/namer/namer.ts";
import { AutomationIndex } from "../automation/index.ts";
import type { Exchange, PendingChat } from "../automation/model.ts";
import { Automations, type AutomationClient } from "../automation/service.ts";
import { Changes } from "../changes/service.ts";
import type { ChangeAction, ChangeProposal } from "../changes/model.ts";
import { EntityStore, layerMemory } from "../entities/store.ts";
import type { Workflow } from "../workflow/model.ts";
import type { AssistantHost } from "./host.ts";
import { makeAssistantSession } from "./session.ts";
import { AssistantThreads, layerMemory as threadsMemory } from "./threads.ts";

export const fixtureValue = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
};

/** An in-memory host whose transactions roll back storage and scheduled jobs on failure. */
export const memoryAssistantHost = () => {
  let data = new Map<string, unknown>();
  let erased = 0;
  const jobs: Array<{ turnId: string; after?: number }> = [];
  const lock = Semaphore.makeUnsafe(1);
  const host: AssistantHost = {
    storage: {
      get: (key) => Effect.sync(() => structuredClone(data.get(key))),
      put: (key, value) => Effect.sync(() => void data.set(key, structuredClone(value))),
      delete: (key) => Effect.sync(() => data.delete(key)),
      list: ({ prefix }) =>
        Effect.sync(
          () =>
            new Map(
              [...data]
                .filter(([k]) => k.startsWith(prefix))
                .map(([k, v]) => [k, structuredClone(v)]),
            ),
        ),
      transaction: (effect) =>
        lock.withPermit(
          Effect.gen(function* () {
            const before = new Map(data);
            const count = jobs.length;
            const result = yield* Effect.exit(effect);
            if (Exit.isFailure(result)) {
              data = before;
              jobs.length = count;
            }
            return yield* result;
          }),
        ),
    },
    jobs: { reply: (turnId, after) => Effect.sync(() => void jobs.push({ turnId, after })) },
    erase: Effect.sync(() => {
      data = new Map();
      jobs.length = 0;
      erased += 1;
    }),
  };
  return { host, jobs, erasures: () => erased };
};

export const assistantFixture = Effect.gen(function* () {
  const { host, jobs, erasures } = memoryAssistantHost();
  const entities = yield* Effect.service(EntityStore).pipe(
    Effect.provide(
      layerMemory({
        types: [
          {
            name: "employee",
            label: "Employee",
            title: "name",
            fields: [
              { name: "name", label: "Name", type: "text" },
              { name: "email", label: "Email", type: "text" },
            ],
          },
        ],
      }),
    ),
  );
  const proposals = new Map<string, ChangeProposal>();
  const decisions = new Map<string, { status: "applied" | "cancelled"; result: null }>();
  const mutations: Array<ChangeAction> = [];
  const changes = Changes.of({
    prepare: (_owner, action, requestId) =>
      Effect.sync(() => {
        const id = requestId ?? crypto.randomUUID();
        const proposal = proposals.get(id) ?? {
          id,
          action,
          title: `Review ${action.kind}`,
          details: [],
          consequences: [],
          confirmLabel: "Apply",
        };
        proposals.set(id, proposal);
        return proposal;
      }),
    decide: (_owner, id, approved) =>
      Effect.gen(function* () {
        const previous = decisions.get(id);
        if (previous !== undefined) return previous;
        const action = fixtureValue(proposals.get(id)).action;
        if (approved) {
          switch (action.kind) {
            case "putTemplate":
              yield* entities.putTemplate(action.template);
              break;
            case "putType":
              yield* entities.putType(action.type);
              break;
            case "putEntity":
              yield* entities.putEntity(action.type, action.id, action.data);
              break;
            case "deleteTemplate":
              yield* entities.deleteTemplate(action.name);
              break;
            case "deleteType":
              yield* entities.deleteType(action.name);
              break;
            case "deleteEntity":
              yield* entities.deleteEntity(action.type, action.id);
              break;
          }
          mutations.push(action);
        }
        const decision = {
          status: approved ? ("applied" as const) : ("cancelled" as const),
          result: null,
        };
        decisions.set(id, decision);
        return decision;
      }),
  });
  const directory = new Map<string, string>();
  const submissions: Array<{ id: string; description: string; requestId: string }> = [];
  const drafts = new Map<string, Workflow>();
  const conversations = new Map<string, ReadonlyArray<Exchange>>();
  const pending = new Map<string, PendingChat>();
  const submitted = new Set<string>();
  const stoppedChats: Array<string> = [];
  // Runs inside the planner's `chat`, before it accepts the message, to interleave other work.
  let beforeChat: Effect.Effect<unknown, unknown, never> = Effect.void;
  const forbidden = () => Effect.die("Assistant must not save, run, or change permissions");
  const client = (id: string): AutomationClient => ({
    inspectWorkflow: () =>
      Effect.sync(() => ({
        draft: drafts.get(id),
        saved: undefined,
        pendingChat: pending.get(id),
        progress: undefined,
        conversation: conversations.get(id) ?? [],
        runs: [],
      })),
    chat: (_id, description, requestId) =>
      Effect.suspend(() => beforeChat).pipe(
        Effect.orDie,
        Effect.map(() => {
          const key = requestId ?? crypto.randomUUID();
          if (!submitted.has(key)) {
            submitted.add(key);
            submissions.push({ id, description, requestId: key });
            pending.set(id, { id: key, prompt: description, status: "working" });
          }
          return { pendingChat: fixtureValue(pending.get(id)) };
        }),
      ),
    answer: (_id, chatId, _given) =>
      Effect.sync(() => {
        const current = fixtureValue(pending.get(id));
        if (current.id !== chatId || current.status !== "asking")
          throw new Error("Stale planner answer");
        const next: PendingChat = { id: chatId, prompt: current.prompt, status: "working" };
        pending.set(id, next);
        return { pendingChat: next };
      }),
    stopChat: (chatId) =>
      Effect.sync(() => {
        stoppedChats.push(chatId);
        const current = pending.get(id);
        if (current?.id === chatId && current.status !== "failed")
          pending.set(id, {
            id: chatId,
            prompt: current.prompt,
            status: "failed",
            error: "Stopped",
          });
        return { pendingChat: pending.get(id) };
      }),
    overview: () => Effect.succeed({ activeRuns: [] }),
    templateUses: () => Effect.succeed({ saved: [], draft: [] }),
    save: forbidden,
    start: forbidden,
    setPermissions: forbidden,
    setDraft: forbidden,
    remove: forbidden,
    entityChanged: forbidden,
    eventReceived: forbidden,
    respond: forbidden,
    resumeNow: forbidden,
    run: forbidden,
    plannerTrace: forbidden,
    runTrace: forbidden,
  });
  const threads = yield* Effect.service(AssistantThreads).pipe(Effect.provide(threadsMemory));
  const titles: Array<string> = [];
  const services = Layer.mergeAll(
    Layer.succeed(AssistantThreads, threads),
    Layer.succeed(Namer, {
      complete: (request) =>
        Effect.sync(() => {
          const content = request.messages.at(-1)?.content ?? "";
          titles.push(content);
          return "Fixture thread";
        }),
    }),
    Layer.succeed(EntityStore, entities),
    Layer.succeed(Changes, changes),
    Layer.succeed(Automations, { get: client }),
    Layer.succeed(AutomationIndex, {
      list: Effect.sync(() => [...directory].map(([id, name]) => ({ id, name, updatedAt: 0 }))),
      create: (id, name) =>
        Effect.sync(() => {
          if (directory.has(id)) return false;
          directory.set(id, name);
          return true;
        }),
      record: (id, name) => Effect.sync(() => void directory.set(id, name)),
      recordIfMissing: (id, name) =>
        Effect.sync(() => {
          if (!directory.has(id)) directory.set(id, name);
        }),
      remove: (id) => Effect.sync(() => void directory.delete(id)),
    }),
  );
  const sessionId = "11111111-1111-1111-1111-111111111111";
  const open = (owner = "person@example.com") =>
    makeAssistantSession({ owner, sessionId, host }).pipe(Effect.provide(services));
  return {
    open,
    host,
    jobs,
    entities,
    mutations,
    proposals,
    submissions,
    pending,
    drafts,
    conversations,
    directory,
    sessionId,
    threads,
    titles,
    stoppedChats,
    erasures,
    beforeChat: (effect: Effect.Effect<unknown, unknown, never>) =>
      Effect.sync(() => {
        beforeChat = effect;
      }),
  };
});
