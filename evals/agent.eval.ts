/** Agent steps do one piece of work in a run, and record text or the fields they're asked for. */

import { expect } from "bun:test";
import * as Schema from "effect/Schema";
import { agent } from "./calls/agent.ts";
import { defineEval, judged } from "./framework/eval.ts";
import { Expected, expectMatch } from "./framework/expected.ts";

export default defineEval({
  call: agent,
  minimum: 0.8,
  every: {
    "answers in the shape the step asks for": (output) => expect(output.problem).toBeUndefined(),
  },
  checks: {
    /** What the step records: its text, or its fields. */
    result: {
      value: Expected,
      check: (expected) => (output) => expectMatch(output.result, expected, "result"),
    },
    /** A criterion the judge grades the step's answer on. */
    judge: {
      value: Schema.String,
      check: (criterion) => judged(criterion, (output) => output.answer),
    },
  },
});
