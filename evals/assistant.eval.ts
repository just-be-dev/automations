import { expect } from "bun:test";
import { assistant } from "./calls/assistant.ts";
import { defineEval } from "./framework/eval.ts";
import { actionTemplates, flattenSteps } from "../src/workflow/model.ts";

export default defineEval({
  call: assistant,
  minimum: 0.9,
  every: {
    "finishes the turn": (output) => expect(output.state.status).toBe("idle"),
    "reads before editing": (output) => expect(output.toolCalls).toContain("read_studio"),
  },
  cases: {
    "template-then-draft": {
      input: {
        message:
          "Create an onboarding email template named onboarding_email with description 'Welcome new employees', subject Welcome and body 'Glad you are here'. No slots needed. Then draft a manual automation that emails employee sam@example.com using onboarding_email. Do not save or start it.",
        approve: true,
      },
      checks: {
        "creates the requested template": (output) =>
          expect(
            output.changes.some(
              (c) =>
                c.kind === "putTemplate" &&
                c.template.name === "onboarding_email" &&
                c.template.description === "Welcome new employees",
            ),
          ).toBe(true),
        "passes exact template name to planner": (output) =>
          expect(output.descriptions.join("\n")).toContain("onboarding_email"),
        "planner uses template": (output) =>
          expect(
            output.workflows
              .flatMap((w) => flattenSteps(w.steps))
              .flatMap((step) =>
                step.kind === "action" ? actionTemplates(step).map((t) => t.use) : [],
              ),
          ).toContain("onboarding_email"),
        "activities complete from outcomes": (output) =>
          expect(
            output.state.activities.filter((a) => a.status === "completed").length,
          ).toBeGreaterThanOrEqual(2),
      },
    },
    cancellation: {
      input: {
        message:
          "Create a template named simple_welcome, description 'A friendly greeting', subject Welcome, body Hello, no slots. If I cancel do not try again.",
        approve: false,
      },
      checks: {
        "does not write after cancellation": (output) => expect(output.changes).toEqual([]),
        "reports cancellation": (output) =>
          expect(output.state.activities.some((a) => a.status === "cancelled")).toBe(true),
      },
    },
  },
});
