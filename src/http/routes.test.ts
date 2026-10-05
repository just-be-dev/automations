import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { layerMemory } from "../entities/store.ts";
import { EntitySubscribers } from "../entities/subscribers.ts";
import { catalogRoutes } from "./catalog.ts";
import { entityRoutes } from "./entities.ts";
import { mcpRoutes } from "./mcp.ts";
import { json } from "./response.ts";

const app = () =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      entityRoutes,
      catalogRoutes,
      mcpRoutes,
      HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
    ).pipe(
      Layer.provideMerge(
        Layer.merge(
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
    { disableLogger: true },
  );

test("HTTP and MCP use the same store and return entity-write notifications", async () => {
  const { handler, dispose } = app();
  try {
    const written = await handler(
      new Request("http://studio/api/entities/employee/ada", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { name: "Ada Lovelace" } }),
      }),
    );
    expect(written.status).toBe(200);
    expect(written.headers.get("cache-control")).toBe("no-store");
    expect(await written.json()).toMatchObject({
      entity: { type: "employee", id: "ada", data: { name: "Ada Lovelace" } },
      triggered: [{ automation: "watching-employee", runId: "run-1", error: null }],
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
      new Request("http://studio/api/entities/employee/ada", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { name: 42 } }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "employee.name must be a text" });
  } finally {
    await dispose();
  }
});

test("entity bodies at the 32 KB limit decode; bodies above it return 413", async () => {
  const { handler, dispose } = app();
  try {
    for (const size of [32_000, 32_001]) {
      const response = await handler(
        new Request("http://studio/api/entities/employee/ada", {
          method: "PUT",
          headers: { "content-type": "application/json", "content-length": String(size) },
          body: JSON.stringify({ data: { name: "Ada" } }).padEnd(size, " "),
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
