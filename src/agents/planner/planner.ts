import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { checkWorkflow, describeCatalog, type Catalog } from "../../workflow/catalog.ts";
import type { LiveAnswer, PiAgent } from "../../ai/pi.ts";
import { InvalidWorkflow, type Workflow } from "../../workflow/model.ts";
import { MAX_SCHEDULED_RUNS, MIN_SCHEDULE_GAP_MINUTES } from "../../workflow/schedule.ts";
import { assemblePlan, planOf, planYaml, samePlan, type Plan } from "./plan.ts";

/**
 * The planner agent: its system prompt instructions, how its edits and answer become a draft, and
 * the progress lines shown while it works.
 */

export const plannerInstructions = (
  catalog: Catalog,
) => `You design executable automations. Each message from the person starts with the current workflow in YAML, or says there is none yet. Change it only with your tools:
- set_workflow sets the name, the trigger, and the IDs of the top-level steps in the order they run.
- put_steps adds steps, or replaces the steps with the same IDs. To change a step, put all of it again with the same "id".
- remove_steps removes steps and the steps nested in them.
- set_permissions sets permissions.
- show_workflow shows the workflow after your changes, and check_workflow lists what is still wrong with it.
Make every change the person asked for, then call check_workflow and fix everything it reports. Finally answer the person with a brief, helpful explanation of what you changed, or a question, in plain text: never JSON or YAML. If you need an answer before you can change anything, just ask. The person can't see your tool calls.

In tools, a step never contains other steps. Where a step holds a list of steps (a parallel step's branches, an if step's cases and otherwise, a decide step's options), the list names step IDs, and each of those steps is put separately. Every step is named in exactly one list: the workflow's top-level steps, or a list inside another step. A workflow has a name, a trigger, 1–20 top-level steps, and permissions.

Permissions say whether a run performs each operation on its own ("auto"), or waits every time until a member of a role approves it ({"ask":"<role>"}, a role listed below). Set one for EVERY operation the workflow uses: ask the role whose people are responsible for anything that sends something or acts on someone's behalf, unless the person said it may run on its own, and "auto" for lookups such as calendar.findTimes. With no roles, every permission must be "auto"; tell the person to add a role if something should wait for approval. The person reviews permissions and can change them in the studio, so the current workflow shows what they chose: keep those unless the person asks for a change. If an approver declines an action, it doesn't run and records nothing, and every later step that reads its record is skipped, as are the steps that read theirs; the rest of the run carries on.

Trigger, one of:
- {"kind":"entity","entity":"<type>","fields":["<field>", ...],"when":Condition}: starts a run when an entity of that type is created, or when one of "fields" changes (any field if omitted), and "when" (optional) holds for the new version. The entity is the run's subject. Example: {"kind":"entity","entity":"employee","fields":["start_date"],"when":{"ref":"employee.start_date","op":"after","value":"now"}}.
- {"kind":"schedule","cron":"<minute> <hour> <day of month> <month> <weekday>","timezone":"<IANA time zone>","entity":"<type>","when":Condition}: starts runs on a recurring schedule, at most every ${MIN_SCHEDULE_GAP_MINUTES} minutes. Example: "0 9 * * 1-5" is 9:00 every weekday, "30 8 1 * *" is 8:30 on the 1st of each month. Set "timezone" to the person's time zone, such as "America/New_York"; ask for it if they give a time of day and you don't know it (UTC when omitted). Without "entity", each time starts one run with no subject. With "entity", each time starts one run for every entity of that type for which "when" (optional) holds then, with the entity as the run's subject. One time may start at most ${MAX_SCHEDULED_RUNS} runs: if more entities match, it starts none, so write "when" to match only the entities that need a run. Example: {"kind":"schedule","cron":"0 9 * * 1","timezone":"Europe/London","entity":"employee","when":{"ref":"employee.start_date","op":"after","value":"now"}}.
- {"kind":"date","entity":"<type>","on":"<ref to a date or datetime field>","offset":"3 days","time":"09:00","timezone":"<IANA time zone>","when":Condition}: starts a run for each entity of that type on the day its date falls, shifted by "offset" (optional; whole days or weeks, "-1 week" for a week before), at "time" (optional, 24-hour, "09:00" when omitted) in "timezone". The date is read on the day, so if it changes, the run moves with it. The entity is the run's subject; "when" (optional) must hold then. The same limit of ${MAX_SCHEDULED_RUNS} runs a day applies. Example, three days after each employee starts: {"kind":"date","entity":"employee","on":"employee.start_date","offset":"3 days","time":"09:00","timezone":"Europe/London"}.
Prefer an entity trigger whenever the process starts because some record changed; a date trigger when it starts on, before, or after a date a record holds ("on their start date", "a week before the contract ends"); and a schedule when it starts at a time of day or on a regular cadence ("every Monday", "each morning", "monthly"). Use a wait step for timing within one run, such as waiting until a date after earlier steps have run.

Every step has an "id" (letters, digits, - and _), a short "title", and a "kind". IDs must be unique across the WHOLE workflow, nested steps included, and stay stable between turns. Steps in a list run in order. The kinds, as you put them:
- {"kind":"action","use":"<operation>","with":{"<input>":"..."},"template":TemplateUse,"match":Match}: performs a connection operation (listed below). Each input is text that may contain {{refs}}; a value that is exactly one {{ref}} passes that value through unchanged (use this for people). "people" inputs are lists, such as ["{{employee}}", "{{employee.manager}}"]. "template" and "match" are optional:
  - TemplateUse: {"use":"<template>","with":{"<slot>":"..."}} fills the inputs its content names (listed with each template below) from a stored template; give the other inputs in "with", never the same input twice. Fill every slot: a slot marked → takes exactly one {{ref}} to an entity of that type, such as "{{employee}}" or "{{employee.manager}}"; any other slot takes text that may contain {{refs}}.
  - Match: {"on":Ref,"cases":[{"when":Pattern,"with":{...},"template":TemplateUse}, ...],"otherwise":{"with":{...},"template":TemplateUse}} supplies the inputs that vary: the first of 1–8 cases whose pattern fits the value at "on", else "otherwise", which is required. Each case gives "with", "template", or both; the step's own "with" and "template" keep what every case shares. Example: one email.send step whose "with" is {"to":"{{employee}}"}, matching on "employee.role" to pick a template per role.
- {"kind":"agent","instruction":"...","output":{"fields":[{"name":"snake_case","type":"text" or "number" or "boolean" or "date" or "datetime","description":"..."}]}}: an AI agent does work that needs judgment or writing, given the subject and earlier results. "output" is optional; with it the agent answers with those fields, recorded as steps.<id>.output.<field>; without it, steps.<id>.output is text. Agents can't contact anyone or anything: use action steps for that.
- {"kind":"wait","duration":"3 days"} or {"kind":"wait","until":"employee.start_date","offset":"-7 days"}: pauses the run for a while, or until a date shifted by an optional offset. Durations are "<number> minutes|hours|days|weeks"; offsets may start with "-".
- {"kind":"parallel","branches":[["<step id>", ...], ["<step id>", ...]]}: 2–8 branches of 1–20 steps each run at the same time; the run continues once every branch finishes.
- {"kind":"if","cases":[{"when":Condition,"steps":["<step id>", ...]}],"otherwise":["<step id>", ...]}: runs the steps of the first of 1–8 cases whose condition holds, else "otherwise" (optional).
- {"kind":"decide","model":"clef-flash" or "clef","question":"...","options":[{"id":"...","description":"...","steps":["<step id>", ...]}]}: a decision model reads the run so far and picks one of 2–8 options, then runs its steps. clef-flash for simple routing, clef for nuanced decisions.
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
- Don't add a human step just to approve an action before it runs; ask a role in its permission instead.

No secrets in the workflow.`;

