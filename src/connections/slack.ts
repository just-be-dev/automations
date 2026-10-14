/** Posts Slack messages through the Web API when the deployment has a bot token; otherwise Slack stays simulated. */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

export class SlackSendError extends Schema.TaggedError<SlackSendError>()("SlackSendError", {
  message: Schema.String,
  /** Slack's error code, such as `not_in_channel` or `users_not_found`, when it gave one. */
  code: Schema.optionalKey(Schema.String),
}) {}

/** Where a message goes: a channel by name (`#team`), or a person by email (a DM from the bot). */
export type SlackRecipient =
  | { readonly kind: "channel"; readonly name: string }
  | { readonly kind: "person"; readonly email: string };

export interface SlackSent {
  /** The conversation Slack posted in: a channel ID, or the DM's ID. */
  readonly channel: string;
  readonly ts: string;
}

/** Plain text as Block Kit renders it: never mrkdwn, so nothing in it formats or links. */
export interface SlackPlainText {
  readonly type: "plain_text";
  readonly text: string;
}

/** A Block Kit button: a link when it has `url`, otherwise an interaction Slack delivers. */
export interface SlackButton {
  readonly type: "button";
  readonly action_id: string;
  readonly text: SlackPlainText;
  readonly url?: string;
  readonly value?: string;
  readonly style?: "primary" | "danger";
}

/** The Block Kit blocks the studio sends. Add a variant when a message needs another kind. */
export type SlackBlock =
  | { readonly type: "section"; readonly text: { readonly type: "mrkdwn"; readonly text: string } }
  | {
      readonly type: "context";
      readonly elements: ReadonlyArray<{ readonly type: "mrkdwn"; readonly text: string }>;
    }
  | {
      readonly type: "actions";
      readonly block_id?: string;
      readonly elements: ReadonlyArray<SlackButton>;
    };

/**
 * A message with Block Kit layout. `text` is the fallback Slack shows in notifications and
 * clients without blocks. `key` travels in the message's metadata so `findPosted` can tell
 * whether this exact message was already sent.
 */
export interface SlackMessage {
  readonly text: string;
  readonly blocks?: ReadonlyArray<SlackBlock>;
  readonly key?: string;
}

export interface SlackSenderService {
  readonly send: (to: SlackRecipient, text: string) => Effect.Effect<SlackSent, SlackSendError>;
  readonly post: (
    to: SlackRecipient,
    message: SlackMessage,
  ) => Effect.Effect<SlackSent, SlackSendError>;
  /**
   * The message with this `key` that the bot already sent this person, searching the latest
   * messages of its DM with them, or `undefined`. Slack takes no idempotency key, so this is how
   * a delivery that may have posted before it was recorded finds out.
   */
  readonly findPosted: (
    email: string,
    key: string,
  ) => Effect.Effect<SlackSent | undefined, SlackSendError>;
}

/** The metadata event type that carries a message's `key`. */
const MESSAGE_KEY_EVENT = "automations_message";

/**
 * The deployment's Slack sender, or `null` when it has no bot token. `slack.sendMessage` reads it:
 * with a sender it posts for real, without one it records what it would have sent.
 */
export const SlackSender = Context.Reference<SlackSenderService | null>("automations/SlackSender", {
  defaultValue: () => null,
});

const SlackResponse = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});
const LookupResponse = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });
const PostResponse = Schema.Struct({ channel: Schema.String, ts: Schema.String });
const ImListResponse = Schema.Struct({
  channels: Schema.Array(
    Schema.Struct({ id: Schema.String, user: Schema.optionalKey(Schema.String) }),
  ),
  response_metadata: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
  ),
});
const HistoryResponse = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      ts: Schema.String,
      metadata: Schema.optionalKey(
        Schema.Struct({
          event_type: Schema.String,
          event_payload: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
        }),
      ),
    }),
  ),
});

/** What to tell the person designing the workflow when Slack refuses. */
const explain = (code: string) => {
  switch (code) {
    case "channel_not_found":
      return "Slack has no channel by that name the bot can see";
    case "not_in_channel":
      return "the bot isn't in that channel: invite it with /invite";
    case "users_not_found":
      return "no one in the Slack workspace has that email address";
    case "missing_scope":
      return "the Slack app is missing a scope; reinstall it from docs/slack-app-manifest.json";
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
      return "Slack rejected the bot token; check SLACK_BOT_TOKEN";
    default:
      return code;
  }
};

/** Slack sends 429 with Retry-After when rate limited; any other failure is final for this attempt. */
const retryRateLimit = Schedule.recurs(2).pipe(
  Schedule.while(({ input }) => input instanceof SlackSendError && input.code === "ratelimited"),
);

