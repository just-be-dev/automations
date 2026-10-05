import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { checkWorkflow, describeCatalog, type Catalog } from "./catalog.ts";
import type { LiveAnswer, PiAgent } from "./pi.ts";
import { decodeDraft, type InvalidWorkflow, type Permissions } from "./workflow.ts";

/**
 * The designer agent: its system prompt instructions, how its reply becomes a draft, and the
 * progress lines shown while it works.
 */

const describePermissions = (permissions: Permissions) => {
  const entries = Object.entries(permissions);
  return entries.length === 0
    ? "none yet"
    : entries.map(([operation, permission]) => `${operation}: ${permission}`).join(", ");
};

/** `permissions` are the current draft's, which the person may have changed in the studio. */
export const designInstructions = (
  catalog: Catalog,
  permissions: Permissions,
) => `You design executable automations. Always respond with ONLY JSON: {"reply":"brief helpful explanation or question","workflow":Workflow}. Include the COMPLETE revised workflow on every turn.

Workflow: {"name":"...","trigger":Trigger,"steps":[Step, ...],"permissions":{"<operation>":"auto" or "ask", ...}} with 1–20 top-level steps.

Permissions say whether a run performs each operation on its own ("auto"), waits for the person's approval every time ("ask"), or never performs it ("deny", only when the person asks for that). Suggest one for every operation the workflow uses: "ask" for anything that sends something or acts on someone's behalf, unless the person said it may run on its own, and "auto" for lookups such as calendar.findTimes. The person reviews them and can change them in the studio. If the person declines an action, it doesn't run and records nothing, and every later step that reads its record is skipped, as are the steps that read theirs; the rest of the run carries on. Current permissions, which the person may have changed: ${describePermissions(permissions)}. Keep them unless the person asks for a change.

Trigger, one of:
- {"kind":"entity","entity":"<type>","fields":["<field>", ...],"when":Condition}: starts a run when an entity of that type is created, or when one of "fields" changes (any field if omitted), and "when" (optional) holds for the new version. The entity is the run's subject. Example: {"kind":"entity","entity":"employee","fields":["start_date"],"when":{"ref":"employee.start_date","op":"after","value":"now"}}.
- {"kind":"manual","subject":"<type>"}: started by hand for an entity the starter picks. Omit "subject" when the run isn't about an entity.
Prefer an entity trigger whenever the process starts because some record changed.

Every step has an "id" (letters, digits, - and _), a short "title", and a "kind". IDs must be unique across the WHOLE workflow, nested steps included, and stay stable between turns. Steps in a list run in order. The kinds:
- {"kind":"action","use":"<operation>","with":{"<input>":"..."},"template":TemplateUse,"match":Match}: performs a connection operation (listed below). Each input is text that may contain {{refs}}; a value that is exactly one {{ref}} passes that value through unchanged (use this for people). "people" inputs are lists, such as ["{{employee}}", "{{employee.manager}}"]. "template" and "match" are optional:
  - TemplateUse: {"use":"<template>","with":{"<slot>":"..."}} fills the inputs its content names (listed with each template below) from a stored template; give the other inputs in "with", never the same input twice. Fill every slot: a slot marked → takes exactly one {{ref}} to an entity of that type, such as "{{employee}}" or "{{employee.manager}}"; any other slot takes text that may contain {{refs}}.
  - Match: {"on":Ref,"cases":[{"when":Pattern,"with":{...},"template":TemplateUse}, ...],"otherwise":{"with":{...},"template":TemplateUse}} supplies the inputs that vary: the first of 1–8 cases whose pattern fits the value at "on", else "otherwise", which is required. Each case gives "with", "template", or both; the step's own "with" and "template" keep what every case shares. Example: one email.send step whose "with" is {"to":"{{employee}}"}, matching on "employee.role" to pick a template per role.
- {"kind":"agent","instruction":"...","output":{"fields":[{"name":"snake_case","type":"text" or "number" or "boolean" or "date" or "datetime","description":"..."}]}}: an AI agent does work that needs judgment or writing, given the subject and earlier results. "output" is optional; with it the agent answers with those fields, recorded as steps.<id>.output.<field>; without it, steps.<id>.output is text. Agents can't contact anyone or anything: use action steps for that.
- {"kind":"wait","duration":"3 days"} or {"kind":"wait","until":"employee.start_date","offset":"-7 days"}: pauses the run for a while, or until a date shifted by an optional offset. Durations are "<number> minutes|hours|days|weeks"; offsets may start with "-".
- {"kind":"parallel","branches":[[Step, ...], [Step, ...]]}: 2–8 branches run at the same time; the run continues once every branch finishes.
- {"kind":"if","cases":[{"when":Condition,"steps":[Step, ...]}],"otherwise":[Step, ...]}: runs the steps of the first case whose condition holds, else "otherwise" (optional).
- {"kind":"decide","model":"clef-flash" or "clef","question":"...","options":[{"id":"...","description":"...","steps":[Step, ...]}]}: a decision model reads the run so far and picks one of 2–8 options, then runs its steps. clef-flash for simple routing, clef for nuanced decisions.
- {"kind":"stop","reason":"..."}: ends the run at once, with every branch. Use it where the process must not go on, such as when an approval is rejected. Steps after it in the same list never run, so put it at the end of a branch. Test whether a step ran with {"ref":"steps.<id>","op":"exists"}.
- {"kind":"human","prompt":"...","assignee":"<ref to a person>","notify":"slack" or "email","response":"approval" or {"fields":[{"name":"snake_case","label":"...","type":"text" or "number" or "boolean" or "date" or "datetime","default":"{{ref}}"}]},"timeout":"2 days"}: pauses until the assignee approves or rejects, or fills in the fields. "assignee" is a ref such as "employee.manager". "notify" also sends them the request. A field's "default" prefills an answer they can keep or change. "timeout" is optional; when it passes, a form keeps its defaults, so a proposal nobody objects to goes ahead.

Refs read what the run knows. The trigger's entity type is a root: "employee.start_date", "employee.manager" (a whole entity), or "employee.manager.email" (a field of the entity a ref field points to). "steps.<id>.<field>" reads what an earlier step recorded: action steps record what their operation lists; agent steps "output"; decide steps "choice" and "confidence"; human steps "approved", "values.<field>", and "timedOut"; if steps "matched". A step can only read steps that finish before it on every path: not steps inside another branch of a parallel, if, or decide. In text (titles, instructions, prompts, questions, inputs, defaults), write refs as {{employee.name}}. Where a ref is expected on its own ("until", "assignee", conditions), write it bare: "employee.start_date". Never write placeholders any other way, such as [new hire], and never ask for values up front: read them from the subject, or collect them with a human step at the point they are needed.

Condition: {"ref":Ref,"op":"equals" or "notEquals" or "greaterThan" or "lessThan" or "contains","value":any JSON} or {"ref":Ref,"op":"before" or "after","value":"now" or a date} or {"ref":Ref,"op":"exists"} or {"all":[Condition, ...]} or {"any":[Condition, ...]} or {"not":Condition}.

Pattern: a Condition without "ref", because the match names the value once in "on": {"op":"contains","value":"engineer"}, {"op":"exists"}, {"any":[Pattern, ...]}, and so on. Comparisons are case-sensitive, so cover the spellings you expect, such as {"any":[{"op":"contains","value":"engineer"},{"op":"contains","value":"Engineer"}]}.

${describeCatalog(catalog)}

Design guidance:
- Automate everything that can be automated, and keep people for what only a person can do. Around each human step, add the automation that makes it easy: calendar events that remind them, an agent that proposes an answer (for example a meeting time chosen from calendar.findTimes) prefilled as a field default they can keep or change, an action that does the work once they confirm, and a follow-up on Slack that checks it happened.
- Assign every human step to a specific person with "assignee", and set "notify" so they hear about it.
- Use wait steps for timing instead of asking an agent to schedule something; use parallel for independent work; branch with if or decide instead of describing branches in prose. Keep lists flat when nesting adds nothing. Nest at most 4 levels deep and use at most 60 steps in total.
- Prefer templates to writing messages yourself: they hold wording the team has approved. Whenever a template fits a message, use it instead of writing the text in "with" or asking an agent step to write it, and read each template's description to see who it is for. Write your own text only when no template fits, and say so in your reply.
- When the right template or inputs depend on who the run is about (for example a welcome email that differs by role), use one action with a match, not an if step with near-copies of the same action. Put the most specific cases first and the general template in "otherwise". When telling the cases apart takes judgment, add a decide step first and match on steps.<id>.choice.
- Never invent URLs; ask for them.
- Don't add a human step just to approve an action before it runs; set its permission to "ask" instead.

No secrets in the workflow.`;

