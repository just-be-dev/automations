/** The namer titles a studio agent thread from the person's first message. */

import { expect } from "bun:test";
import { threadNamer } from "./calls/thread-namer.ts";
import { defineEval } from "./framework/eval.ts";
import { Expected, expectMatch } from "./framework/expected.ts";

const words = (name: string) => name.split(/\s+/).filter((word) => word !== "");

export default defineEval({
  call: threadNamer,
  minimum: 0.9,
  every: {
    "the model names it": (output) => expect(output.fallback).toBe(false),
    "2 to 5 words": (output) => {
      expect(words(output.name).length).toBeGreaterThanOrEqual(2);
      expect(words(output.name).length).toBeLessThanOrEqual(5);
    },
    // After the first word, only names keep a capital, and a name comes from the message.
    "sentence case, not Title Case": (output, message) => {
      const named = new Set(message.match(/\b[A-Z]\w*/g));
      const titled = words(output.name)
        .slice(1)
        .filter((word) => /^[A-Z][a-z]/.test(word) && !named.has(word));
      expect(titled).toEqual([]);
    },
    "no quotes or closing punctuation": (output) =>
      expect(output.name).not.toMatch(/["“”`*]|[.!?:;,]$/),
    // The title names the subject, not the request to the assistant.
    "names the subject, not the request": (output) =>
      expect(output.name).not.toMatch(/^(help|can you|please|i want|i need|create|make)\b/i),
  },
  checks: {
    /** The title the thread gets. */
    name: { value: Expected, check: (expected) => (output) => expectMatch(output.name, expected) },
  },
});
