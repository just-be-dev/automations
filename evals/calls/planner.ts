import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { stringify } from "yaml";
import { planOf, type Plan } from "../../src/agents/planner/plan.ts";
import { planDraft } from "../../src/agents/planner/planner.ts";
import { plannerTools } from "../../src/agents/planner/tools.ts";
import { Question } from "../../src/ai/ask-question/question.ts";
import type { AgentTool, PromptOptions } from "../../src/ai/pi.ts";
import { EntityType, Role } from "../../src/entities/model.ts";
import { Template } from "../../src/entities/templates.ts";
import {
  actionTemplates,
  flattenSteps,
  Workflow,
  type ActionStep,
  type HumanStep,
  type Step,
} from "../../src/workflow/model.ts";
import type { Call } from "../framework/call.ts";
import { openPi } from "../framework/models.ts";
import { catalog } from "../fixtures.ts";

/**
 * Answers one chat message, as the studio does: `planDraft` with the production tools and pi
 * agent, so the retry after a rejected answer is part of what's measured. Nobody is there to answer
 * `ask_question`, so the person skips every question, as they can in the studio, and the planner
 * carries on with its own judgment.
 */

const Catalog = Schema.Struct({
  types: Schema.Array(EntityType),
  templates: Schema.Array(Template),
  roles: Schema.Array(Role),
});

export const PlannerInput = Schema.Struct({
  message: Schema.String,
  draft: Schema.optionalKey(Workflow),
  /** The People Ops store in `fixtures.ts` unless given. */
  catalog: Schema.optionalKey(Catalog),
});
export type PlannerInput = typeof PlannerInput.Type;

export const PlannerOutput = Schema.Struct({
  reply: Schema.String,
  /** The new draft, or nothing when the planner changed nothing, such as when it asks a question. */
  workflow: Schema.optionalKey(Workflow),
  /** The first answer left problems and the planner had to fix them. */
  retried: Schema.Boolean,
  toolCalls: Schema.Array(Schema.String),
  /** The questions of each `ask_question` call, which the person skipped. */
  asked: Schema.Array(Schema.Array(Question)),
});
export type PlannerOutput = typeof PlannerOutput.Type;

/** The planner's tools, recording each call. */
const recorded = (tools: ReadonlyArray<AgentTool>, calls: Ref.Ref<ReadonlyArray<string>>) =>
  tools.map((tool): AgentTool => ({
    ...tool,
    execute: (args, call) =>
      Ref.update(calls, (all) => [...all, tool.name]).pipe(
        Effect.andThen(tool.execute(args, call)),
      ),
  }));

export const planner: Call<PlannerInput, PlannerOutput> = {
  name: "planner",
  input: PlannerInput,
  output: PlannerOutput,
  timeout: "8 minutes",
  run: (input) =>
    Effect.gen(function* () {
      const store = input.catalog ?? catalog;
      const plan = yield* Ref.make<Plan>(planOf(input.draft));
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const requests = yield* Ref.make<ReadonlyArray<string>>([]);
      const asked = yield* Ref.make<ReadonlyArray<ReadonlyArray<Question>>>([]);
      const tools = plannerTools(
        {
          read: Ref.get(plan),
          write: (next) => Ref.set(plan, next),
          ask: (_callId, questions) =>
            Ref.update(asked, (all) => [...all, questions]).pipe(
              Effect.as({ kind: "answers" as const, answers: questions.map(() => null) }),
            ),
        },
        Effect.succeed(store),
      );
      const pi = yield* openPi(recorded(tools, calls));
      const agent = {
        instruct: pi.instruct,
        prompt: (options: PromptOptions) =>
          Ref.update(requests, (all) => [...all, options.requestId ?? ""]).pipe(
            Effect.andThen(pi.prompt(options)),
          ),
      };
      const planned = yield* planDraft(
        agent,
        Ref.get(plan),
        store,
        input.draft,
        "eval",
        input.message,
      );
      return {
        ...planned,
        retried: (yield* Ref.get(requests)).some((id) => id.endsWith(":retry")),
        toolCalls: yield* Ref.get(calls),
        asked: yield* Ref.get(asked),
      };
    }),
};

// Readers for assertions about the draft.

/** Every step, nested ones included. */
export const steps = (output: PlannerOutput): ReadonlyArray<Step> =>
  flattenSteps(output.workflow?.steps ?? []);

export const stepIds = (output: PlannerOutput) => steps(output).map((step) => step.id);

/** The action steps that perform `operation`, or every action step. */
export const actions = (output: PlannerOutput, operation?: string): ReadonlyArray<ActionStep> =>
  steps(output).flatMap((step) =>
    step.kind === "action" && (operation === undefined || step.use === operation) ? [step] : [],
  );

export const humans = (output: PlannerOutput): ReadonlyArray<HumanStep> =>
  steps(output).flatMap((step) => (step.kind === "human" ? [step] : []));

/** The templates the actions that perform `operation` use, their match cases included. */
export const templates = (output: PlannerOutput, operation: string) =>
  actions(output, operation).flatMap((step) => actionTemplates(step).map((use) => use.use));

export const permission = (output: PlannerOutput, operation: string) =>
  output.workflow?.permissions?.[operation];

/** What the planner said to the person: the questions it asked, if any, then its reply. */
export const said = (output: PlannerOutput) =>
  [
    ...output.asked.flatMap((questions) =>
      questions.map((question) => `The assistant asked: ${question.question}`),
    ),
    `The assistant's reply: ${output.reply}`,
  ].join("\n\n");

/** The exchange, as the judge reads it. */
export const exchange = (output: PlannerOutput, input: PlannerInput) =>
  [
    `The person's message: ${input.message}`,
    ...(input.draft === undefined ? [] : [`The workflow before:\n${stringify(input.draft)}`]),
    output.workflow === undefined
      ? "The workflow didn't change."
      : `The workflow after:\n${stringify(output.workflow)}`,
    said(output),
  ].join("\n\n");
