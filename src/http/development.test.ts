/** Checks that development-only routes exist only where the host says it runs locally. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { LocalDevelopment } from "../automation/local-development.ts";
import { Automations } from "../automation/service.ts";
import { json } from "./response.ts";
import { developmentRoutes } from "./development.ts";

const unused = () => Effect.die("Unexpected operation");

const studio = (local: boolean | undefined) => {
  const resumed: Array<ReadonlyArray<string>> = [];
  const automations = Layer.succeed(Automations, {
    get: (id) => ({
      inspectWorkflow: unused,
      overview: unused,
      answer: unused,
      stopChat: unused,
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
      respond: unused,
      resumeNow: (runId, stepId) =>
        Effect.sync(() => {
          resumed.push([id, runId, stepId]);
          return { ok: true };
        }),
      plannerTrace: unused,
      runTrace: unused,
    }),
  });
  const services =
    local === undefined
      ? automations
      : Layer.merge(automations, Layer.succeed(LocalDevelopment, local));
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.merge(
      developmentRoutes,
      HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
    ).pipe(Layer.provideMerge(services)),
    { disableLogger: true },
  );
  return { handler, dispose, resumed };
};

const resume = (handler: (request: Request) => Promise<Response>) =>
  handler(
    new Request("http://studio/api/automations/a1/runs/r1/waits/settle/resume", {
      method: "POST",
    }),
  );

test("deployed stages say so and answer resuming a wait like an unknown route", async () => {
  // A host that never provides it, and one that provides false, are both deployed.
  for (const local of [undefined, false]) {
    const { handler, dispose, resumed } = studio(local);
    try {
      const dev = await handler(new Request("http://studio/api/dev"));
      expect(await dev.text()).toBe(JSON.stringify({ local: false }));
      const response = await resume(handler);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(JSON.stringify({ error: "Not found" }));
      expect(resumed).toEqual([]);
    } finally {
      await dispose();
    }
  }
});

test("local development resumes the run's wait through its automation", async () => {
  const { handler, dispose, resumed } = studio(true);
  try {
    const dev = await handler(new Request("http://studio/api/dev"));
    expect(await dev.text()).toBe(JSON.stringify({ local: true }));
    const response = await resume(handler);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe(JSON.stringify({ ok: true }));
    expect(resumed).toEqual([["a1", "r1", "settle"]]);
    const wrongMethod = await handler(
      new Request("http://studio/api/automations/a1/runs/r1/waits/settle/resume"),
    );
    expect(wrongMethod.status).toBe(404);
  } finally {
    await dispose();
  }
});
