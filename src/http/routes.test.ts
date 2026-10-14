/** Checks entity, role, template, and MCP routes through their HTTP responses and service calls. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { AutomationIndex } from "../automation/index.ts";
import { Automations } from "../automation/service.ts";
import { layerMemory } from "../entities/store.ts";
import { EntitySubscribers } from "../entities/subscribers.ts";
import { catalogRoutes } from "./catalog.ts";
import { entityRoutes } from "./entities.ts";
import { mcpRoutes } from "./mcp.ts";
import { json } from "./response.ts";
import { Changes } from "../changes/service.ts";
import { makeChanges } from "../changes/application.ts";
import { changeRoutes } from "./changes.ts";
import { RequestIdentity } from "./identity.ts";

const unused = () => Effect.die("Unexpected operation");

/** Each listed automation's saved and draft template uses, or a failure to answer. */
const templateUses: Record<
  string,
  { readonly saved: ReadonlyArray<string>; readonly draft: ReadonlyArray<string> } | string
> = {
  welcome: { saved: ["welcome_email"], draft: ["welcome_email", "farewell"] },
  drafting: { saved: [], draft: ["welcome_email"] },
  unrelated: { saved: ["farewell"], draft: [] },
  broken: "Durable Object reset",
};

const automationsLayer = Layer.merge(
  Layer.succeed(AutomationIndex, {
    list: Effect.succeed(
      Object.keys(templateUses).map((id) => ({ id, name: `Automation ${id}`, updatedAt: 0 })),
    ),
    create: unused,
    record: unused,
    recordIfMissing: unused,
  }),
  Layer.succeed(Automations, {
    get: (id) => ({
      inspectWorkflow: unused,
      overview: () => Effect.succeed({ activeRuns: [] }),
      answer: unused,
      templateUses: () => {
        const uses = templateUses[id];
        // Durable Object RPC errors arrive as plain objects.
        return typeof uses === "string" || uses === undefined
          ? Effect.fail({ message: uses ?? "Unknown" })
          : Effect.succeed(uses);
      },
      chat: unused,
      save: unused,
      setPermissions: unused,
      start: unused,
      entityChanged: unused,
      eventReceived: unused,
      plannerTrace: unused,
      runTrace: unused,
      run: unused,
      respond: unused,
      resumeNow: unused,
    }),
  }),
);

const app = () =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      entityRoutes,
      catalogRoutes,
      mcpRoutes,
      changeRoutes,
      HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
    ).pipe(
      Layer.provideMerge(
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
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              automationsLayer,
              Layer.succeed(RequestIdentity, { email: "owner@example.com" }),
              layerMemory({
                types: [
                  {
                    name: "employee",
                    label: "Employee",
                    title: "name",
                    fields: [{ name: "name", label: "Name", type: "text" }],
                  },
                ],
                entities: [{ type: "employee", id: "ada", data: { name: "Ada" }, updatedAt: 0 }],
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
    { disableLogger: true },
  );

test("approved changes preserve entity-write notifications", async () => {
  const { handler, dispose } = app();
  try {
    const proposed = await handler(
      new Request("http://studio/api/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: "forged",
          action: {
            kind: "putEntity",
            type: "employee",
            id: "ada",
            data: { name: "Ada Lovelace" },
          },
        }),
      }),
    );
    expect(proposed.status).toBe(200);
    expect(proposed.headers.get("cache-control")).toBe("no-store");
    const proposal = (await proposed.json()) as { id: string };
    const decision = await handler(
      new Request(`http://studio/api/changes/${proposal.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: true }),
      }),
    );
    expect(decision.status).toBe(200);
    expect(await decision.json()).toMatchObject({
      status: "applied",
      result: {
        entity: { type: "employee", id: "ada", data: { name: "Ada Lovelace" } },
        triggered: [{ automation: "watching-employee", runId: "run-1", error: null }],
      },
    });
    const read = await handler(
      new Request("http://studio/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://studio" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_entity", arguments: { type: "employee", id: "ada" } },
        }),
      }),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      id: 1,
      result: { structuredContent: { entity: { data: { name: "Ada Lovelace" } } } },
    });
  } finally {
    await dispose();
  }
});

test("static type routes take precedence, and missing or invalid resources keep the error shape", async () => {
  const { handler, dispose } = app();
  try {
    const types = await handler(new Request("http://studio/api/entities/types"));
    expect(types.status).toBe(200);
    expect(await types.json()).toMatchObject([{ name: "employee" }]);
    for (const path of [
      "/api/entities/employee/missing",
      "/api/templates/missing",
      "/api/missing",
    ]) {
      const response = await handler(new Request(`http://studio${path}`));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
    }
    const invalid = await handler(
      new Request("http://studio/api/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: { kind: "putEntity", type: "employee", id: "ada", data: { name: 42 } },
        }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.any(String) });
  } finally {
    await dispose();
  }
});

test("a template's usage lists the automations whose saved workflow or draft use it", async () => {
  const { handler, dispose } = app();
  try {
    const response = await handler(
      new Request("http://studio/api/templates/welcome_email/automations"),
    );
    expect(response.status).toBe(200);
    const usage: unknown = await response.json();
    expect(usage).toEqual({
      automations: [
        { id: "welcome", name: "Automation welcome", updatedAt: 0, saved: true, draft: true },
        { id: "drafting", name: "Automation drafting", updatedAt: 0, saved: false, draft: true },
      ],
      unchecked: [
        { id: "broken", name: "Automation broken", updatedAt: 0, error: "Durable Object reset" },
      ],
    });
  } finally {
    await dispose();
  }
});

test("change bodies at the 32 KB limit decode; bodies above it return 413", async () => {
  const { handler, dispose } = app();
  try {
    for (const size of [32_000, 32_001]) {
      const response = await handler(
        new Request("http://studio/api/changes", {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": String(size) },
          body: JSON.stringify({
            action: { kind: "putEntity", type: "employee", id: "ada", data: { name: "Ada" } },
          }).padEnd(size, " "),
        }),
      );
      expect(response.status).toBe(size === 32_000 ? 200 : 413);
      if (size > 32_000) {
        expect(await response.json()).toMatchObject({ error: "Payload too large" });
      }
    }
  } finally {
    await dispose();
  }
});

test("MCP keeps its origin check, POST-only transport, and notification status", async () => {
  const { handler, dispose } = app();
  try {
    const forbidden = await handler(
      new Request("http://studio/api/mcp", {
        method: "POST",
        headers: { origin: "https://other" },
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { message: "Origin not allowed" } });
    const get = await handler(new Request("http://studio/api/mcp"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const notification = await handler(
      new Request("http://studio/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    );
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
  } finally {
    await dispose();
  }
});

test("changes reject malformed and oversized bodies", async () => {
  const { handler, dispose } = app();
  try {
    for (const body of [
      "{",
      JSON.stringify({
        action: { kind: "putEntity", type: "employee", id: "invalid/id", data: {} },
      }),
      JSON.stringify({ action: { kind: "unknown" } }),
    ]) {
      const response = await handler(
        new Request("http://studio/api/changes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
    }
    for (const path of ["/api/changes", "/api/changes/change-1/decision"]) {
      const response = await handler(
        new Request(`http://studio${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": "32001" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(413);
    }
  } finally {
    await dispose();
  }
});