/** Sent when a reply doesn't decode or check, so the agent sees why its answer was rejected. */
export const retryInstructions = (error: string) =>
  `Your last response was rejected because it is not a valid design:\n${error}\n\nFix the problem and respond again with ONLY JSON: {"reply":"...","workflow":Workflow}, including the COMPLETE revised workflow.`;

/**
 * Asks the designer agent to answer a chat message. The instructions, which describe the current
 * catalog, are the conversation's system prompt, so the message goes as the user wrote it; pi only
 * sends the system prompt again when it changes. A reply that doesn't decode, or doesn't check
 * against the catalog, gets one retry in the same conversation with the problems. Each attempt has
 * its own pi request ID, so a redelivered callback waits for the original submissions instead of
 * prompting again. pi failures aren't the agent's mistake, so they aren't retried.
 */
export const designDraft = Effect.fn("Design.draft")(function* (
  designer: Pick<PiAgent, "instruct" | "prompt">,
  catalog: Catalog,
  permissions: Permissions,
  chatId: string,
  message: string,
) {
  yield* designer.instruct(designInstructions(catalog, permissions));
  const ask = (requestId: string, text: string) =>
    designer.prompt({ requestId, text }).pipe(
      Effect.flatMap(decodeDraft),
      Effect.tap((draft) => checkWorkflow(catalog, draft.workflow)),
    );
  return yield* ask(`chat:${chatId}`, message).pipe(
    Effect.catchTag("InvalidWorkflow", (invalid: InvalidWorkflow) =>
      ask(`chat:${chatId}:retry`, retryInstructions(invalid.message)),
    ),
  );
});

