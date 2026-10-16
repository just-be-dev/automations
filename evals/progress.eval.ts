/**
 * The progress classifier picks the phrase the studio shows from the planner's latest reasoning.
 * Each input is reasoning written the way the planner reasons; each case accepts the phrases a
 * person would find accurate.
 */

import { expect } from "bun:test";
import { progress } from "./calls/progress.ts";
import { defineEval } from "./framework/eval.ts";
import { Expected, expectMatch } from "./framework/expected.ts";

export default defineEval({
  call: progress,
  minimum: 0.9,
  every: {
    "picks a phrase confidently": (output) => expect(output.problem).toBeUndefined(),
  },
  checks: {
    /** The phrase it picks. */
    phrase: {
      value: Expected,
      check: (expected) => (output) => expectMatch(output.phrase, expected, "phrase"),
    },
  },
});
