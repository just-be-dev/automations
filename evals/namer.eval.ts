/** The namer titles a new automation from its description. */

import { expect } from "bun:test";
import { namer } from "./calls/namer.ts";
import { defineEval } from "./framework/eval.ts";
import { Expected, expectMatch } from "./framework/expected.ts";

const words = (name: string) => name.split(/\s+/).filter((word) => word !== "");

export default defineEval({
  call: namer,
  minimum: 0.9,
  every: {
    "the model names it": (output) => expect(output.fallback).toBe(false),
    "2 to 5 words": (output) => {
      expect(words(output.name).length).toBeGreaterThanOrEqual(2);
      expect(words(output.name).length).toBeLessThanOrEqual(5);
    },
    // After the first word, only names keep a capital, and a name comes from the description.
    "sentence case, not Title Case": (output, description) => {
      const named = new Set(description.match(/\b[A-Z]\w*/g));
      const titled = words(output.name)
        .slice(1)
        .filter((word) => /^[A-Z][a-z]/.test(word) && !named.has(word));
      expect(titled).toEqual([]);
    },
    "no quotes or closing punctuation": (output) =>
      expect(output.name).not.toMatch(/["“”`*]|[.!?:;,]$/),
  },
  checks: {
    /** The name the automation gets. */
    name: { value: Expected, check: (expected) => (output) => expectMatch(output.name, expected) },
  },
});
