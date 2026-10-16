import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { Command, Dom, Http } from "foldkit";
import { AssistantState, AssistantThread } from "../../assistant/model.ts";
import { errorText, requestJson } from "../api.ts";
import { Message } from "./message.ts";

const sessionKey = "studio-assistant-session";
const collapsedKey = "studio-assistant-collapsed";
export const inputId = "assistant-input";
const Threads = Schema.Struct({ threads: Schema.Array(AssistantThread) });

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
/** Starts a thread under a new session ID, remembered as the one this browser opens next. */
export const CreateThread = Command.define("CreateThread", {
  args: { input: Schema.String },
  messages: [Message.CompletedCreateThread, Message.FailedCreateThread],
  execute: ({ input }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const sessionId = yield* crypto.randomUUIDv4;
      yield* Effect.try(() => localStorage.setItem(sessionKey, sessionId));
      return Message.CompletedCreateThread({ sessionId, input });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedCreateThread({ error: errorText(error) })),
      ),
      Effect.provide(BrowserCrypto.layer),
    ),
});
/** Remembers the thread this browser opens next. */
export const PersistSession = Command.define("PersistSession", {
  args: { sessionId: Schema.String },
  messages: [Message.CompletedPersistSession],
  execute: ({ sessionId }) =>
    Effect.try(() => localStorage.setItem(sessionKey, sessionId)).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedPersistSession()),
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
export const FocusInput = Command.define("FocusInput", {
  messages: [Message.CompletedFocusInput],
  execute: Dom.focus(`#${inputId}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusInput())),
});
export const LoadThreads = Command.define("LoadThreads", {
  messages: [Message.SucceededLoadThreads, Message.FailedLoadThreads],
  execute: requestJson("/api/assistant", Threads).pipe(
    Effect.map(({ threads }) => Message.SucceededLoadThreads({ threads })),
    Effect.catch((error) => Effect.succeed(Message.FailedLoadThreads({ error: errorText(error) }))),
    Effect.provide(Http.layer),
  ),
});
export const ArchiveThread = Command.define("ArchiveThread", {
  args: { sessionId: Schema.String, archived: Schema.Boolean },
  messages: [Message.SucceededArchiveThread, Message.FailedArchiveThread],
  execute: ({ sessionId, archived }) =>
    requestJson(`/api/assistant/${sessionId}/archive`, Threads, { archived }).pipe(
      Effect.map(({ threads }) => Message.SucceededArchiveThread({ sessionId, archived, threads })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedArchiveThread({ error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
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
