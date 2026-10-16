/** The studio assistant reads the studio, proposes changes, and hands drafts to the planner. */

import { expect } from "bun:test";
import * as Schema from "effect/Schema";
import { AssistantActivity } from "../src/assistant/model.ts";
import { actionTemplates, flattenSteps } from "../src/workflow/model.ts";
import { assistant } from "./calls/assistant.ts";
import { defineEval } from "./framework/eval.ts";
import { Expected, ExpectedText, expectMatch, expectText } from "./framework/expected.ts";

export default defineEval({
  call: assistant,
  minimum: 0.9,
  every: {
    "finishes the turn": (output) => expect(output.state.status).toBe("idle"),
    "reads before editing": (output) => expect(output.toolCalls).toContain("read_studio"),
  },
  checks: {
    /** The changes it wrote, each as it was applied. */
    changes: {
      value: Expected,
      check: (expected) => (output) => expectMatch(output.changes, expected, "changes"),
    },
    /** What it asked the planner to draft, every request together. */
    delegated: {
      value: ExpectedText,
      check: (expected) => (output) =>
        expectText(output.descriptions.join("\n"), expected, "what it asked for"),
    },
    /** The names of the templates the drafted workflows use. */
    templatesUsed: {
      value: Expected,
      check: (expected) => (output) =>
        expectMatch(
          output.workflows
            .flatMap((workflow) => flattenSteps(workflow.steps))
            .flatMap((step) =>
              step.kind === "action" ? actionTemplates(step).map((use) => use.use) : [],
            ),
          expected,
          "templates used",
        ),
    },
    /** The automations it handed drafts to, in order. */
    drafted: {
      value: Expected,
      check: (expected) => (output) => expectMatch(output.drafted, expected, "drafted automations"),
    },
    /** How many different automations it handed drafts to; following up on one counts once. */
    automations: {
      value: Schema.Int,
      check: (count) => (output) => expect(new Set(output.drafted).size).toBe(count),
    },
    /** The operations the drafted workflows use. */
    operationsUsed: {
      value: Expected,
      check: (expected) => (output) =>
        expectMatch(
          output.workflows
            .flatMap((workflow) => flattenSteps(workflow.steps))
            .flatMap((step) => (step.kind === "action" ? [step.use] : [])),
          expected,
          "operations used",
        ),
    },
    /** At least this many of its activities end with this status. */
    activities: {
      value: Schema.Struct({
        status: AssistantActivity.fields.status,
        atLeast: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      }),
      check:
        ({ status, atLeast }) =>
        (output) =>
          expect(
            output.state.activities.filter((activity) => activity.status === status).length,
          ).toBeGreaterThanOrEqual(atLeast),
    },
  },
});
