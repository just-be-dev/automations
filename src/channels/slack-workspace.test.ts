/** Checks the Web API calls behind deciding from Slack against a local stand-in for Slack. */
import { afterAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { makeSlackWebWorkspace } from "./slack-workspace.ts";

const calls: Array<{ path: string; auth: string | null; type: string | null; body: string }> = [];
const users: Record<string, unknown> = {
  "U-sam": { profile: { email: "sam@example.com" } },
  "U-bot": { is_bot: true, profile: {} },
  "U-gone": { deleted: true, profile: { email: "gone@example.com" } },
  "U-private": { profile: {} },
};
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.text();
    calls.push({
      path,
      auth: request.headers.get("authorization"),
      type: request.headers.get("content-type"),
      body,
    });
    if (path === "/api/users.info") {
      const user = users[new URLSearchParams(body).get("user") ?? ""];
      return Response.json(
        user === undefined ? { ok: false, error: "user_not_found" } : { ok: true, user },
      );
    }
    if (path === "/api/chat.update") {
      return Response.json(
        JSON.parse(body).channel === "D-gone"
          ? { ok: false, error: "message_not_found" }
          : { ok: true },
      );
    }
    if (path === "/hooks/expired") return new Response("expired_url", { status: 404 });
    return new Response("ok");
  },
});
afterAll(() => server.stop(true));

const hooks = `${server.url.href}hooks/`;
const workspace = makeSlackWebWorkspace(
  Redacted.make("xoxb-test"),
  `${server.url.href}api/`,
  (url) => url.startsWith(hooks),
);
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.catch((error) => Effect.succeed({ error }))));

test("finds a person's email address with the bot token, and none for bots or the departed", async () => {
  calls.length = 0;
  expect(await run(workspace.emailOf("U-sam"))).toBe("sam@example.com");
  expect(await run(workspace.emailOf("U-bot"))).toBeUndefined();
  expect(await run(workspace.emailOf("U-gone"))).toBeUndefined();
  expect(await run(workspace.emailOf("U-private"))).toBeUndefined();
  expect(await run(workspace.emailOf("U-nobody"))).toMatchObject({
    error: { message: "Slack users.info: user_not_found" },
  });
  expect(calls[0]).toEqual({
    path: "/api/users.info",
    auth: "Bearer xoxb-test",
    type: "application/x-www-form-urlencoded",
    body: "user=U-sam",
  });
});

test("updates a message in place and replies ephemerally through Slack's response URL", async () => {
  calls.length = 0;
  const blocks = [{ type: "context", elements: [{ type: "mrkdwn", text: "*Approved*" }] }];
  await run(workspace.updateMessage("D-sam", "1.0", { text: "Approved", blocks }));
  await run(workspace.replyEphemeral(`${hooks}click`, "Only members of Ops can answer this"));
  expect(calls.map(({ path, auth, body }) => [path, auth, JSON.parse(body)])).toEqual([
    [
      "/api/chat.update",
      "Bearer xoxb-test",
      { channel: "D-sam", ts: "1.0", text: "Approved", blocks },
    ],
    // The response URL is its own credential: the bot token never goes there.
    [
      "/hooks/click",
      null,
      {
        response_type: "ephemeral",
        replace_original: false,
        text: "Only members of Ops can answer this",
      },
    ],
  ]);
});

test("Slack's refusals fail, so the queue retries the click", async () => {
  calls.length = 0;
  expect(
    await run(workspace.updateMessage("D-gone", "1.0", { text: "", blocks: [] })),
  ).toMatchObject({
    error: { message: "Slack chat.update: message_not_found" },
  });
  expect(await run(workspace.replyEphemeral(`${hooks}expired`, "No"))).toMatchObject({
    error: { message: "Slack response_url answered 404" },
  });
  // Nothing outside Slack's own response URLs is ever posted to.
  expect(await run(workspace.replyEphemeral("https://example.com/steal", "No"))).toMatchObject({
    error: { message: "Not a Slack response URL" },
  });
  expect(calls.map((call) => call.path)).toEqual(["/api/chat.update", "/hooks/expired"]);
  expect(
    await run(
      makeSlackWebWorkspace(Redacted.make("xoxb-test")).replyEphemeral(`${hooks}click`, "No"),
    ),
  ).toMatchObject({ error: { message: "Not a Slack response URL" } });
});
