/** Checks Slack's request signatures, click decoding, and the interactivity route's answers. */
import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  approvalButtons,
  SlackTaskActionError,
  SlackTaskActions,
  SlackBlockJson,
  type SlackTaskAction,
} from "./slack-approvals.ts";
import {
  SLACK_INTERACTIVITY_PATH,
  slackInteractivityRoutes,
  taskActionOf,
  verifySlackSignature,
} from "./slack-interactivity.ts";

const secret = "8f742231b10e8888abcd99yyyzzz85a5";
const signingSecret = Redacted.make(secret);
/** Signed the way Slack documents it, with Node's HMAC rather than the code under test. */
const sign = (body: string, timestamp: string, key = secret) =>
  `v0=${createHmac("sha256", key).update(`v0:${timestamp}:${body}`).digest("hex")}`;
const nowSeconds = () => String(Math.floor(Date.now() / 1000));

const ref = { automation: "a1", run: "run-1", step: "send" };
const [approve, reject] = approvalButtons(ref);
const openInStudio = {
  type: "button",
  action_id: "open",
  text: { type: "plain_text", text: "Open in Studio" },
  url: "https://studio.example.com/?automation=a1&run=run-1",
};
/** The message as Slack sends it back: plain JSON. */
const blocks = Schema.decodeUnknownSync(Schema.Array(SlackBlockJson))([
  { type: "section", text: { type: "mrkdwn", text: "*Launch a great first week* needs Ops" } },
  { type: "actions", block_id: "task-actions", elements: [openInStudio, approve, reject] },
]);
const payload = (clicked: unknown, overrides: Record<string, unknown> = {}) => ({
  type: "block_actions",
  user: { id: "U-sam", username: "sam", team_id: "T1" },
  team: { id: "T1" },
  container: { type: "message", channel_id: "D-sam", message_ts: "1700000000.000100" },
  response_url: "https://hooks.slack.com/actions/T1/1/abc",
  message: { ts: "1700000000.000100", text: "Approve?", blocks },
  actions: [clicked],
  ...overrides,
});
const formBody = (value: unknown) =>
  new URLSearchParams({ payload: JSON.stringify(value) }).toString();

const verify = (body: string, timestamp: string | undefined, signature: string | undefined) =>
  Effect.runPromise(
    verifySlackSignature({
      body: new TextEncoder().encode(body),
      timestamp,
      signature,
      signingSecret,
    }).pipe(
      Effect.as("valid"),
      Effect.catch((error) => Effect.succeed(error.reason)),
    ),
  );

test("accepts only a signature over these exact bytes, recent, and under this secret", async () => {
  const body = formBody(payload(approve));
  const timestamp = nowSeconds();
  expect(await verify(body, timestamp, sign(body, timestamp))).toBe("valid");
  expect(
    await verify(body, timestamp, sign(body, timestamp).toUpperCase().replace("V0", "v0")),
  ).toBe("valid");
  expect(await verify(`${body}&x=1`, timestamp, sign(body, timestamp))).toBe("signature mismatch");
  expect(await verify(body, timestamp, sign(body, timestamp, "another secret"))).toBe(
    "signature mismatch",
  );
  const stale = String(Number(timestamp) - 301);
  expect(await verify(body, stale, sign(body, stale))).toBe("stale or invalid timestamp");
  expect(await verify(body, "soon", sign(body, "soon"))).toBe("stale or invalid timestamp");
  expect(await verify(body, timestamp, sign(body, timestamp).replace("v0=", "v1="))).toBe(
    "malformed signature",
  );
  expect(await verify(body, timestamp, sign(body, timestamp).slice(0, -2))).toBe(
    "malformed signature",
  );
  expect(await verify(body, undefined, sign(body, timestamp))).toBe("missing signature headers");
  expect(await verify(body, timestamp, undefined)).toBe("missing signature headers");
});

