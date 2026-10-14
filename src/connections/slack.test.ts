import { afterAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Events } from "../events/service.ts";
import { RunId } from "../workflow/run.ts";
import type { ActionStep } from "../workflow/model.ts";
import { runAction } from "./runner.ts";
import { makeSlackWebSender, SlackSender } from "./slack.ts";

const calls: Array<{ method: string; auth: string | null; body: Record<string, unknown> }> = [];
let rateLimitOnce = false;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const method = new URL(request.url).pathname.split("/").pop() ?? "";
    const body: Record<string, unknown> = request.headers
      .get("content-type")
      ?.startsWith("application/json")
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(await request.text()));
    calls.push({ method, auth: request.headers.get("authorization"), body });
    if (method === "chat.postMessage" && rateLimitOnce) {
      rateLimitOnce = false;
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    }
    if (method === "users.lookupByEmail") {
      return body["email"] === "sam@example.com"
        ? Response.json({ ok: true, user: { id: "U-sam" } })
        : Response.json({ ok: false, error: "users_not_found" });
    }
    if (method === "conversations.list") {
      // Two pages, so finding a DM follows the cursor.
      return body["cursor"] === undefined
        ? Response.json({
            ok: true,
            channels: [{ id: "D-other", user: "U-other" }],
            response_metadata: { next_cursor: "page-2" },
          })
        : Response.json({ ok: true, channels: [{ id: "D-sam", user: "U-sam" }] });
    }
    if (method === "conversations.history") {
      return Response.json({
        ok: true,
        messages: [
          { ts: "1.1", text: "Hello Sam" },
          {
            ts: "1.2",
            metadata: { event_type: "automations_message", event_payload: { key: "a/run/step" } },
          },
        ],
      });
    }
    if (body["channel"] === "secret") return Response.json({ ok: false, error: "not_in_channel" });
    const channel = body["channel"] === "U-sam" ? "D-sam" : "C-team";
    return Response.json({ ok: true, channel, ts: "1700000000.000100" });
  },
});
afterAll(() => server.stop(true));

const sender = makeSlackWebSender(Redacted.make("xoxb-test"), `${server.url.href}api/`);
const step: ActionStep = {
  id: "tell",
  title: "Tell",
  kind: "action",
  use: "slack.sendMessage",
  with: {},
};
const state = { runId: RunId.make("run-1"), subject: null, steps: {} };
/** runAction needs a publisher; Slack steps never publish. */
const noEvents = Effect.provideService(Events, { publish: () => Effect.die("unexpected publish") });

test("posts to a channel by name and DMs a person found by email, with the bot token", async () => {
  calls.length = 0;
  const sent = await Effect.runPromise(
    Effect.all([
      sender.send({ kind: "channel", name: "#team" }, "Hello team"),
      sender.send({ kind: "person", email: "sam@example.com" }, "Hello Sam"),
    ]),
  );
  expect(sent).toEqual([
    { channel: "C-team", ts: "1700000000.000100" },
    { channel: "D-sam", ts: "1700000000.000100" },
  ]);
  expect(calls.map(({ method, body }) => [method, body])).toEqual([
    ["chat.postMessage", { channel: "team", text: "Hello team" }],
    ["users.lookupByEmail", { email: "sam@example.com" }],
    ["chat.postMessage", { channel: "U-sam", text: "Hello Sam" }],
  ]);
  expect(calls.every((call) => call.auth === "Bearer xoxb-test")).toBe(true);
});

test("posts blocks with the message's key in its metadata, and finds that key in the DM later", async () => {
  calls.length = 0;
  const blocks = [{ type: "section" as const, text: { type: "mrkdwn" as const, text: "*Hi*" } }];
  await Effect.runPromise(
    sender.post(
      { kind: "person", email: "sam@example.com" },
      { text: "Hi", blocks, key: "a/run/step" },
    ),
  );
  expect(calls.at(-1)?.body).toEqual({
    channel: "U-sam",
    text: "Hi",
    blocks,
    metadata: { event_type: "automations_message", event_payload: { key: "a/run/step" } },
  });

  calls.length = 0;
  expect(await Effect.runPromise(sender.findPosted("sam@example.com", "a/run/step"))).toEqual({
    channel: "D-sam",
    ts: "1.2",
  });
  expect(calls.map(({ method, body }) => [method, body])).toEqual([
    ["users.lookupByEmail", { email: "sam@example.com" }],
    ["conversations.list", { types: "im", limit: "200" }],
    ["conversations.list", { types: "im", limit: "200", cursor: "page-2" }],
    ["conversations.history", { channel: "D-sam", limit: "50", include_all_metadata: "true" }],
  ]);
  expect(
    await Effect.runPromise(sender.findPosted("sam@example.com", "a/run/other-step")),
  ).toBeUndefined();
});

test("explains Slack's refusals and waits out a rate limit", async () => {
  const unknown = await Effect.runPromise(
    sender.send({ kind: "person", email: "nobody@example.com" }, "Hi").pipe(Effect.flip),
  );
  expect(unknown).toMatchObject({ code: "users_not_found" });
  expect(unknown.message).toContain("no one in the Slack workspace has that email address");
  const outside = await Effect.runPromise(
    sender.send({ kind: "channel", name: "secret" }, "Hi").pipe(Effect.flip),
  );
  expect(outside.message).toContain("invite it with /invite");

  rateLimitOnce = true;
  expect(await Effect.runPromise(sender.send({ kind: "channel", name: "team" }, "Hi"))).toEqual({
    channel: "C-team",
    ts: "1700000000.000100",
  });
});

test("slack.sendMessage posts when a sender is provided and is simulated without one", async () => {
  const inputs = { to: "#team", text: "Shipped" };
  const live = await Effect.runPromise(
    runAction(step, inputs, state, "key-1").pipe(
      Effect.provideService(SlackSender, sender),
      noEvents,
    ),
  );
  expect(live).toEqual({ channel: "C-team", ts: "1700000000.000100", text: "Shipped" });

  const simulated = await Effect.runPromise(runAction(step, inputs, state, "key-1").pipe(noEvents));
  expect(simulated).toMatchObject({ simulated: true, channel: "#team", text: "Shipped" });

  const failed = await Effect.runPromise(
    runAction(step, { to: "#secret", text: "Hi" }, state, "key-2").pipe(
      Effect.provideService(SlackSender, sender),
      noEvents,
      Effect.flip,
    ),
  );
  expect(failed).toMatchObject({ step: "tell" });
  expect(failed.message).toContain("invite it with /invite");
});