/** A sender over Slack's Web API with a bot token. `origin` is for tests. */
export const makeSlackWebSender = (
  token: Redacted.Redacted<string>,
  origin = "https://slack.com/api/",
): SlackSenderService => {
  /**
   * Calls a Web API method and returns its JSON once Slack says `ok`. Slack takes JSON bodies only
   * for write methods such as `chat.postMessage`, so the others send form-encoded arguments.
   */
  const call = (
    method: string,
    body: Record<string, unknown>,
  ): Effect.Effect<unknown, SlackSendError> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(new URL(method, origin).toString()).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          method === "chat.postMessage"
            ? HttpClientRequest.bodyJsonUnsafe(body)
            : HttpClientRequest.bodyUrlParams(
                Object.fromEntries(
                  Object.entries(body).map(([name, value]) => [name, String(value)]),
                ),
              ),
        ),
      );
      if (response.status === 429) {
        const wait = Number(response.headers["retry-after"] ?? "1");
        yield* Effect.sleep(Duration.seconds(Number.isFinite(wait) ? Math.min(wait, 10) : 1));
        return yield* new SlackSendError({
          message: "Slack is rate limiting",
          code: "ratelimited",
        });
      }
      const json = yield* response.json;
      const result = yield* Schema.decodeUnknownEffect(SlackResponse)(json);
      if (!result.ok) {
        const code = result.error ?? "unknown_error";
        return yield* new SlackSendError({ message: `Slack ${method}: ${explain(code)}`, code });
      }
      return json;
    }).pipe(
      Effect.retry(retryRateLimit),
      Effect.timeout("20 seconds"),
      // Slack is a third party: don't forward trace headers to it.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError((error) =>
        error instanceof SlackSendError
          ? error
          : new SlackSendError({ message: `Slack ${method} failed: ${String(error)}` }),
      ),
    );

  const decode =
    <A>(schema: Schema.Codec<A, unknown>, method: string) =>
    (json: unknown) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(
          () => new SlackSendError({ message: `Slack ${method} answered in an unexpected shape` }),
        ),
      );

  const userIdOf = (email: string) =>
    call("users.lookupByEmail", { email }).pipe(
      Effect.flatMap(decode(LookupResponse, "users.lookupByEmail")),
      Effect.map((found) => found.user.id),
    );

  const post = Effect.fn("Slack.post")(function* (to: SlackRecipient, message: SlackMessage) {
    // A person gets a DM from the bot: posting to their user ID opens it.
    const channel = to.kind === "channel" ? to.name.replace(/^#/, "") : yield* userIdOf(to.email);
    const posted = yield* call("chat.postMessage", {
      channel,
      text: message.text,
      ...(message.blocks === undefined ? {} : { blocks: message.blocks }),
      ...(message.key === undefined
        ? {}
        : { metadata: { event_type: MESSAGE_KEY_EVENT, event_payload: { key: message.key } } }),
    }).pipe(Effect.flatMap(decode(PostResponse, "chat.postMessage")));
    return { channel: posted.channel, ts: posted.ts };
  });

  /** The bot's DM with a user, from the DMs it has open (`im:read`), or `undefined`. */
  const dmWith = Effect.fn("Slack.dmWith")(function* (user: string) {
    let cursor: string | undefined;
    // A bot in a sandbox has few DMs; stop after a handful of pages rather than walk forever.
    for (let page = 0; page < 5; page += 1) {
      const listed = yield* call("conversations.list", {
        types: "im",
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      }).pipe(Effect.flatMap(decode(ImListResponse, "conversations.list")));
      const found = listed.channels.find((channel) => channel.user === user);
      if (found !== undefined) return found.id;
      cursor = listed.response_metadata?.next_cursor;
      if (cursor === undefined || cursor === "") return undefined;
    }
    return undefined;
  });

  const findPosted = Effect.fn("Slack.findPosted")(function* (email: string, key: string) {
    const channel = yield* dmWith(yield* userIdOf(email));
    if (channel === undefined) return undefined;
    const history = yield* call("conversations.history", {
      channel,
      limit: 50,
      include_all_metadata: true,
    }).pipe(Effect.flatMap(decode(HistoryResponse, "conversations.history")));
    const found = history.messages.find(
      (message) =>
        message.metadata?.event_type === MESSAGE_KEY_EVENT &&
        message.metadata.event_payload?.["key"] === key,
    );
    return found === undefined ? undefined : { channel, ts: found.ts };
  });

  return {
    send: (to, text) => post(to, { text }),
    post,
    findPosted,
  };
};
