import * as Effect from "effect/Effect";
import type { PiError, PromptOptions } from "./pi.ts";
import { decodeDraft, type InvalidWorkflow } from "./workflow.ts";

/**
 * The designer agent: the instructions it answers chat messages with, and how its reply becomes a
 * draft.
 */

export const designInstructions = `You design executable automations. Always respond with ONLY JSON: {"reply":"brief helpful explanation or question","workflow":Workflow}. Include the COMPLETE revised workflow on every turn.

Workflow: {"name":"...","event":null or an identifier for an externally POSTed event (not a timer),"steps":[Step, ...]} with 1–20 top-level steps.

Every step has an "id" (letters, digits, - and _), a short "title", and a "kind". IDs must be unique across the WHOLE workflow, nested steps included, and stay stable between turns. Steps in a list run in order. The kinds:
- {"kind":"agent","instruction":"..."}: an AI agent does the work described.
- {"kind":"webhook","url":"https://..."}: POSTs the run so far to a public HTTPS URL. Never invent URLs; ask for them and use an agent step until provided.
- {"kind":"wait","duration":"3 days"} or {"kind":"wait","until":"input.start_date","offset":"-7 days"}: pauses the run for a while, or until a date shifted by an optional offset. Durations are "<number> minutes|hours|days|weeks"; offsets may start with "-".
- {"kind":"parallel","branches":[[Step, ...], [Step, ...]]}: 2–8 branches run at the same time; the run continues once every branch finishes.
- {"kind":"if","cases":[{"when":Condition,"steps":[Step, ...]}],"otherwise":[Step, ...]}: runs the steps of the first case whose condition holds, else "otherwise" (optional). Use it for checks on data.
- {"kind":"decide","model":"clef-flash" or "clef","question":"...","options":[{"id":"...","description":"...","steps":[Step, ...]}]}: a decision model reads the run so far and picks one of 2–8 options, then runs its steps. Use it for judgment calls; clef-flash for simple routing, clef for nuanced decisions.
- {"kind":"human","prompt":"...","assignee":"...","response":"approval" or {"fields":[{"name":"snake_case","label":"...","type":"text" or "number" or "boolean" or "date"}]},"timeout":"2 days"}: pauses until a person approves or rejects, or fills in the fields. "assignee" and "timeout" are optional.

Condition: {"ref":Ref,"op":"equals" or "notEquals" or "greaterThan" or "lessThan" or "contains","value":any JSON} or {"ref":Ref,"op":"exists"} or {"all":[Condition, ...]} or {"any":[Condition, ...]} or {"not":Condition}.
Ref: "input.<field>" reads the run input. "steps.<id>.<field>" reads what an earlier step recorded: agent and webhook steps record "output"; decide steps "choice" (the option id) and "confidence"; human steps "approved", "values.<field>", and "timedOut"; if steps "matched". A Ref is always one of those dotted paths, never a bare name or a {{variable}}.

Design guidance: use wait steps for timing instead of asking an agent to schedule something; use parallel for independent work; use human steps for approvals and information only a person has, instead of asking an agent to confirm with someone; branch with if or decide instead of describing branches in prose. Keep lists flat when nesting adds nothing. Nest at most 4 levels deep and use at most 60 steps in total.

Variables: when a title, instruction, question, prompt, or assignee needs a value that changes on each run (a person, a date, an ID), write it as {{snake_case}} naming a field of the run input, e.g. {{new_hire_name}}. Where a Ref is expected ("until" and conditions), the same field is "input.new_hire_name". Use the same variable for the same value everywhere, and never write placeholders any other way, such as [new hire].

No secrets in the workflow.`;

/** Sent when a reply doesn't decode, so the agent sees why its answer was rejected. */
export const retryInstructions = (error: string) =>
  `Your last response was rejected because it is not a valid design:\n${error}\n\nFix the problem and respond again with ONLY JSON: {"reply":"...","workflow":Workflow}, including the COMPLETE revised workflow.`;

/**
 * Asks the designer agent to answer a chat message. A reply that doesn't decode gets one retry in
 * the same conversation with the decoding error. Each attempt has its own pi request ID, so a
 * redelivered callback waits for the original submissions instead of prompting again. pi failures
 * aren't the agent's mistake, so they aren't retried.
 */
export const designDraft = Effect.fn("Design.draft")(function* (
  prompt: (options: PromptOptions) => Effect.Effect<string, PiError>,
  chatId: string,
  message: string,
) {
  const ask = (requestId: string, text: string) =>
    prompt({ requestId, text }).pipe(Effect.flatMap(decodeDraft));
  return yield* ask(`chat:${chatId}`, `${designInstructions}\n\nUser: ${message}`).pipe(
    Effect.catchTag("InvalidWorkflow", (invalid: InvalidWorkflow) =>
      ask(`chat:${chatId}:retry`, retryInstructions(invalid.message)),
    ),
  );
});
