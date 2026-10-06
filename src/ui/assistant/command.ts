import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { Command, Http } from "foldkit";
import { AssistantState } from "../../assistant/model.ts";
import { errorText, requestJson } from "../api.ts";
import { Message } from "./message.ts";

const sessionKey = "studio-assistant-session";
const collapsedKey = "studio-assistant-collapsed";
export const RestoreAssistant = Command.define("RestoreAssistant", {
  messages: [Message.CompletedRestoreAssistant, Message.FailedRestoreAssistant],
  execute: Effect.gen(function* () {
    const saved = yield* Effect.try(() => localStorage.getItem(sessionKey));
    const crypto = yield* Crypto.Crypto;
    const maybeSaved = Schema.decodeUnknownOption(Schema.String.check(Schema.isUUID(4)))(saved);
    const sessionId = Option.isSome(maybeSaved) ? maybeSaved.value : yield* crypto.randomUUIDv4;
    yield* Effect.try(() => localStorage.setItem(sessionKey, sessionId));
    const collapsed = yield* Effect.try(() => localStorage.getItem(collapsedKey) === "true");
    return Message.CompletedRestoreAssistant({ sessionId, collapsed });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(Message.FailedRestoreAssistant({ error: errorText(error) })),
    ),
    Effect.provide(BrowserCrypto.layer),
  ),
});
export const PersistCollapsed = Command.define("PersistCollapsed", {
  args: { collapsed: Schema.Boolean },
  messages: [Message.CompletedPersistCollapsed],
  execute: ({ collapsed }) =>
    Effect.try(() => localStorage.setItem(collapsedKey, String(collapsed))).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedPersistCollapsed()),
    ),
});
export const RequestAssistant = Command.define("RequestAssistant", {
  args: {
    sessionId: Schema.String,
    sequence: Schema.Int,
    path: Schema.String,
    body: Schema.Option(Schema.Json),
    delay: Schema.Int,
    sentInput: Schema.String,
  },
  messages: [Message.SucceededRequest, Message.FailedRequest],
  execute: ({ sessionId, sequence, path, body, delay, sentInput }) =>
    Effect.sleep(`${delay} millis`).pipe(
      Effect.andThen(
        requestJson(
          `/api/assistant/${sessionId}${path}`,
          AssistantState,
          body._tag === "Some" ? body.value : undefined,
        ),
      ),
      Effect.map((state) => Message.SucceededRequest({ sessionId, sequence, state, sentInput })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedRequest({ sessionId, sequence, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});
