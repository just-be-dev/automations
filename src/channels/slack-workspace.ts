/** `SlackWorkspace` over Slack's Web API with the bot token: email lookups, message updates, ephemeral replies. */
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { makeSlackWebApi } from "../connections/slack.ts";
import { SlackWorkspace, SlackWorkspaceError } from "./slack-approvals.ts";

const UserInfo = Schema.Struct({
  user: Schema.Struct({
    deleted: Schema.optionalKey(Schema.Boolean),
    is_bot: Schema.optionalKey(Schema.Boolean),
    profile: Schema.Struct({ email: Schema.optionalKey(Schema.String) }),
  }),
});

/** A response URL is Slack's; anything else is refused rather than posted to. */
const isSlackResponseUrl = (url: string) => url.startsWith("https://hooks.slack.com/");

const failed = (error: { readonly message: string }) =>
  new SlackWorkspaceError({ message: error.message });

/** `origin` and `isResponseUrl` are for tests, which serve both locally. */
export const makeSlackWebWorkspace = (
  token: Redacted.Redacted<string>,
  origin = "https://slack.com/api/",
  isResponseUrl: (url: string) => boolean = isSlackResponseUrl,
) => {
  const { call } = makeSlackWebApi(token, origin);
  return SlackWorkspace.of({
    // `users.info` gives the email address only with the `users:read.email` scope.
    emailOf: Effect.fn("SlackWorkspace.emailOf")(function* (user: string) {
      const info = yield* call("users.info", { user }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(UserInfo)),
      );
      const email = info.user.profile.email;
      return info.user.deleted === true || info.user.is_bot === true ? undefined : email;
    }, Effect.mapError(failed)),
    updateMessage: Effect.fn("SlackWorkspace.updateMessage")(function* (channel, ts, message) {
      yield* call("chat.update", { channel, ts, text: message.text, blocks: message.blocks });
    }, Effect.mapError(failed)),
    // A response URL is its own credential: it takes no token and answers with a status.
    replyEphemeral: Effect.fn("SlackWorkspace.replyEphemeral")(
      function* (responseUrl, text) {
        if (!isResponseUrl(responseUrl)) {
          return yield* new SlackWorkspaceError({ message: "Not a Slack response URL" });
        }
        const client = yield* HttpClient.HttpClient;
        const response = yield* client
          .execute(
            HttpClientRequest.post(responseUrl).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                response_type: "ephemeral",
                replace_original: false,
                text,
              }),
            ),
          )
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError(
              (error) =>
                new SlackWorkspaceError({ message: `Slack response_url failed: ${String(error)}` }),
            ),
          );
        if (response.status < 200 || response.status >= 300) {
          return yield* new SlackWorkspaceError({
            message: `Slack response_url answered ${response.status}`,
          });
        }
      },
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  });
};
