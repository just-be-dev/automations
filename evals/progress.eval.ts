import { expect } from "bun:test";
import type { ProgressPhrase } from "../src/agents/planner/planner.ts";
import { progress, type ProgressOutput } from "./calls/progress.ts";
import { defineEval } from "./framework/eval.ts";

/**
 * The progress classifier picks the phrase the studio shows from the planner's latest reasoning.
 * Each input is reasoning written the way the planner reasons; each case accepts the phrases a
 * person would find accurate.
 */

const picks = (...phrases: ReadonlyArray<ProgressPhrase>) => ({
  [`picks ${phrases.join(" or ")}`]: (output: ProgressOutput) =>
    expect(output.phrase).toBeOneOf(phrases),
});

export default defineEval({
  call: progress,
  minimum: 0.8,
  every: {
    "picks a phrase confidently": (output) => expect(output.problem).toBeUndefined(),
  },
  cases: {
    understanding: {
      input:
        "The person says they want something to happen 'when new people join'. Do they mean employees or contractors? They mention a start date and a manager, which are employee fields, so this is about employee records. They haven't said what should happen first.",
      checks: picks("understanding"),
    },
    planning: {
      input:
        "So the steps are: wait until the start date, then send the welcome email, then post the heads-up to the manager. The welcome should come after the wait. Three top-level steps: wait, welcome, heads_up.",
      checks: picks("planning"),
    },
    timing: {
      input:
        "The reminder should go three days before the start date, so a wait until employee.start_date with offset -3 days. For the weekly one, the cron is 0 9 * * 1 in Europe/London.",
      checks: picks("timing"),
    },
    people: {
      input:
        "Who approves the email? People Ops is responsible for anything sent to new hires, so email.send should ask people_ops. The manager needs to confirm the meeting time, so a human step assigned to employee.manager, notified on Slack.",
      checks: picks("people"),
    },
    paths: {
      input:
        "Engineers and everyone else need different handling. Should this be an if step on employee.role, or a decide step, since roles are free text like 'Senior Backend Developer'? If no case matches, the otherwise branch should still run something.",
      checks: picks("paths"),
    },
    connections: {
      input:
        "They want the new hire's record sent to their HR system. That's http.post to a webhook, but I don't know the URL and must not invent one. The body can default to the subject.",
      checks: picks("connections"),
    },
    messages: {
      input:
        "There's a welcome_engineer template and a welcome_general one. The engineering one fits engineers; the general one fits everyone else. I'll fill the hire slot with {{employee}} and match on employee.role to choose between them.",
      checks: picks("messages"),
    },
    checking: {
      input:
        "check_workflow says steps.notify reads steps.approve, which might not have run on every path. I need to move notify inside the approved branch, then check again.",
      checks: picks("checking"),
    },
    "timing-or-planning": {
      input:
        "After the meeting is booked, wait two days and then follow up on Slack. That adds a wait step of 2 days and a follow-up step at the end.",
      checks: picks("timing", "planning"),
    },
    "people-or-messages": {
      input:
        "The manager should get the heads-up, not the new hire. The manager_heads_up template is for that, sent to {{employee.manager}} on Slack.",
      checks: picks("people", "messages"),
    },
  },
});
