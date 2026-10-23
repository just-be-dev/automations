/** Exercises the studio's MCP server: stateless negotiation, the tools over memory services, and the `mcp` RPC's identity. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Namer } from "../agents/namer/namer.ts";
import { AutomationIndex } from "../automation/index.ts";
import type { Exchange, PendingChat } from "../automation/model.ts";
import { type AutomationClient, Automations } from "../automation/service.ts";
import { makeChanges } from "../changes/application.ts";
import type { ChangeProposal } from "../changes/model.ts";
import { Changes } from "../changes/service.ts";
import { layerMemory } from "../entities/memory.ts";
import type { EntityType } from "../entities/model.ts";
import type { Workflow } from "../workflow/model.ts";
import { type Run, RunId } from "../workflow/run.ts";
import { PlannerWait } from "./automation-mcp.ts";
import { mcpCaller, McpCaller } from "./mcp-caller.ts";
import { answerMcp, handleMcp, StudioToolHandlers } from "./mcp-server.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "start_date", label: "Start date", type: "date" },
    { name: "email", label: "Email", type: "text" },
  ],
};

const unused = () => Effect.die("Unexpected operation");

const draft: Workflow = {
  name: "Welcome new hires",
  trigger: { kind: "entity", entity: "employee" },
  steps: [{ id: "stop", title: "Stop", kind: "stop", reason: "Done" }],
};

const run: Run = {
  id: "run-1",
  workflow: draft,
  subject: { type: "employee", id: "ada", data: { name: "Ada" } },
  status: "waiting",
  steps: { stop: { status: "waiting" } },
  tasks: [
    {
      step: "stop",
      token: "secret-token",
      title: "Approve",
      prompt: "Approve Ada?",
      assignee: null,
      response: { fields: [] },
      defaults: {},
      status: "open",
    },
  ],
  startedAt: 1,
};

/**
 * Automations whose planner answers a message after `delay` reads of its state, and asks the
 * questions in `asks` first when there are any.
 */
const fakeAutomations = () => {
  const directory = new Map<string, string>([["welcome", "Welcome new hires"]]);
  const drafts = new Map<string, Workflow>([["welcome", draft]]);
  const saved = new Map<string, Workflow>();
  const conversations = new Map<string, Array<Exchange>>();
  const pending = new Map<string, PendingChat>();
  const countdown = new Map<string, number>();
  const chats: Array<{ id: string; message: string; requestId: string | undefined }> = [];
  const answers: Array<{ id: string; chatId: string; text: string }> = [];
  const settings = { delay: 2, asks: false };
  const reply = (id: string) => {
    const current = pending.get(id);
    if (current === undefined || current.status !== "working") return;
    const left = (countdown.get(id) ?? 0) - 1;
    countdown.set(id, left);
    if (left > 0) return;
    if (settings.asks) {
      settings.asks = false;
      pending.set(id, {
        id: current.id,
        prompt: current.prompt,
        status: "asking",
        questions: [
          {
            question: "Who approves?",
            header: "Approver",
            options: [{ label: "Manager" }, { label: "HR" }],
          },
        ],
      });
      return;
    }
    pending.delete(id);
    drafts.set(id, { ...(drafts.get(id) ?? draft), name: current.prompt.slice(0, 40) });
    conversations.set(id, [
      ...(conversations.get(id) ?? []),
      { prompt: current.prompt, reply: `Drafted: ${current.prompt}` },
    ]);
  };
  const client = (id: string): AutomationClient => ({
    inspectWorkflow: () =>
      Effect.sync(() => {
        reply(id);
        return {
          draft: drafts.get(id),
          saved: saved.get(id),
          conversation: conversations.get(id) ?? [],
          pendingChat: pending.get(id),
          progress: pending.get(id)?.status === "working" ? "Reading your request…" : undefined,
          runs:
            id === "welcome"
              ? [{ id: "run-1", status: "waiting", startedAt: 1, subject: "Ada", openTasks: 1 }]
              : [],
        };
      }),
    chat: (_id, message, requestId) =>
      Effect.sync(() => {
        chats.push({ id, message, requestId });
        const next: PendingChat = {
          id: requestId ?? crypto.randomUUID(),
          prompt: message,
          status: "working",
        };
        pending.set(id, next);
        countdown.set(id, settings.delay);
        return { pendingChat: next };
      }),
    answer: (_id, chatId, given) =>
      Effect.sync(() => {
        const current = pending.get(id);
        if (current?.status !== "asking" || current.id !== chatId) throw new Error("Not asking");
        answers.push({ id, chatId, text: given.kind === "message" ? given.text : "" });
        const next: PendingChat = { id: chatId, prompt: current.prompt, status: "working" };
        pending.set(id, next);
        countdown.set(id, settings.delay);
        return { pendingChat: next };
      }),
    overview: () =>
      Effect.succeed(
        id === "welcome"
          ? { saved: { trigger: draft.trigger }, activeRuns: [] }
          : { activeRuns: [] },
      ),
    run: (runId) =>
      Effect.succeed(
        id === "welcome" && runId === "run-1"
          ? { ...run, id: RunId.make("run-1"), subjectTitle: "Ada", resumesAt: {} }
          : undefined,
      ),
    templateUses: () => Effect.succeed({ saved: [], draft: [] }),
    stopChat: unused,
    save: unused,
    start: unused,
    setPermissions: unused,
    setDraft: unused,
    remove: unused,
    entityChanged: unused,
    eventReceived: unused,
    respond: unused,
    resumeNow: unused,
    plannerTrace: unused,
    runTrace: unused,
  });
  const layer = Layer.mergeAll(
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
      recordIfMissing: unused,
      remove: unused,
    }),
    Layer.succeed(Namer, { complete: () => Effect.succeed("Chase invoices") }),
  );
  return { layer, chats, answers, settings, directory, pending, saved };
};

