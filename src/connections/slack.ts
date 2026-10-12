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

export interface SlackSenderService {
  readonly send: (to: SlackRecipient, text: string) => Effect.Effect<SlackSent, SlackSendError>;
}

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
  /** Calls a Web API method and returns its JSON once Slack says `ok`. */
  const call = (
    method: string,
    body: Record<string, unknown>,
  ): Effect.Effect<unknown, SlackSendError> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(new URL(method, origin).toString()).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.bodyJsonUnsafe(body),
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

  return {
    send: Effect.fn("Slack.send")(function* (to: SlackRecipient, text: string) {
      // A person gets a DM from the bot: posting to their user ID opens it.
      const channel =
        to.kind === "channel"
          ? to.name.replace(/^#/, "")
          : (yield* call("users.lookupByEmail", { email: to.email }).pipe(
              Effect.flatMap(decode(LookupResponse, "users.lookupByEmail")),
            )).user.id;
      const posted = yield* call("chat.postMessage", { channel, text }).pipe(
        Effect.flatMap(decode(PostResponse, "chat.postMessage")),
      );
      return { channel: posted.channel, ts: posted.ts };
    }),
  };
};
