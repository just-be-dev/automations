import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { AutomationNamer } from "../../agents/namer/namer.ts";
import { AutomationIndex } from "../../automation/index.ts";
import { Automations } from "../../automation/service.ts";
import { layerMemory } from "../../entities/store.ts";
import { automationRoutes } from "../../http/automations.ts";
import { accessIdentity } from "./access.ts";

test("Access identity is request-scoped and reaches the automation's approval operation", async () => {
  const calls: Array<ReadonlyArray<unknown>> = [];
  const unused = () => Effect.die("Unexpected operation");
  const services = Layer.mergeAll(
    layerMemory({}),
    Layer.succeed(AutomationNamer, { complete: unused }),
    Layer.succeed(AutomationIndex, {
      list: Effect.succeed([]),
      create: unused,
      record: unused,
      recordIfMissing: unused,
    }),
    Layer.succeed(Automations, {
      get: (id) => ({
        inspectWorkflow: unused,
        overview: unused,
        answer: unused,
        templateUses: unused,
        chat: unused,
        save: unused,
        setPermissions: unused,
        start: unused,
        entityChanged: unused,
        run: unused,
        plannerTrace: unused,
        runTrace: unused,
        respond: (runId, stepId, answer, email) =>
          Effect.sync(() => {
            calls.push([id, runId, stepId, answer, email]);
            return { ok: true };
          }),
      }),
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    automationRoutes.pipe(Layer.provideMerge(services)),
    { disableLogger: true, middleware: (effect) => effect.pipe(Effect.provide(accessIdentity)) },
  );
  try {
    for (const email of ["sam@example.com", "other@example.com", "", undefined]) {
      const response = await handler(
        new Request("http://studio/api/automations/a1/runs/r1/tasks/approve", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(email === undefined ? {} : { "cf-access-authenticated-user-email": email }),
          },
          body: JSON.stringify({ approved: true }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"ok":true}');
    }
  } finally {
    await dispose();
  }
  expect(calls).toEqual([
    ["a1", "r1", "approve", { approved: true }, "sam@example.com"],
    ["a1", "r1", "approve", { approved: true }, "other@example.com"],
    ["a1", "r1", "approve", { approved: true }, undefined],
    ["a1", "r1", "approve", { approved: true }, undefined],
  ]);
});