const memoryChanges = Layer.effect(
  Changes,
  Effect.suspend(() => {
    const data = new Map<string, unknown>();
    return makeChanges({
      get: (key) => Effect.sync(() => data.get(key)),
      put: (key, value) => Effect.sync(() => void data.set(key, value)),
      list: (prefix) =>
        Effect.sync(() =>
          [...data].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value),
        ),
      transaction: (effect) => effect,
    });
  }),
);

/** The tools' services, fresh for each test: memory entities, real changes, fake automations. */
const studio = () => {
  const automations = fakeAutomations();
  const base = Layer.mergeAll(
    layerMemory({
      types: [employee],
      entities: [
        { type: "employee", id: "ada", data: { name: "Ada" } },
        { type: "employee", id: "sam", data: { name: "Sam", email: "sam@example.com" } },
      ],
    }),
    automations.layer,
  );
  const services = memoryChanges.pipe(Layer.provideMerge(base));
  return { services, automations };
};

type Answer = {
  readonly result: {
    readonly isError: boolean;
    readonly content: ReadonlyArray<{ readonly text: string }>;
    readonly structuredContent: Record<string, unknown>;
  };
};

const fastPlanner = { totalMillis: 50, pollMillis: 1 };

/** Runs a script against one studio, calling tools over HTTP's path as `owner`. */
const withStudio = <A>(
  script: (tools: {
    readonly answer: (message: unknown) => Effect.Effect<unknown>;
    readonly call: (name: string, args: unknown) => Effect.Effect<Answer>;
    readonly rpc: (
      body: unknown,
      headers?: Readonly<Record<string, string>>,
    ) => Effect.Effect<{ status: number; body: unknown }>;
    readonly changes: typeof Changes.Service;
    readonly automations: ReturnType<typeof fakeAutomations>;
  }) => Effect.Effect<A, unknown, never>,
  owner: string | undefined = "person@example.com",
) => {
  const { services, automations } = studio();
  return Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Effect.context<Layer.Success<typeof services>>();
      const answer = (message: unknown) =>
        answerMcp(message).pipe(
          Effect.provide(StudioToolHandlers),
          Effect.provideService(McpCaller, mcpCaller(owner)),
          Effect.provideContext(context),
          Effect.provideService(PlannerWait, fastPlanner),
          Effect.orDie,
        );
      const call = (name: string, args: unknown) =>
        answer({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }) as Effect.Effect<Answer>;
      const rpc = (body: unknown, headers: Readonly<Record<string, string>> = {}) =>
        handleMcp(body, headers).pipe(
          Effect.provideContext(context),
          Effect.provideService(PlannerWait, fastPlanner),
          Effect.orDie,
        );
      return yield* script({ answer, call, rpc, changes: yield* Changes, automations });
    }).pipe(Effect.provide(services)),
  );
};