/** The chat message as the planner gets it: the current draft in YAML, then the person's words. */
export const turnMessage = (draft: Workflow | undefined, message: string) =>
  [
    draft === undefined
      ? "There is no workflow yet."
      : `The current workflow:\n\n\`\`\`yaml\n${planYaml(planOf(draft))}\n\`\`\``,
    `The person's message:\n\n${message}`,
  ].join("\n\n");

/** Sent when an answer leaves problems, so the agent sees why it was rejected. */
export const retryInstructions = (error: string) =>
  `Your changes were rejected because they leave problems:\n${error}\n\nFix them with your tools, call check_workflow, then answer the person again.`;

const Reply = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= 8000, {
    message: "Answer the person in 1–8,000 characters of plain text",
  }),
);

/** What the planner made of a message: its answer, and the new draft unless it changed nothing. */
export interface PlannedReply {
  readonly reply: string;
  readonly workflow?: Workflow;
}

/**
 * Asks the planner agent to answer a chat message. It edits the working copy in `plan`, which
 * started as `draft`, with its tools and then answers in text. The instructions, which describe
 * the current catalog, are the conversation's system prompt; pi only sends them again when they
 * change. An answer whose changes don't assemble or check against the catalog gets one retry in
 * the same conversation with the problems. Each attempt has its own pi request ID, so a
 * redelivered callback waits for the original submissions instead of prompting again. pi failures
 * aren't the agent's mistake, so they aren't retried.
 */
