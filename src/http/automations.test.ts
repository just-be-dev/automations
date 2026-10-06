import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { AutomationNamer, NamerError } from "../agents/namer/namer.ts";
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
        plannerTrace: unused,
        runTrace: unused,
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

test("creating an automation names it, lists it, and sends its description as the first message", async () => {
  const listed = new Map<string, string>([["onboard-new-hires", "Onboard new hires"]]);
  const chats: Array<ReadonlyArray<string>> = [];
  const replies = ['Name: "Onboard new hires."', "Order summaries"];
  const unused = () => Effect.die("Unexpected operation");
  const services = Layer.mergeAll(
    Layer.succeed(RequestIdentity, { email: undefined }),
    Layer.succeed(AutomationNamer, {
      complete: () => {
        const reply = replies.shift();
        return reply === undefined
          ? Effect.fail(new NamerError({ message: "Model unavailable" }))
          : Effect.succeed(reply);
      },
    }),
    Layer.succeed(AutomationIndex, {
      list: Effect.succeed([]),
      create: (id, name) =>
        Effect.sync(() => {
          if (listed.has(id)) {
            return false;
          }
          listed.set(id, name);
          return true;
        }),
      record: unused,
      recordIfMissing: unused,
    }),
    Layer.succeed(Automations, {
      get: (id) => ({
        inspectWorkflow: unused,
        overview: unused,
        answer: unused,
        templateUses: unused,
        chat: (automationId, message) =>
          id === "order-summaries"
            ? Effect.fail({ message: "The agent is still answering the previous message" })
            : Effect.sync(() => {
                chats.push([id, automationId, message]);
                return {
                  pendingChat: { id: "chat-1", prompt: message, status: "working" as const },
                };
              }),
        save: unused,
        setPermissions: unused,
        start: unused,
        entityChanged: unused,
        run: unused,
        respond: unused,
        plannerTrace: unused,
        runTrace: unused,
      }),
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    automationRoutes.pipe(Layer.provideMerge(services)),
    { disableLogger: true },
  );
  const create = (description: string) =>
    handler(
      new Request("http://studio/api/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description }),
      }),
    );
  try {
    const onboarding = "When a hire's start date is set, welcome them by email.";
    const named = await create(onboarding);
    expect(named.status).toBe(201);
    const created = JSON.parse(await named.text());
    expect(created.id).toMatch(/^onboard-new-hires-[a-z0-9]{6}$/);
    expect(created).toEqual({
      id: created.id,
      name: "Onboard new hires",
      pendingChat: { id: "chat-1", prompt: onboarding, status: "working" },
    });
    expect(listed.get(created.id)).toBe("Onboard new hires");
    expect(chats).toEqual([[created.id, created.id, onboarding]]);

    const unsent = await create("Summarize each order for the team");
    expect(unsent.status).toBe(201);
    expect(await unsent.text()).toBe(
      JSON.stringify({ id: "order-summaries", name: "Order summaries" }),
    );

    const unnamed = await create("Remind managers about reviews every quarter, politely");
    expect(JSON.parse(await unnamed.text()).name).toBe(
      "Remind managers about reviews every quarter",
    );

    const blank = await create("   ");
    expect(blank.status).toBe(400);
    expect(await blank.text()).toBe(
      JSON.stringify({ error: "Describe the automation in 1–10,000 characters" }),
    );
  } finally {
    await dispose();
  }
});

test("traces come from the planner, or from a run's agent steps, and an unknown run is not found", async () => {
  const trace = {
    events: [{ _tag: "Prompt" as const, id: "1", at: 0, text: "Design it" }],
    truncated: false,
  };
  const unused = () => Effect.die("Unexpected operation");
  const services = Layer.mergeAll(
    Layer.succeed(RequestIdentity, { email: undefined }),
    Layer.succeed(AutomationNamer, { complete: unused }),
    Layer.succeed(AutomationIndex, {
      list: Effect.succeed([]),
      create: unused,
      record: unused,
      recordIfMissing: unused,
    }),
    Layer.succeed(Automations, {
      get: () => ({
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
        respond: unused,
        plannerTrace: () => Effect.succeed(trace),
        runTrace: (runId) => Effect.succeed(runId === "r1" ? trace : undefined),
      }),
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    automationRoutes.pipe(Layer.provideMerge(services)),
    { disableLogger: true },
  );
  const get = (path: string) => handler(new Request(`http://studio/api/automations/${path}`));
  try {
    const planner = await get("a1/trace");
    expect(planner.status).toBe(200);
    expect(await planner.text()).toBe(JSON.stringify(trace));
    const run = await get("a1/runs/r1/trace");
    expect(await run.text()).toBe(JSON.stringify(trace));
    const missing = await get("a1/runs/r2/trace");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(JSON.stringify({ error: "Run not found" }));
  } finally {
    await dispose();
  }
});