describe("the studio's MCP server", () => {
  test("initializes without a session, negotiating a revision it speaks", () =>
    withStudio(({ answer }) =>
      Effect.gen(function* () {
        expect(
          yield* answer({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
          }),
        ).toMatchObject({
          id: 1,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
        });
        expect(
          yield* answer({
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: { protocolVersion: "2099-01-01" },
          }),
        ).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
        expect(
          yield* answer({ jsonrpc: "2.0", method: "notifications/initialized" }),
        ).toBeUndefined();
      }),
    ));

  test("lists every tool, marking exactly the ones that only read", () =>
    withStudio(({ answer }) =>
      Effect.gen(function* () {
        const listed = (yield* answer({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
          result: { tools: ReadonlyArray<Record<string, unknown>> };
        };
        const tools = listed.result.tools;
        const readOnly = (tool: Record<string, unknown>) =>
          (tool.annotations as { readOnlyHint: boolean }).readOnlyHint;
        expect(tools.filter(readOnly).map((tool) => tool.name)).toEqual([
          "list_entity_types",
          "list_entities",
          "get_entity",
          "list_templates",
          "preview_change",
          "list_automations",
          "get_automation",
          "get_run",
        ]);
        expect(tools.filter((tool) => !readOnly(tool)).map((tool) => tool.name)).toEqual([
          "define_entity_type",
          "delete_entity_type",
          "put_entity",
          "delete_entity",
          "put_template",
          "delete_template",
          "decide_change",
          "create_automation",
          "draft_automation",
        ]);
        for (const tool of tools) {
          expect((tool.inputSchema as { type?: string }).type).toBe("object");
          expect((tool.outputSchema as { type?: string }).type).toBe("object");
        }
        expect(tools.find((tool) => tool.name === "delete_entity")?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
        });
      }),
    ));

  test("answers unknown methods and malformed messages with JSON-RPC errors", () =>
    withStudio(({ answer }) =>
      Effect.gen(function* () {
        expect(yield* answer({ jsonrpc: "2.0", id: 7, method: "resources/list" })).toMatchObject({
          id: 7,
          error: { code: -32601 },
        });
        expect(yield* answer([{ jsonrpc: "2.0", id: 1, method: "ping" }])).toMatchObject({
          id: null,
          error: { code: -32600 },
        });
      }),
    ));
});

describe("catalog tools", () => {
  test("report store and argument problems as tool errors", () =>
    withStudio(({ call }) =>
      Effect.gen(function* () {
        expect(
          yield* call("put_entity", { type: "employee", id: "ada", data: { start_date: "soon" } }),
        ).toMatchObject({
          result: { isError: true, content: [{ text: "employee.start_date must be a date" }] },
        });
        expect(yield* call("get_entity", { type: "employee", id: "grace" })).toMatchObject({
          result: { isError: true, content: [{ text: "No employee with ID grace" }] },
        });
        expect(yield* call("get_entity", { type: "Employee" })).toMatchObject({
          result: { isError: true },
        });
      }),
    ));

  test("preview a change without preparing it, then apply it in one call", () =>
    withStudio(({ call, changes }) =>
      Effect.gen(function* () {
        const change = { type: "employee", id: "ada", data: { start_date: "2026-11-02" } };
        const preview = yield* call("preview_change", { change: { kind: "putEntity", ...change } });
        expect(preview.result.structuredContent).toEqual({
          title: "Save employee ada",
          details: [{ label: "start_date", before: "Not set", after: "2026-11-02" }],
          consequences: expect.arrayContaining([expect.stringContaining("saved automations")]),
        });
        expect(yield* call("get_entity", { type: "employee", id: "ada" })).toMatchObject({
          result: { structuredContent: { entity: { data: { name: "Ada" } } } },
        });
        const applied = yield* call("put_entity", change);
        expect(applied.result).toMatchObject({
          isError: false,
          structuredContent: {
            status: "applied",
            // The preview prepared nothing: this is the first proposal.
            proposalId: "change-1",
            title: "Save employee ada",
            details: [{ label: "start_date", before: "Not set", after: "2026-11-02" }],
            result: { entity: { data: { name: "Ada", start_date: "2026-11-02" } } },
          },
        });
        expect(yield* call("get_entity", { type: "employee", id: "ada" })).toMatchObject({
          result: { structuredContent: { entity: { data: { start_date: "2026-11-02" } } } },
        });
        // Nothing waits for a decision: the proposal is already settled.
        expect(yield* changes.decide("person@example.com", "change-1", false)).toMatchObject({
          status: "applied",
        });
      }),
    ));

  test("a repeated requestId returns the first call's outcome without writing again", () =>
    withStudio(({ call }) =>
      Effect.gen(function* () {
        const first = yield* call("put_entity", {
          type: "employee",
          id: "ada",
          data: { name: "Ada Lovelace" },
          requestId: "retry-1",
        });
        const again = yield* call("put_entity", {
          type: "employee",
          id: "ada",
          data: { name: "Ada Lovelace" },
          requestId: "retry-1",
        });
        expect(again).toEqual(first);
        expect(
          (yield* call("put_entity", { type: "employee", id: "ada", data: { name: "Ada L." } }))
            .result.structuredContent,
        ).toMatchObject({ status: "applied", proposalId: "change-2" });
      }),
    ));

  test("writes and deletes types, templates and entities", () =>
    withStudio(({ call }) =>
      Effect.gen(function* () {
        const template = {
          name: "welcome_email",
          label: "Welcome email",
          description: "Greets a new hire on their first day",
          slots: [{ name: "name", label: "Name", type: "text" }],
          content: { subject: "Welcome, {{name}}", body: "Glad you're here." },
        };
        expect(yield* call("put_template", { template })).toMatchObject({
          result: { isError: false, structuredContent: { status: "applied" } },
        });
        expect(yield* call("list_templates", {})).toMatchObject({
          result: { structuredContent: { templates: [{ name: "welcome_email" }] } },
        });
        expect(yield* call("delete_template", { name: "welcome_email" })).toMatchObject({
          result: {
            structuredContent: { status: "applied", result: { deleted: "welcome_email" } },
          },
        });
        expect(yield* call("delete_entity", { type: "employee", id: "sam" })).toMatchObject({
          result: { structuredContent: { status: "applied" } },
        });
        const office: EntityType = {
          name: "office",
          label: "Office",
          title: "city",
          fields: [{ name: "city", label: "City", type: "text" }],
        };
        expect(yield* call("define_entity_type", { type: office })).toMatchObject({
          result: { structuredContent: { status: "applied" } },
        });
        expect(yield* call("delete_entity_type", { type: "office" })).toMatchObject({
          result: { structuredContent: { status: "applied" } },
        });
        expect(yield* call("list_entity_types", {})).toMatchObject({
          result: { structuredContent: { types: [{ name: "employee" }] } },
        });
      }),
    ));

  test("decide_change settles a proposal prepared elsewhere for the same person, once", () =>
    withStudio(({ call, changes }) =>
      Effect.gen(function* () {
        const proposal = yield* changes.prepare("person@example.com", {
          kind: "deleteEntity",
          type: "employee",
          id: "ada",
        });
        const cancelled = yield* call("decide_change", {
          proposalId: proposal.id,
          approved: false,
        });
        expect(cancelled.result.structuredContent).toEqual({ status: "cancelled", result: null });
        expect(yield* call("decide_change", { proposalId: proposal.id, approved: true })).toEqual(
          cancelled,
        );
        const someoneElses = yield* changes.prepare("other@example.com", {
          kind: "deleteEntity",
          type: "employee",
          id: "ada",
        });
        expect(
          yield* call("decide_change", { proposalId: someoneElses.id, approved: true }),
        ).toMatchObject({ result: { isError: true, content: [{ text: "Proposal not found" }] } });
      }),
    ));
});

describe("a write the coordinator refuses when it applies", () => {
  const proposal: ChangeProposal = {
    id: "change-9",
    action: { kind: "deleteEntity", type: "employee", id: "ada" },
    title: "Delete employee ada",
    details: [],
    consequences: [],
    confirmLabel: "Delete",
  };
  const scripted = (withdrawn: "cancelled" | "applied") => {
    const decisions: Array<boolean> = [];
    const changes = Changes.of({
      preview: unused,
      prepare: () => Effect.succeed(proposal),
      decide: (_owner, _id, approved) =>
        Effect.suspend(() => {
          decisions.push(approved);
          return approved
            ? Effect.fail({ message: "entity-store refused: ada is linked" })
            : Effect.succeed({ status: withdrawn, result: null });
        }),
    });
    const run = Effect.gen(function* () {
      return (yield* answerMcp({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "delete_entity", arguments: { type: "employee", id: "ada" } },
      })) as Answer;
    }).pipe(
      Effect.provide(StudioToolHandlers),
      Effect.provideService(McpCaller, mcpCaller("person@example.com")),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Changes, changes),
          layerMemory({ types: [employee] }),
          fakeAutomations().layer,
        ),
      ),
    );
    return { decisions, run };
  };

  test("is cancelled, so nothing waits for a decision, and says why", async () => {
    const { decisions, run } = scripted("cancelled");
    expect(await Effect.runPromise(run)).toMatchObject({
      result: { isError: true, content: [{ text: "entity-store refused: ada is linked" }] },
    });
    expect(decisions).toEqual([true, false]);
  });

  test("reports one that landed after all as applied", async () => {
    const { run } = scripted("applied");
    expect(await Effect.runPromise(run)).toMatchObject({
      result: { isError: false, structuredContent: { status: "applied", proposalId: "change-9" } },
    });
  });
});

