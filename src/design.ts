import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { checkWorkflow, describeCatalog, type Catalog } from "./catalog.ts";
import type { LiveAnswer, PiAgent } from "./pi.ts";
import { decodeDraft, type InvalidWorkflow } from "./workflow.ts";

/**
 * The designer agent: its system prompt instructions, how its reply becomes a draft, and the
 * progress lines shown while it works.
 */

export const designInstructions = (
  catalog: Catalog,
) => `You design executable automations. Always respond with ONLY JSON: {"reply":"brief helpful explanation or question","workflow":Workflow}. Include the COMPLETE revised workflow on every turn.

Workflow: {"name":"...","trigger":Trigger,"steps":[Step, ...]} with 1–20 top-level steps.

Trigger, one of:
- {"kind":"entity","entity":"<type>","fields":["<field>", ...],"when":Condition}: starts a run when an entity of that type is created, or when one of "fields" changes (any field if omitted), and "when" (optional) holds for the new version. The entity is the run's subject. Example: {"kind":"entity","entity":"employee","fields":["start_date"],"when":{"ref":"employee.start_date","op":"after","value":"now"}}.
- {"kind":"manual","subject":"<type>"}: started by hand for an entity the starter picks. Omit "subject" when the run isn't about an entity.
Prefer an entity trigger whenever the process starts because some record changed.

Every step has an "id" (letters, digits, - and _), a short "title", and a "kind". IDs must be unique across the WHOLE workflow, nested steps included, and stay stable between turns. Steps in a list run in order. The kinds:
- {"kind":"action","use":"<operation>","with":{"<input>":"..."}}: performs a connection operation (listed below). Each input is text that may contain {{refs}}; a value that is exactly one {{ref}} passes that value through unchanged (use this for people). "people" inputs are lists, such as ["{{employee}}", "{{employee.manager}}"].
- {"kind":"agent","instruction":"...","output":{"fields":[{"name":"snake_case","type":"text" or "number" or "boolean" or "date" or "datetime","description":"..."}]}}: an AI agent does work that needs judgment or writing, given the subject and earlier results. "output" is optional; with it the agent answers with those fields, recorded as steps.<id>.output.<field>; without it, steps.<id>.output is text. Agents can't contact anyone or anything: use action steps for that.
- {"kind":"wait","duration":"3 days"} or {"kind":"wait","until":"employee.start_date","offset":"-7 days"}: pauses the run for a while, or until a date shifted by an optional offset. Durations are "<number> minutes|hours|days|weeks"; offsets may start with "-".
- {"kind":"parallel","branches":[[Step, ...], [Step, ...]]}: 2–8 branches run at the same time; the run continues once every branch finishes.
- {"kind":"if","cases":[{"when":Condition,"steps":[Step, ...]}],"otherwise":[Step, ...]}: runs the steps of the first case whose condition holds, else "otherwise" (optional).
- {"kind":"decide","model":"clef-flash" or "clef","question":"...","options":[{"id":"...","description":"...","steps":[Step, ...]}]}: a decision model reads the run so far and picks one of 2–8 options, then runs its steps. clef-flash for simple routing, clef for nuanced decisions.
- {"kind":"human","prompt":"...","assignee":"<ref to a person>","notify":"slack" or "email","response":"approval" or {"fields":[{"name":"snake_case","label":"...","type":"text" or "number" or "boolean" or "date" or "datetime","default":"{{ref}}"}]},"timeout":"2 days"}: pauses until the assignee approves or rejects, or fills in the fields. "assignee" is a ref such as "employee.manager". "notify" also sends them the request. A field's "default" prefills an answer they can keep or change. "timeout" is optional; when it passes, a form keeps its defaults, so a proposal nobody objects to goes ahead.

Refs read what the run knows. The trigger's entity type is a root: "employee.start_date", "employee.manager" (a whole entity), or "employee.manager.email" (a field of the entity a ref field points to). "steps.<id>.<field>" reads what an earlier step recorded: action steps record what their operation lists; agent steps "output"; decide steps "choice" and "confidence"; human steps "approved", "values.<field>", and "timedOut"; if steps "matched". A step can only read steps that finish before it on every path: not steps inside another branch of a parallel, if, or decide. In text (titles, instructions, prompts, questions, inputs, defaults), write refs as {{employee.name}}. Where a ref is expected on its own ("until", "assignee", conditions), write it bare: "employee.start_date". Never write placeholders any other way, such as [new hire], and never ask for values up front: read them from the subject, or collect them with a human step at the point they are needed.

Condition: {"ref":Ref,"op":"equals" or "notEquals" or "greaterThan" or "lessThan" or "contains","value":any JSON} or {"ref":Ref,"op":"before" or "after","value":"now" or a date} or {"ref":Ref,"op":"exists"} or {"all":[Condition, ...]} or {"any":[Condition, ...]} or {"not":Condition}.

${describeCatalog(catalog)}

Design guidance:
- Automate everything that can be automated, and keep people for what only a person can do. Around each human step, add the automation that makes it easy: calendar events that remind them, an agent that proposes an answer (for example a meeting time chosen from calendar.findTimes) prefilled as a field default they can keep or change, an action that does the work once they confirm, and a follow-up on Slack that checks it happened.
- Assign every human step to a specific person with "assignee", and set "notify" so they hear about it.
- Use wait steps for timing instead of asking an agent to schedule something; use parallel for independent work; branch with if or decide instead of describing branches in prose. Keep lists flat when nesting adds nothing. Nest at most 4 levels deep and use at most 60 steps in total.
- Never invent URLs; ask for them.

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
  chatId: string,
  message: string,
) {
  yield* designer.instruct(designInstructions(catalog));
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
