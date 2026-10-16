/** Checks the studio agent's thread routes: listing, archiving, stopping and clearing, per owner. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import type { AssistantState } from "../assistant/model.ts";
import { Assistants } from "../assistant/service.ts";
import { AssistantThreads, layerMemory } from "../assistant/threads.ts";
import { assistantRoutes } from "./assistant.ts";
import { RequestIdentity } from "./identity.ts";
import { json } from "./response.ts";

const sessionId = "11111111-1111-4111-8111-111111111111";
const unused = () => Effect.die("Unexpected operation");
const calls: Array<string> = [];
const state = (id: string): AssistantState => ({
  sessionId: id,
  conversation: [],
  activities: [],
  status: "idle",
});

const app = (email: string | undefined) =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      assistantRoutes,
      HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(RequestIdentity, { email }),
          Layer.succeed(Assistants, {
            get: (owner, id) => ({
              inspect: unused,
              chat: unused,
              confirm: unused,
              answer: unused,
              stop: () => Effect.sync(() => (calls.push(`stop ${owner} ${id}`), state(id))),
              clear: () => Effect.sync(() => (calls.push(`clear ${owner} ${id}`), state(id))),
            }),
          }),
        ),
      ),
      Layer.provideMerge(layerMemory),
    ),
    { disableLogger: true },
  );

test("threads are listed and archived per owner, and stop and clear reach the session", async () => {
  const { handler, dispose } = app("owner@example.com");
  try {
    const seeded: unknown = await (
      await handler(new Request("http://studio/api/assistant"))
    ).json();
    expect(seeded).toEqual({ threads: [] });

    const stopped = await handler(
      new Request(`http://studio/api/assistant/${sessionId}/stop`, { method: "POST" }),
    );
    expect(stopped.status).toBe(200);
    const cleared = await handler(
      new Request(`http://studio/api/assistant/${sessionId}/clear`, { method: "POST" }),
    );
    const clearedBody: unknown = await cleared.json();
    expect(clearedBody).toMatchObject({ sessionId });
    expect(calls).toEqual([
      `stop owner@example.com ${sessionId}`,
      `clear owner@example.com ${sessionId}`,
    ]);

    const invalid = await handler(
      new Request("http://studio/api/assistant/not-a-uuid/stop", { method: "POST" }),
    );
    expect(invalid.status).toBe(404);

    const badBody = await handler(
      new Request(`http://studio/api/assistant/${sessionId}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: "yes" }),
      }),
    );
    expect(badBody.status).toBe(400);
  } finally {
    await dispose();
  }
});

test("archiving changes only the owner's thread and returns their list", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    assistantRoutes.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(RequestIdentity, { email: undefined }),
          Layer.succeed(Assistants, {
            get: () => ({
              inspect: unused,
              chat: unused,
              confirm: unused,
              answer: unused,
              stop: unused,
              clear: unused,
            }),
          }),
          Layer.effectDiscard(
            Effect.gen(function* () {
              const threads = yield* AssistantThreads;
              yield* threads.touch("local", sessionId);
              yield* threads.touch("someone@example.com", sessionId);
            }),
          ),
        ),
      ),
      Layer.provideMerge(layerMemory),
    ),
    { disableLogger: true },
  );
  try {
    const archived = await handler(
      new Request(`http://studio/api/assistant/${sessionId}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      }),
    );
    const body: unknown = await archived.json();
    expect(body).toMatchObject({ threads: [{ id: sessionId, archived: true }] });
    const listed: unknown = await (
      await handler(new Request("http://studio/api/assistant"))
    ).json();
    expect(listed).toMatchObject({ threads: [{ archived: true }] });
  } finally {
    await dispose();
  }
});