describe("automation tools", () => {
  test("list automations, and read one with its planner, conversation and runs", () =>
    withStudio(({ call }) =>
      Effect.gen(function* () {
        expect(yield* call("list_automations", {})).toMatchObject({
          result: {
            structuredContent: {
              automations: [{ id: "welcome", name: "Welcome new hires", activeRuns: [] }],
            },
          },
        });
        const read = yield* call("get_automation", { automationId: "welcome" });
        expect(read.result.structuredContent).toMatchObject({
          automationId: "welcome",
          name: "Welcome new hires",
          studioPath: "/?automation=welcome",
          status: "unsaved",
          planner: { status: "idle" },
          runs: [{ id: "run-1", openTasks: 1 }],
        });
        expect(read.result.structuredContent["draft"]).toContain("name: Welcome new hires");
        expect(yield* call("get_automation", { automationId: "missing" })).toMatchObject({
          result: {
            isError: true,
            content: [{ text: expect.stringContaining("create_automation") }],
          },
        });
      }),
    ));

  test("read a run's steps and tasks without the token that answers them", () =>
    withStudio(({ call }) =>
      Effect.gen(function* () {
        const read = yield* call("get_run", { automationId: "welcome", runId: "run-1" });
        expect(read.result.structuredContent).toMatchObject({
          id: "run-1",
          status: "waiting",
          workflow: "Welcome new hires",
          subjectTitle: "Ada",
          tasks: [{ step: "stop", prompt: "Approve Ada?", status: "open" }],
          studioPath: "/?automation=welcome&run=run-1",
        });
        expect(JSON.stringify(read)).not.toContain("secret-token");
        expect(yield* call("get_run", { automationId: "welcome", runId: "run-2" })).toMatchObject({
          result: { isError: true },
        });
      }),
    ));

  test("create an automation and wait for the planner's draft", () =>
    withStudio(({ call, automations }) =>
      Effect.gen(function* () {
        const created = yield* call("create_automation", {
          description: "Chase unpaid invoices every Monday",
        });
        expect(created.result.structuredContent).toMatchObject({
          automationId: "chase-invoices",
          name: "Chase invoices",
          studioPath: "/?automation=chase-invoices",
          planner: { status: "idle", reply: "Drafted: Chase unpaid invoices every Monday" },
        });
        expect(automations.directory.get("chase-invoices")).toBe("Chase invoices");
        expect(automations.chats).toMatchObject([
          { id: "chase-invoices", message: "Chase unpaid invoices every Monday" },
        ]);
      }),
    ));

  test("change a draft under a stable request ID, and relay the planner's questions and answers", () =>
    withStudio(({ call, automations }) =>
      Effect.gen(function* () {
        automations.settings.asks = true;
        const asked = yield* call("draft_automation", {
          automationId: "welcome",
          message: "Add an approval",
          requestId: "r1",
        });
        expect(asked.result.structuredContent).toMatchObject({
          planner: { status: "asking", questions: [{ question: "Who approves?" }] },
        });
        expect(automations.chats).toEqual([
          { id: "welcome", message: "Add an approval", requestId: "mcp:r1" },
        ]);
        const answered = yield* call("draft_automation", {
          automationId: "welcome",
          message: "Their manager",
        });
        expect(automations.answers).toEqual([
          { id: "welcome", chatId: "mcp:r1", text: "Their manager" },
        ]);
        expect(automations.chats).toHaveLength(1);
        expect(answered.result.structuredContent).toMatchObject({
          planner: { status: "idle", reply: "Drafted: Add an approval" },
        });
      }),
    ));

  test("answer 'working' when the planner takes longer than the wait", () =>
    withStudio(({ call, automations }) =>
      Effect.gen(function* () {
        automations.settings.delay = 1_000_000;
        const sent = yield* call("draft_automation", {
          automationId: "welcome",
          message: "Add a wait",
        });
        expect(sent.result.structuredContent).toMatchObject({
          planner: { status: "working", message: "Add a wait", progress: "Reading your request…" },
        });
      }),
    ));
});

