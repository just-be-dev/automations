/** Decide steps pick the option that routes a run, with clef-flash unless a case names clef. */

import { expect } from "bun:test";
import { decide } from "./calls/decide.ts";
import { defineEval } from "./framework/eval.ts";
import { Expected, expectMatch } from "./framework/expected.ts";

export default defineEval({
  call: decide,
  minimum: 0.9,
  every: {
    "answers with a decision": (output) => expect(output.problem).toBeUndefined(),
    "picks one of the options": (output, input) =>
      expect(output.choice).toBeOneOf(Object.keys(input.options)),
    "confidence between 0 and 1": (output) => {
      expect(output.confidence).toBeGreaterThanOrEqual(0);
      expect(output.confidence).toBeLessThanOrEqual(1);
    },
  },
  checks: {
    /** The option it picks. */
    choice: {
      value: Expected,
      check: (expected) => (output) => expectMatch(output.choice, expected, "choice"),
    },
  },
});
