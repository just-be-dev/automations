/** Slack's interactivity webhook: verifies each button click and queues it for deciding. */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  APPROVE_ACTION,
  REJECT_ACTION,
  SlackBlockJson,
  SlackTaskActions,
  TaskRef,
  type SlackTaskAction,
} from "./slack-approvals.ts";

/**
 * Slack posts every click on a message's buttons here, and shows the person an error unless the
 * response arrives within 3 seconds. So the route only checks the signature, queues the click,
 * and answers 200 with no body, which leaves the message as it is. Deciding happens off the
 * queue (`decideFromSlack`), which then updates the message.
 */
export const SLACK_INTERACTIVITY_PATH = "/integrations/slack/interactivity";

/** Slack's interaction payloads carry the whole message; a DM's are a few kilobytes. */
const MAX_BODY_BYTES = 64_000;
/** Slack refuses requests signed more than five minutes ago; so does this, against replays. */
const MAX_SKEW_SECONDS = 300;

export class SlackSignatureError extends Schema.TaggedError<SlackSignatureError>()(
  "SlackSignatureError",
  { reason: Schema.String },
) {}

const encoder = new TextEncoder();

const hexBytes = (hex: string) => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

/**
 * Checks `x-slack-signature` against the exact body bytes: `v0=` and the hex HMAC-SHA256 of
 * `v0:<timestamp>:<body>` under the app's signing secret. WebCrypto's `verify` compares in
 * constant time.
 */
export const verifySlackSignature = Effect.fn("SlackInteractivity.verify")(function* (input: {
  readonly body: Uint8Array;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly signingSecret: Redacted.Redacted<string>;
}) {
  const { timestamp, signature } = input;
  if (timestamp === undefined || signature === undefined) {
    return yield* new SlackSignatureError({ reason: "missing signature headers" });
  }
  const sentAt = Number(timestamp);
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  if (!/^\d+$/.test(timestamp) || Math.abs(now - sentAt) > MAX_SKEW_SECONDS) {
    return yield* new SlackSignatureError({ reason: "stale or invalid timestamp" });
  }
  const hex = /^v0=([0-9a-f]{64})$/i.exec(signature)?.[1];
  if (hex === undefined) {
    return yield* new SlackSignatureError({ reason: "malformed signature" });
  }
  const prefix = encoder.encode(`v0:${timestamp}:`);
  const signed = new Uint8Array(prefix.length + input.body.length);
  signed.set(prefix);
  signed.set(input.body, prefix.length);
  const valid = yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(Redacted.value(input.signingSecret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify("HMAC", key, hexBytes(hex), signed);
    },
    catch: () => new SlackSignatureError({ reason: "could not compute the signature" }),
  });
  if (!valid) {
    return yield* new SlackSignatureError({ reason: "signature mismatch" });
  }
});

/** The parts of a `block_actions` payload a click on Approve or Reject needs. */
const BlockActions = Schema.Struct({
  type: Schema.Literal("block_actions"),
  user: Schema.Struct({ id: Schema.String }),
  container: Schema.Struct({ channel_id: Schema.String, message_ts: Schema.String }),
  response_url: Schema.String,
  message: Schema.Struct({ blocks: Schema.optionalKey(Schema.Array(SlackBlockJson)) }),
  actions: Schema.Array(
    Schema.Struct({ action_id: Schema.String, value: Schema.optionalKey(Schema.String) }),
  ),
});

const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(BlockActions));
const decodeTaskRef = Schema.decodeUnknownOption(Schema.fromJsonString(TaskRef));

/**
 * The click a form-encoded interaction body carries, or none for anything else Slack sends here:
 * other buttons, other interaction types, a click without a message. The response URL must be
 * Slack's own, because deciding posts to it.
 */
export const taskActionOf = (body: string): Option.Option<SlackTaskAction> => {
  const payload = new URLSearchParams(body).get("payload");
  if (payload === null) return Option.none();
  return Option.flatMap(decodePayload(payload), (interaction) => {
    const clicked = interaction.actions.find(
      (action) => action.action_id === APPROVE_ACTION || action.action_id === REJECT_ACTION,
    );
    if (
      clicked?.value === undefined ||
      !interaction.response_url.startsWith("https://hooks.slack.com/")
    ) {
      return Option.none();
    }
    return Option.map(decodeTaskRef(clicked.value), (task) => ({
      task,
      approved: clicked.action_id === APPROVE_ACTION,
      user: interaction.user.id,
      channel: interaction.container.channel_id,
      ts: interaction.container.message_ts,
      responseUrl: interaction.response_url,
      blocks: interaction.message.blocks ?? [],
    }));
  });
};

/**
 * `POST /integrations/slack/interactivity`. Refuses unsigned or mis-signed requests with 401,
 * acknowledges anything else with 200, and answers 503 only when the click couldn't be queued,
 * so Slack tells the person to try again.
 */
export const slackInteractivityRoutes = (signingSecret: Redacted.Redacted<string>) =>
  HttpRouter.add(
    "POST",
    SLACK_INTERACTIVITY_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
        return HttpServerResponse.empty({ status: 413 });
      }
      const body = new Uint8Array(yield* request.arrayBuffer);
      if (body.length > MAX_BODY_BYTES) return HttpServerResponse.empty({ status: 413 });
      const verified = yield* verifySlackSignature({
        body,
        timestamp: request.headers["x-slack-request-timestamp"],
        signature: request.headers["x-slack-signature"],
        signingSecret,
      }).pipe(Effect.result);
      if (verified._tag === "Failure") {
        yield* Effect.logWarning("Slack interactivity authentication failed").pipe(
          Effect.annotateLogs("reason", verified.failure.reason),
        );
        return HttpServerResponse.empty({ status: 401 });
      }
      const action = taskActionOf(new TextDecoder().decode(body));
      if (Option.isNone(action)) return HttpServerResponse.empty({ status: 200 });
      const actions = yield* SlackTaskActions;
      const queued = yield* actions.send(action.value).pipe(Effect.result);
      if (queued._tag === "Failure") {
        yield* Effect.logError("Couldn't queue a Slack approval click", queued.failure);
        return HttpServerResponse.empty({ status: 503 });
      }
      return HttpServerResponse.empty({ status: 200 });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Slack interactivity request failed", error).pipe(
          Effect.as(HttpServerResponse.empty({ status: 400 })),
        ),
      ),
    ),
  );