export const planDraft = Effect.fn("Planner.draft")(function* (
  planner: Pick<PiAgent["Service"], "instruct" | "prompt">,
  plan: Effect.Effect<Plan>,
  catalog: Catalog,
  draft: Workflow | undefined,
  chatId: string,
  message: string,
) {
  yield* planner.instruct(plannerInstructions(catalog));
  const started = planOf(draft);
  const settle = (answer: string) =>
    Effect.gen(function* () {
      const reply = Schema.decodeResult(Reply)(answer);
      const current = yield* plan;
      const designed = samePlan(current, started)
        ? Result.succeed(undefined)
        : yield* assemblePlan(current).pipe(
            Effect.flatMap((workflow) => checkWorkflow(catalog, workflow)),
            Effect.result,
          );
      if (Result.isFailure(reply) || Result.isFailure(designed)) {
        const problems = [
          ...(Result.isFailure(reply) ? [reply.failure.message] : []),
          ...(Result.isFailure(designed) ? [designed.failure.message] : []),
        ];
        return yield* new InvalidWorkflow({ message: problems.join("\n") });
      }
      const planned: PlannedReply =
        designed.success === undefined
          ? { reply: reply.success.trim() }
          : { reply: reply.success.trim(), workflow: designed.success };
      return planned;
    });
  const ask = (requestId: string, text: string) =>
    planner.prompt({ requestId, text }).pipe(Effect.flatMap(settle));
  return yield* ask(`chat:${chatId}`, turnMessage(draft, message)).pipe(
    Effect.catchTag("InvalidWorkflow", (invalid: InvalidWorkflow) =>
      ask(`chat:${chatId}:retry`, retryInstructions(invalid.message)),
    ),
  );
});

/**
 * The lines the studio shows while the planner works. The people reading them don't build
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

/** What the planner is doing while one of its tools runs. */
const toolProgress: Readonly<Record<string, ProgressPhrase>> = {
  set_workflow: "planning",
  put_steps: "planning",
  remove_steps: "planning",
  show_workflow: "planning",
  set_permissions: "people",
  check_workflow: "checking",
};

/**
 * The phrase that follows from how far the answer has got, or `undefined` while the planner is
 * reasoning and the picker should choose. The retry after a rejected reply reads as a final check.
 */
export const fixedProgress = (answer: LiveAnswer): ProgressPhrase | undefined => {
  if (answer.requestId?.endsWith(":retry") === true) {
    return "checking";
  }
  const tool = answer.tools.at(0);
  if (tool !== undefined) {
    return toolProgress[tool] ?? "planning";
  }
  if (answer.text.trim() !== "") {
    return "writing";
  }
  if (answer.thinking.trim() === "") {
    return "reading";
  }
  return undefined;
};

/** The phrases the classifier may choose from the planner's reasoning. */
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

/** The choice question the classifier answers about the planner's latest reasoning. */
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
 * Asks a classifier which phrase fits the planner's latest reasoning. `classify` sends the request
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
    Effect.withSpan("Planner.pickProgress"),
  );
