import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { AutomationIndex } from "../automation/index.ts";
import { Automations } from "../automation/service.ts";
import type { Workflow } from "../workflow/model.ts";
import { automationRoutes } from "./automations.ts";
import { RequestIdentity } from "./identity.ts";

test("HTTP delegates the complete save without an entity store or directory writes", async () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const saved: Workflow = {
    name: "Watch people",
    trigger: { kind: "entity", entity: "person" },
    steps: [{ id: "stop", title: "Stop", kind: "stop", reason: "Done" }],
  };
  const unused = () => Effect.die("Unexpected operation");
  const services = Layer.mergeAll(
    Layer.succeed(RequestIdentity, { email: undefined }),
    Layer.succeed(AutomationIndex, {
      list: Effect.succeed([]),
      record: unused,
      recordIfMissing: unused,
    }),
    Layer.succeed(Automations, {
      get: (id) => ({
        inspectWorkflow: unused,
        overview: unused,
        chat: unused,
        save: (automationId) =>
          Effect.sync(() => {
            calls.push([id, automationId]);
            return { saved };
          }),
        setPermissions: unused,
        start: unused,
        entityChanged: unused,
        run: unused,
        respond: unused,
      }),
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    automationRoutes.pipe(Layer.provideMerge(services)),
    { disableLogger: true },
  );
  try {
    const response = await handler(
      new Request("http://studio/api/automations/a1/save", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify({ saved }));
    expect(calls).toEqual([["a1", "a1"]]);
  } finally {
    await dispose();
  }
});
