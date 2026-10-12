import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { json } from "./response.ts";

export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()(
  "TranscriptionError",
  { message: Schema.String },
) {}

export class Transcription extends Context.Service<
  Transcription,
  {
    readonly connect: (
      sampleRate: number,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, TranscriptionError>;
  }
>()("studio/Transcription") {}

const Parameters = Schema.Struct({
  sample_rate: Schema.Literals(["16000", "24000", "44100", "48000"]),
});

export const transcriptionRoutes = HttpRouter.add(
  "GET",
  "/api/transcription",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.upgrade?.toLowerCase() !== "websocket") {
      return json({ error: "A WebSocket connection is required" }, 426);
    }
    const url = new URL(request.originalUrl, `https://${request.headers.host}`);
    if (request.headers.origin !== url.origin) {
      return json({ error: "Transcription requires a same-origin browser connection" }, 403);
    }
    const parameters = yield* Schema.decodeUnknownEffect(Parameters)(
      Object.fromEntries(url.searchParams),
    );
    const transcription = yield* Transcription;
    return yield* transcription.connect(Number(parameters.sample_rate));
  }).pipe(
    Effect.tapError((error) => Effect.logWarning("Transcription connection failed", error)),
    Effect.orElseSucceed(() => json({ error: "Unable to connect to transcription" }, 400)),
  ),
);