test("reads a click on Approve or Reject, and nothing else", () => {
  expect(taskActionOf(formBody(payload(approve)))).toEqual(
    Option.some({
      task: ref,
      approved: true,
      user: "U-sam",
      channel: "D-sam",
      ts: "1700000000.000100",
      responseUrl: "https://hooks.slack.com/actions/T1/1/abc",
      blocks,
    }),
  );
  expect(Option.map(taskActionOf(formBody(payload(reject))), (action) => action.approved)).toEqual(
    Option.some(false),
  );
  // Other buttons, other interactions, tampered values, and response URLs that aren't Slack's.
  expect(taskActionOf(formBody(payload(openInStudio)))).toEqual(Option.none());
  expect(taskActionOf(formBody({ ...payload(approve), type: "view_submission" }))).toEqual(
    Option.none(),
  );
  expect(taskActionOf(formBody(payload({ ...approve, value: "not json" })))).toEqual(Option.none());
  expect(
    taskActionOf(
      formBody(payload(approve, { response_url: "https://hooks.slack.com.evil.example/x" })),
    ),
  ).toEqual(Option.none());
  expect(taskActionOf("payload=%7B")).toEqual(Option.none());
  expect(taskActionOf("")).toEqual(Option.none());
});

const serve = (send: (action: SlackTaskAction) => Effect.Effect<void, SlackTaskActionError>) =>
  HttpRouter.toWebHandler(
    slackInteractivityRoutes(signingSecret).pipe(
      Layer.provideMerge(Layer.succeed(SlackTaskActions, { send })),
    ),
    { disableLogger: true },
  );

const post = (
  handler: (request: Request) => Promise<Response>,
  body: string,
  headers: Record<string, string>,
) =>
  handler(
    new Request(`https://channels.example.com${SLACK_INTERACTIVITY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    }),
  );

const signed = (body: string) => {
  const timestamp = nowSeconds();
  return { "x-slack-request-timestamp": timestamp, "x-slack-signature": sign(body, timestamp) };
};

test("the route queues a signed click and acknowledges it with an empty 200", async () => {
  const queued: Array<SlackTaskAction> = [];
  const { handler, dispose } = serve((action) => Effect.sync(() => void queued.push(action)));
  try {
    const body = formBody(payload(approve));
    const response = await post(handler, body, signed(body));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(queued.map((action) => [action.task, action.approved, action.user])).toEqual([
      [ref, true, "U-sam"],
    ]);

    // Valid Slack traffic that isn't a task click is acknowledged and queues nothing.
    const other = formBody(payload(openInStudio));
    expect((await post(handler, other, signed(other))).status).toBe(200);
    expect(queued).toHaveLength(1);
  } finally {
    await dispose();
  }
});

test("the route refuses unsigned, mis-signed and oversized requests without queueing", async () => {
  const queued: Array<SlackTaskAction> = [];
  const { handler, dispose } = serve((action) => Effect.sync(() => void queued.push(action)));
  try {
    const body = formBody(payload(approve));
    expect((await post(handler, body, {})).status).toBe(401);
    const { "x-slack-request-timestamp": timestamp } = signed(body);
    const forged = {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": sign(body, timestamp, "guessed"),
    };
    expect((await post(handler, body, forged)).status).toBe(401);
    // A body signed for one click can't carry another.
    const other = formBody(payload(reject));
    expect((await post(handler, other, signed(body))).status).toBe(401);
    const huge = formBody(payload(approve, { padding: "x".repeat(70_000) }));
    expect((await post(handler, huge, signed(huge))).status).toBe(413);
    expect(queued).toEqual([]);
  } finally {
    await dispose();
  }
});

test("the route answers 503 when the click can't be queued, so Slack shows an error", async () => {
  const { handler, dispose } = serve(() =>
    Effect.fail(new SlackTaskActionError({ message: "queue unavailable" })),
  );
  try {
    const body = formBody(payload(approve));
    expect((await post(handler, body, signed(body))).status).toBe(503);
  } finally {
    await dispose();
  }
});