describe("the mcp RPC", () => {
  test("answers tools/list and reads without initialize or a person, and notifications with 202", () =>
    withStudio(
      ({ rpc }) =>
        Effect.gen(function* () {
          const listed = yield* rpc(
            { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
            { "mcp-protocol-version": "2025-06-18" },
          );
          expect(listed.status).toBe(200);
          expect(listed.body).toMatchObject({ id: 1, result: { tools: expect.any(Array) } });
          expect(
            yield* rpc({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "get_entity", arguments: { type: "employee", id: "ada" } },
            }),
          ).toMatchObject({
            status: 200,
            body: { result: { structuredContent: { entity: { id: "ada" } } } },
          });
          expect(yield* rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({
            status: 202,
            body: undefined,
          });
        }),
      // The HTTP caller is irrelevant here: the RPC names its own.
      undefined,
    ));

  test("acts for the person the header names, and changes nothing for no one", () =>
    withStudio(({ rpc, changes, automations }) =>
      Effect.gen(function* () {
        const put = {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "put_entity",
            arguments: { type: "employee", id: "ada", data: { name: "Ada Lovelace" } },
          },
        };
        const nobody: ReadonlyArray<Readonly<Record<string, string>>> = [
          {},
          { "cf-access-authenticated-user-email": " " },
        ];
        for (const headers of nobody) {
          expect(yield* rpc(put, headers)).toMatchObject({
            status: 200,
            body: {
              result: {
                isError: true,
                content: [{ text: expect.stringContaining("acts for no one") }],
              },
            },
          });
        }
        expect(
          yield* rpc({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "draft_automation",
              arguments: { automationId: "welcome", message: "Hi" },
            },
          }),
        ).toMatchObject({ body: { result: { isError: true } } });
        expect(automations.chats).toEqual([]);

        const applied = yield* rpc(put, {
          "cf-access-authenticated-user-email": "ada@just-be.dev",
        });
        expect(applied.body).toMatchObject({
          result: {
            isError: false,
            structuredContent: { status: "applied", proposalId: "change-1" },
          },
        });
        // The proposal belongs to that person and no one else.
        expect(yield* changes.decide("ada@just-be.dev", "change-1", false)).toMatchObject({
          status: "applied",
        });
        expect(
          yield* changes.decide("person@example.com", "change-1", false).pipe(Effect.flip),
        ).toMatchObject({ message: "Proposal not found" });
      }),
    ));
});
