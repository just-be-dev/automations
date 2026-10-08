import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { runInNewContext } from "node:vm";
import { transcriptMessage } from "./audio.ts";

test("Nova result decoding separates interim and final and ignores metadata", () => {
  const result = {
    type: "Results",
    start: 2.5,
    duration: 0.75,
    is_final: false,
    channel: { alternatives: [{ transcript: "The invoice" }] },
  };
  expect(Option.getOrThrow(transcriptMessage(4, JSON.stringify(result)))).toEqual({
    _tag: "UpdatedTranscript",
    sequence: 4,
    text: "The invoice",
    segment: "2.5",
    isFinal: false,
  });
  expect(
    Option.getOrThrow(
      transcriptMessage(4, JSON.stringify({ ...result, duration: 2, is_final: true })),
    ),
  ).toEqual({
    _tag: "UpdatedTranscript",
    sequence: 4,
    text: "The invoice",
    segment: "2.5",
    isFinal: true,
  });
  expect(Option.isNone(transcriptMessage(4, JSON.stringify({ type: "Metadata" })))).toBe(true);
  expect(() => transcriptMessage(4, JSON.stringify({ type: "Error" }))).toThrow();
  expect(() => transcriptMessage(4, JSON.stringify({ ...result, start: "2.5" }))).toThrow();
});

test("the worklet produces clipped mono little-endian PCM16 and flushes the last frame before acknowledgement", async () => {
  const posted: Array<ArrayBuffer | string> = [];
  const port = {
    onmessage: () => {},
    postMessage: (value: ArrayBuffer | string) => posted.push(value),
  };
  const registered: { process?: (inputs: Array<Array<Float32Array>>) => boolean } = {};
  runInNewContext(
    await Bun.file(new URL("../../../public/dictation-worklet.js", import.meta.url)).text(),
    {
      AudioWorkletProcessor: class {
        port = port;
      },
      registerProcessor: (
        name: string,
        Processor: new () => { process: (inputs: Array<Array<Float32Array>>) => boolean },
      ) => {
        expect(name).toBe("dictation");
        const processor = new Processor();
        registered.process = (inputs) => processor.process(inputs);
      },
    },
  );
  registered.process?.([
    [new Float32Array([-2, -0.5, 0, 0.25, 2]), new Float32Array([0.9, 0.9, 0.9, 0.9, 0.9])],
  ]);
  expect(posted).toEqual([]);
  port.onmessage();
  expect(Array.from(new Uint8Array(posted[0] as ArrayBuffer))).toEqual([
    0, 128, 0, 192, 0, 0, 0, 32, 255, 127,
  ]);
  expect(posted[1]).toBe("flushed");
  registered.process?.([[new Float32Array(1025).fill(-1)]]);
  expect((posted[2] as ArrayBuffer).byteLength).toBe(2048);
  port.onmessage();
  expect(Array.from(new Uint8Array(posted[3] as ArrayBuffer))).toEqual([0, 128]);
  expect(posted[4]).toBe("flushed");
});
