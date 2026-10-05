import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { EntityType } from "../entities/model.ts";
import { answerMcp, EntityToolHandlers } from "./entity-mcp.ts";
import { EntitySubscribers } from "../entities/subscribers.ts";
import { layerMemory } from "../entities/store.ts";

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

const answer = (message: unknown) =>
  Effect.runPromise(
    answerMcp(message).pipe(
      Effect.provide(
        EntityToolHandlers.pipe(
          Layer.provide(
            Layer.merge(
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
            ),
          ),
        ),
      ),
    ),
  );

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
    ]);
    expect(tools.every((tool) => (tool.inputSchema as { type?: string }).type === "object")).toBe(
      true,
    );
    expect(tools.find((tool) => tool.name === "delete_entity")?.annotations).toMatchObject({
      destructiveHint: true,
    });
  });

  test("writes an entity, reporting the runs it started", async () => {
    expect(
      await call("put_entity", { type: "employee", id: "ada", data: { start_date: "2026-11-02" } }),
    ).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          entity: { id: "ada", data: { name: "Ada", start_date: "2026-11-02" } },
          triggered: [{ automation: "watching-employee", runId: "run-1" }],
        },
      },
    });
  });

  test("defines and lists roles, whose members must have an email", async () => {
    const ops = { name: "ops", label: "Ops", members: [{ type: "person", id: "sam" }] };
    expect(await call("define_role", { role: ops })).toMatchObject({
      result: { isError: false, structuredContent: { role: ops } },
    });
    expect(
      await call("define_role", {
        role: { ...ops, members: [{ type: "employee", id: "ada" }] },
      }),
    ).toMatchObject({
      result: {
        isError: true,
        content: [{ text: "employee has no email field, so it can't be a member" }],
      },
    });
    expect(await call("list_roles", {})).toMatchObject({
      result: { isError: false, structuredContent: { roles: [] } },
    });
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
