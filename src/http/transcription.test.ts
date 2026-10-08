import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Transcription, TranscriptionError, transcriptionRoutes } from "./transcription.ts";

test("transcription checks upgrade, origin and sample rate before calling AI", async () => {
  const rates: Array<number> = [];
  const app = HttpRouter.toWebHandler(
    transcriptionRoutes.pipe(
      Layer.provideMerge(
        Layer.succeed(Transcription, {
          connect: (rate) =>
            Effect.sync(() => {
              rates.push(rate);
              return HttpServerResponse.empty({ status: 204 });
            }),
        }),
      ),
    ),
    { disableLogger: true },
  );
  try {
    const cases: Array<{ headers: Record<string, string>; rate: string; status: number }> = [
      { headers: {}, rate: "16000", status: 426 },
      { headers: { upgrade: "websocket" }, rate: "16000", status: 403 },
      {
        headers: { upgrade: "websocket", origin: "https://evil.test" },
        rate: "16000",
        status: 403,
      },
      { headers: { upgrade: "websocket", origin: "http://studio" }, rate: "16000", status: 403 },
      { headers: { upgrade: "websocket", origin: "https://studio" }, rate: "0", status: 400 },
      { headers: { upgrade: "websocket", origin: "https://studio" }, rate: "", status: 400 },
    ];
    for (const entry of cases) {
      const response = await app.handler(
        new Request(`https://studio/api/transcription?sample_rate=${entry.rate}`, {
          headers: entry.headers,
        }),
      );
      expect(response.status).toBe(entry.status);
      const data: unknown = await response.json();
      expect(data).toEqual({ error: expect.any(String) });
    }
    expect(rates).toEqual([]);
    for (const rate of [16000, 24000, 44100, 48000]) {
      const response = await app.handler(
        new Request(`http://localhost:1338/api/transcription?sample_rate=${rate}`, {
          headers: { upgrade: "WebSocket", origin: "http://localhost:1338" },
        }),
      );
      expect(response.status).toBe(204);
    }
    expect(rates).toEqual([16000, 24000, 44100, 48000]);
  } finally {
    await app.dispose();
  }
});

test("transcription connection failures preserve the public error shape", async () => {
  const app = HttpRouter.toWebHandler(
    transcriptionRoutes.pipe(
      Layer.provideMerge(
        Layer.succeed(Transcription, {
          connect: () =>
            Effect.fail(new TranscriptionError({ message: "Private provider details" })),
        }),
      ),
    ),
    { disableLogger: true },
  );
  try {
    const response = await app.handler(
      new Request("https://studio/api/transcription?sample_rate=16000", {
        headers: { upgrade: "websocket", origin: "https://studio" },
      }),
    );
    const data: unknown = await response.json();
    expect(data).toEqual({ error: "Unable to connect to transcription" });
  } finally {
    await app.dispose();
  }
});
