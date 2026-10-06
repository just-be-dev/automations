/** Exercises stateless MCP negotiation and tools over the entity store, including persisted role writes. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { EntityType } from "../entities/model.ts";
import { answerMcp, EntityToolHandlers } from "./entity-mcp.ts";
import { EntitySubscribers } from "../entities/subscribers.ts";
import { layerMemory } from "../entities/store.ts";
import { Changes } from "../changes/service.ts";
import { makeChanges } from "../changes/application.ts";
import { AutomationIndex } from "../automation/index.ts";
import { Automations } from "../automation/service.ts";
import { RequestIdentity } from "./identity.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "start_date", label: "Start date", type: "date" },
  ],
};

const person: EntityType = {
  name: "person",
  label: "Person",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "text" },
  ],
};

const services = Layer.mergeAll(
  layerMemory({
    types: [employee, person],
    entities: [
      { type: "employee", id: "ada", data: { name: "Ada" }, updatedAt: 0 },
      {
        type: "person",
        id: "sam",
        data: { name: "Sam", email: "sam@example.com" },
        updatedAt: 0,
      },
    ],
  }),
  Layer.succeed(EntitySubscribers, {
    notify: (change) =>
      Effect.succeed([
        { automation: `watching-${change.after.type}`, runId: "run-1", error: null },
      ]),
  }),
  Layer.succeed(RequestIdentity, { email: undefined }),
  Layer.succeed(AutomationIndex, {
    list: Effect.succeed([]),
    create: () => Effect.succeed(true),
    record: () => Effect.void,
    recordIfMissing: () => Effect.void,
  }),
  Layer.succeed(Automations, {
    get: () => {
      throw new Error("No automations listed");
    },
  }),
);
const handlers = EntityToolHandlers.pipe(
  Layer.provide(
    Layer.effect(
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
    ).pipe(Layer.provideMerge(services)),
  ),
);

const answer = (message: unknown) =>
  Effect.runPromise(answerMcp(message).pipe(Effect.provide(handlers)));

const call = (name: string, args: unknown) =>
  answer({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("entity store MCP", () => {
  test("initializes without a session, negotiating a revision it speaks", async () => {
    expect(
      await answer({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } },
      }),
    ).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
    });
    expect(
      await answer({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2099-01-01" },
      }),
    ).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    expect(await answer({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  });

  test("lists the tools with object input schemas", async () => {
    const listed = await answer({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (listed as { result: { tools: ReadonlyArray<Record<string, unknown>> } }).result
      .tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_entity_types",
      "define_entity_type",
      "delete_entity_type",
      "list_entities",
      "get_entity",
      "put_entity",
      "delete_entity",
      "list_roles",
      "define_role",
      "decide_change",
    ]);
    expect(tools.every((tool) => (tool.inputSchema as { type?: string }).type === "object")).toBe(
      true,
    );
    expect(tools.find((tool) => tool.name === "delete_entity")?.annotations).toMatchObject({
      destructiveHint: true,
    });
  });

  test("proposes an entity write without claiming that runs have started", async () => {
    expect(
      await call("put_entity", { type: "employee", id: "ada", data: { start_date: "2026-11-02" } }),
    ).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          action: {
            kind: "putEntity",
            type: "employee",
            id: "ada",
            data: { start_date: "2026-11-02" },
          },
          details: [{ label: "start_date", before: "Not set", after: "2026-11-02" }],
        },
      },
    });
  });

  test("defines and lists roles, whose members must have an email", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const call = (name: string, args: unknown) =>
          answerMcp({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          });
        const ops = { name: "ops", label: "Ops", members: [{ type: "person", id: "sam" }] };
        expect(yield* call("define_role", { role: ops })).toMatchObject({
          result: { isError: false, structuredContent: { role: ops } },
        });
        expect(
          yield* call("define_role", {
            role: { ...ops, members: [{ type: "employee", id: "ada" }] },
          }),
        ).toMatchObject({
          result: {
            isError: true,
            content: [{ text: "employee has no email field, so it can't be a member" }],
          },
        });
        expect(yield* call("list_roles", {})).toMatchObject({
          result: { isError: false, structuredContent: { roles: [ops] } },
        });
      }).pipe(Effect.provide(handlers)),
    );
  });

  test("reports store and argument problems as tool errors", async () => {
    expect(
      await call("put_entity", { type: "employee", id: "ada", data: { start_date: "soon" } }),
    ).toMatchObject({
      result: { isError: true, content: [{ text: "employee.start_date must be a date" }] },
    });
    expect(await call("get_entity", { type: "employee", id: "grace" })).toMatchObject({
      result: { isError: true, content: [{ text: "No employee with ID grace" }] },
    });
    expect(await call("get_entity", { type: "Employee" })).toMatchObject({
      result: { isError: true },
    });
  });

  test("answers unknown methods and malformed messages with JSON-RPC errors", async () => {
    expect(await answer({ jsonrpc: "2.0", id: 7, method: "resources/list" })).toMatchObject({
      id: 7,
      error: { code: -32601 },
    });
    expect(await answer([{ jsonrpc: "2.0", id: 1, method: "ping" }])).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
  });
});

test("MCP confirmation applies the proposal once; cancellation is terminal and leaves records unchanged", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const invoke = (name: string, args: unknown) =>
        answerMcp({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        });
      const proposed = yield* invoke("put_entity", {
        type: "employee",
        id: "ada",
        data: { name: "Ada Lovelace" },
      });
      const id = (proposed as { result: { structuredContent: { id: string } } }).result
        .structuredContent.id;
      expect(yield* invoke("get_entity", { type: "employee", id: "ada" })).toMatchObject({
        result: { structuredContent: { entity: { data: { name: "Ada" } } } },
      });
      const confirmed = yield* invoke("decide_change", { proposalId: id, approved: true });
      expect(confirmed).toMatchObject({
        result: {
          isError: false,
          structuredContent: {
            status: "applied",
            result: { entity: { data: { name: "Ada Lovelace" } }, triggered: [{ runId: "run-1" }] },
          },
        },
      });
      expect(yield* invoke("decide_change", { proposalId: id, approved: false })).toEqual(
        confirmed,
      );
      const deletion = yield* invoke("delete_entity", { type: "employee", id: "ada" });
      const deletionId = (deletion as { result: { structuredContent: { id: string } } }).result
        .structuredContent.id;
      expect(
        yield* invoke("decide_change", { proposalId: deletionId, approved: false }),
      ).toMatchObject({ result: { structuredContent: { status: "cancelled", result: null } } });
      expect(yield* invoke("get_entity", { type: "employee", id: "ada" })).toMatchObject({
        result: { structuredContent: { entity: { data: { name: "Ada Lovelace" } } } },
      });
    }).pipe(Effect.provide(handlers)),
  );
});