/**
 * The lines the studio shows while the designer works. The people reading them don't build
 * software, so they stay plain and none of them hints at a problem.
 */
export const progressPhrases = {
  reading: "Reading your request…",
  understanding: "Getting a sense of what you need…",
  planning: "Planning the steps…",
  timing: "Working out the timing…",
  people: "Figuring out who's involved…",
  paths: "Mapping out the different paths…",
  connections: "Connecting your other tools…",
  messages: "Choosing the right messages…",
  checking: "Double-checking the details…",
  writing: "Writing up your automation…",
} as const;
export type ProgressPhrase = keyof typeof progressPhrases;

/**
 * The phrase that follows from how far the answer has got, or `undefined` while the designer is
 * reasoning and the picker should choose. The retry after a rejected reply reads as a final check.
 */
export const fixedProgress = (answer: LiveAnswer): ProgressPhrase | undefined => {
  if (answer.requestId?.endsWith(":retry") === true) {
    return "checking";
  }
  if (answer.text.trim() !== "") {
    return "writing";
  }
  if (answer.thinking.trim() === "") {
    return "reading";
  }
  return undefined;
};

/** The phrases the classifier may choose from the designer's reasoning. */
const PickedPhrase = Schema.Literals([
  "understanding",
  "planning",
  "timing",
  "people",
  "paths",
  "connections",
  "messages",
  "checking",
]);

/** The choice question the classifier answers about the designer's latest reasoning. */
export const progressQuestion = {
  type: "choice",
  instructions:
    "The state is the latest private reasoning of an assistant that designs business automations. What is it working on right now?",
  criteria: {
    understanding: "Working out what the person wants",
    planning: "Choosing the steps and their order",
    timing: "Dates, delays, deadlines, or schedules",
    people: "Approvals, people who provide information, or who gets notified",
    paths: "Conditions, branches, or decisions between options",
    connections: "Sending information to other services or web addresses",
    messages: "Templates, the wording of messages, or who gets which message",
    checking: "Reviewing, verifying, or correcting details",
  },
} as const satisfies {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Record<typeof PickedPhrase.Type, string>;
};

/** A classifier request: the state to read and the questions to answer, keyed by ID. */
export interface ClassifyRequest {
  readonly state: unknown;
  readonly questions: Record<string, typeof progressQuestion>;
}

const ProgressAnswer = Schema.Struct({
  answers: Schema.Struct({
    progress: Schema.Struct({ choice: PickedPhrase, confidence: Schema.Finite }),
  }),
});

// The classifier only needs the reasoning's current topic, and a short state keeps it quick.
const reasoningWindow = 2_000;
// Below this, the classifier is guessing, and the phrase on screen is as good as a new one.
const minConfidence = 0.4;

export class UnsurePick extends Schema.TaggedError<UnsurePick>()("UnsurePick", {
  confidence: Schema.Finite,
}) {}

/**
 * Asks a classifier which phrase fits the designer's latest reasoning. `classify` sends the request
 * and resolves with the classifier's raw response. A response that doesn't decode, or a pick it
 * isn't sure of, fails.
 */
export const pickProgress = <E>(
  classify: (request: ClassifyRequest) => Effect.Effect<unknown, E>,
  reasoning: string,
) =>
  classify({
    state: { reasoning: reasoning.slice(-reasoningWindow) },
    questions: { progress: progressQuestion },
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ProgressAnswer)),
    Effect.flatMap(({ answers: { progress } }) =>
      progress.confidence < minConfidence
        ? Effect.fail(new UnsurePick({ confidence: progress.confidence }))
        : Effect.succeed(progress.choice),
    ),
    Effect.withSpan("Design.pickProgress"),
  );
