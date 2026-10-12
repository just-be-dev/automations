import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Subscription } from "foldkit";
import { Message, type Model, maybeSession } from "./index.ts";

const Result = Schema.Struct({
  type: Schema.Literal("Results"),
  start: Schema.Finite,
  duration: Schema.Finite,
  is_final: Schema.Boolean,
  channel: Schema.Struct({
    alternatives: Schema.Array(Schema.Struct({ transcript: Schema.String })),
  }),
});
const Event = Schema.Struct({ type: Schema.String });

export const transcriptMessage = (sequence: number, data: unknown): Option.Option<Message> => {
  const event = Schema.decodeUnknownSync(Schema.fromJsonString(Event))(data);
  if (event.type === "Error") {
    throw new Error("The transcription service reported an error. Please try again.");
  }
  if (event.type !== "Results") {
    return Option.none();
  }
  const result = Schema.decodeUnknownSync(Schema.fromJsonString(Result))(data);
  const text = result.channel.alternatives[0]?.transcript ?? "";
  return Option.some(
    Message.UpdatedTranscript({
      sequence,
      text,
      segment: String(result.start),
      isFinal: result.is_final,
    }),
  );
};

const recording = (sequence: number, stopping: () => boolean) =>
  Stream.callback<Message>((queue) =>
    Effect.gen(function* () {
      const emit = (message: Message) => Queue.offerUnsafe(queue, message);
      const stream = yield* Effect.acquireRelease(
        Effect.tryPromise(async (signal) => {
          if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
            throw new Error("Dictation needs a secure browser connection and microphone support.");
          }
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
          });
          if (signal.aborted) {
            stream.getTracks().forEach((track) => track.stop());
          }
          return stream;
        }),
        (stream) => Effect.sync(() => stream.getTracks().forEach((track) => track.stop())),
        { interruptible: true },
      );
      const context = yield* Effect.acquireRelease(
        Effect.try(() => new AudioContext({ sampleRate: 16000 })),
        (context) => Effect.promise(() => context.close()).pipe(Effect.ignore),
      );
      yield* Effect.tryPromise(() => context.resume());
      yield* Effect.tryPromise(() => context.audioWorklet.addModule("/dictation-worklet.js"));
      const url = new URL("/api/transcription", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("sample_rate", String(context.sampleRate));
      const socket = yield* Effect.acquireRelease(
        Effect.try(() => new WebSocket(url)),
        (socket) => Effect.sync(() => socket.close(1000, "Dictation ended")),
      );
      const lifecycle = { finishing: false, closed: false };
      yield* Effect.tryPromise(
        () =>
          new Promise<void>((resolve, reject) => {
            socket.onopen = () => resolve();
            socket.onerror = () =>
              reject(new Error("Unable to connect to transcription. Please try again."));
            socket.onclose = () =>
              reject(new Error("Transcription disconnected before recording started."));
          }),
      ).pipe(Effect.timeout("15 seconds"));
      socket.onmessage = (event) => {
        try {
          const message = transcriptMessage(sequence, event.data);
          if (Option.isSome(message)) {
            emit(message.value);
          }
        } catch {
          emit(
            Message.FailedStream({
              sequence,
              error: "Unable to read the transcript. Please try again.",
            }),
          );
        }
      };
      socket.onerror = () =>
        emit(
          Message.FailedStream({
            sequence,
            error: "Transcription disconnected. Your draft is still in your message.",
          }),
        );
      socket.onclose = (event) => {
        lifecycle.closed = true;
        emit(
          lifecycle.finishing && event.code === 1000
            ? Message.CompletedStream({ sequence })
            : Message.FailedStream({
                sequence,
                error:
                  event.reason ||
                  "Transcription disconnected. Your draft is still in your message.",
              }),
        );
        Queue.endUnsafe(queue);
      };
      const source = context.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(context, "dictation");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          source.disconnect();
          processor.disconnect();
          processor.port.close();
        }),
      );
      processor.port.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer && socket.readyState === WebSocket.OPEN) {
          if (socket.bufferedAmount > 64_000) {
            emit(
              Message.FailedStream({
                sequence,
                error: "The connection is too slow for dictation. Please try again.",
              }),
            );
            return;
          }
          socket.send(event.data);
        }
      };
      source.connect(processor);
      processor.connect(context.destination);
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          if (!lifecycle.finishing) {
            emit(Message.FailedStream({ sequence, error: "Microphone disconnected." }));
          }
        };
      });
      emit(Message.SucceededConnect({ sequence }));
      yield* Effect.gen(function* () {
        yield* Effect.sleep("50 millis");
        return stopping();
      }).pipe(
        Effect.repeat({ until: (stop) => stop }),
        Effect.timeoutOrElse({ duration: "175 seconds", orElse: () => Effect.succeed(false) }),
      );
      if (!stopping()) {
        emit(Message.CompletedRecordingLimit({ sequence }));
      }
      lifecycle.finishing = true;
      stream.getTracks().forEach((track) => track.stop());
      source.disconnect();
      yield* Effect.tryPromise(
        () =>
          new Promise<void>((resolve) => {
            const listener = (event: MessageEvent) => {
              if (event.data === "flushed") {
                processor.port.removeEventListener("message", listener);
                resolve();
              }
            };
            processor.port.addEventListener("message", listener);
            processor.port.postMessage("flush");
          }),
      ).pipe(Effect.timeout("2 seconds"));
      processor.disconnect();
      socket.send(JSON.stringify({ type: "CloseStream" }));
      yield* Effect.gen(function* () {
        yield* Effect.sleep("50 millis");
        return lifecycle.closed;
      }).pipe(Effect.repeat({ until: (closed) => closed }), Effect.timeout("10 seconds"));
    }).pipe(
      Effect.catch(() =>
        Queue.offer(
          queue,
          Message.FailedStream({
            sequence,
            error:
              "Dictation failed. Check microphone permission and your connection, then try again.",
          }),
        ),
      ),
      Effect.ensuring(Queue.end(queue)),
    ),
  );

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  microphone: entry(
    { maybeSession: Schema.Option(Schema.Int), stopping: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        maybeSession: maybeSession(model),
        stopping: model.status._tag === "Finishing",
      }),
      keepAliveEquivalence: (left, right) =>
        Option.makeEquivalence<number>((a, b) => a === b)(left.maybeSession, right.maybeSession),
      dependenciesToStream: ({ maybeSession }, read) =>
        Option.match(maybeSession, {
          onNone: () => Stream.empty,
          onSome: (sequence) => recording(sequence, () => read().stopping),
        }),
    },
  ),
}));
