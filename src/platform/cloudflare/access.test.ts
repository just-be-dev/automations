/** Checks that request-scoped Access identity reaches approval operations without leaking between requests. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AutomationNamer } from "../../agents/namer/namer.ts";
import { AutomationIndex } from "../../automation/index.ts";
import { Automations } from "../../automation/service.ts";
import { layerMemory } from "../../entities/store.ts";
import { automationRoutes } from "../../http/automations.ts";
import { accessIdentity } from "./access.ts";

/** Answers one approval per Access header value and returns the responder each answer carried. */
const respondersFor = async (localUser: Option.Option<string>) => {
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
      remove: unused,
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
        setDraft: unused,
        remove: unused,
        start: unused,
        entityChanged: unused,
        eventReceived: unused,
        run: unused,
        plannerTrace: unused,
        runTrace: unused,
        resumeNow: unused,
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
    {
      disableLogger: true,
      middleware: (effect) => effect.pipe(Effect.provide(accessIdentity(localUser))),
    },
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
  for (const call of calls) {
    expect(call.slice(0, 4)).toEqual(["a1", "r1", "approve", { approved: true }]);
  }
  return calls.map((call) => call[4]);
};

test("Access identity is request-scoped and reaches the automation's approval operation", async () => {
  expect(await respondersFor(Option.none())).toEqual([
    "sam@example.com",
    "other@example.com",
    undefined,
    undefined,
  ]);
});

test("a local studio's user answers when Access sent no one, and Access still wins", async () => {
  expect(await respondersFor(Option.some("you@example.com"))).toEqual([
    "sam@example.com",
    "other@example.com",
    "you@example.com",
    "you@example.com",
  ]);
});
