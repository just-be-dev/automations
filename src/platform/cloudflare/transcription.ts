import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { Transcription, TranscriptionError } from "../../http/transcription.ts";

export const TRANSCRIPTION_MODEL = "@cf/deepgram/nova-3";
const Control = Schema.Struct({ type: Schema.Literals(["KeepAlive", "CloseStream"]) });

export const workersAiTranscription = (ai: Ai) =>
  Transcription.of({
    connect: Effect.fn("Transcription.connect")(function* (sampleRate: number) {
      // NOTE: the generated Nova-3 input type describes batch audio, not its WebSocket parameters.
      const response = yield* Effect.tryPromise({
        try: async () => {
          const result: unknown = await Reflect.apply(ai.run, ai, [
            TRANSCRIPTION_MODEL,
            {
              encoding: "linear16",
              sample_rate: sampleRate,
              channels: 1,
              language: "en-US",
              interim_results: true,
              smart_format: true,
              punctuate: true,
              mip_opt_out: true,
            },
            { websocket: true },
          ]);
          return result;
        },
        catch: () => new TranscriptionError({ message: "Unable to connect to Nova-3" }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.instanceOf(Response))),
        Effect.mapError(() => new TranscriptionError({ message: "Unable to connect to Nova-3" })),
      );
      const upstream = response.webSocket;
      if (response.status !== 101 || upstream === null) {
        return yield* new TranscriptionError({ message: "Nova-3 did not accept the connection" });
      }
      return yield* Effect.sync(() => {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.binaryType = "arraybuffer";
        upstream.binaryType = "arraybuffer";
        server.accept();
        upstream.accept();
        const budget = { bytes: 0, closed: false };
        const close = (code = 1000, reason = "") => {
          if (budget.closed) {
            return;
          }
          budget.closed = true;
          clearTimeout(deadline);
          server.close(code, reason);
          upstream.close(1000, "");
        };
        const deadline = setTimeout(() => close(1008, "Recording limit reached"), 195_000);
        const send = (socket: WebSocket, data: string | ArrayBuffer) => {
          try {
            socket.send(data);
          } catch {
            close(1011, "Transcription disconnected");
          }
        };
        server.addEventListener("message", (event) => {
          if (budget.closed) {
            return;
          }
          const data = event.data;
          if (typeof data === "string") {
            if (data.length > 128) {
              close(1008, "Invalid control message");
              return;
            }
            const control = Schema.decodeOption(Schema.fromJsonString(Control))(data);
            if (control._tag === "None") {
              close(1008, "Invalid control message");
              return;
            }
            send(upstream, JSON.stringify(control.value));
          } else if (data instanceof ArrayBuffer) {
            budget.bytes += data.byteLength;
            if (
              data.byteLength > 32_000 ||
              data.byteLength % 2 !== 0 ||
              budget.bytes > sampleRate * 2 * 180
            ) {
              close(1009, "Audio limit reached");
              return;
            }
            send(upstream, data);
          } else {
            close(1008, "Invalid audio");
          }
        });
        upstream.addEventListener("message", (event) => {
          if (!budget.closed) {
            send(server, event.data);
          }
        });
        server.addEventListener("close", () => close());
        upstream.addEventListener("close", (event) =>
          close(
            event.code === 1000 ? 1000 : 1011,
            event.code === 1000 ? "" : "Transcription disconnected",
          ),
        );
        server.addEventListener("error", () => close(1011, "Transcription disconnected"));
        upstream.addEventListener("error", () => close(1011, "Transcription disconnected"));
        return HttpServerResponse.raw(new Response(null, { status: 101, webSocket: client }), {
          status: 101,
        });
      });
    }),
  });
