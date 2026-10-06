import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { AgentToolError, type AgentTool } from "../../ai/pi.ts";
import { checkWorkflow, type Catalog } from "../../workflow/catalog.ts";
import { Permissions, StepId, Trigger } from "../../workflow/model.ts";
import {
  assemblePlan,
  changeWorkflow,
  layoutProblems,
  PlanStep,
  planYaml,
  putSteps,
  removeSteps,
  setPermissions,
  type Plan,
} from "./plan.ts";
import {
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  Question,
  answerResult,
  questionnaireProblems,
  type QuestionsAnswer,
} from "./question.ts";

/**
 * The planner's tools, which edit the working copy of the draft. Every edit sets values or
 * replaces steps by ID, so running a call again after a restart changes nothing more.
 */

/** Where the working copy of the message being answered is kept, and how its questions are asked. */
export interface PlanStore {
  readonly read: Effect.Effect<Plan, AgentToolError>;
  readonly write: (plan: Plan) => Effect.Effect<void, AgentToolError>;
  /**
   * Shows the person the questions one call asks and waits for their answer. Asking again with the
   * same call ID, as pi does after a restart, waits for the same answer, or returns it if it came.
   */
  readonly ask: (
    callId: string,
    questions: ReadonlyArray<Question>,
  ) => Effect.Effect<QuestionsAnswer, AgentToolError>;
}

const decodeArguments =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (args: unknown) =>
    Schema.decodeUnknownEffect(schema)(args).pipe(
      Effect.mapError((error) => new AgentToolError({ message: error.message })),
    );

/** Reminds the planner of lists that don't fit together yet, which it may still be fixing. */
const layoutNote = (plan: Plan) => {
  const problems = layoutProblems(plan);
  return problems.length === 0
    ? ""
    : `\nStill to fix:\n${problems.map((p) => `- ${p}`).join("\n")}`;
};

const objectOf = (properties: Schema.JsonObject, required: ReadonlyArray<string> = []) => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});

const SetWorkflowArguments = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(Trigger),
  steps: Schema.optionalKey(Schema.Array(StepId)),
});

const PutStepsArguments = Schema.Struct({
  steps: Schema.Array(Schema.Unknown).check(Schema.isMinLength(1)),
});

const RemoveStepsArguments = Schema.Struct({
  ids: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});

const SetPermissionsArguments = Schema.Struct({ permissions: Permissions });

const AskQuestionArguments = Schema.Struct({ questions: Schema.Array(Question) });

const stepLabel = (step: unknown, index: number) => {
  const id =
    typeof step === "object" && step !== null
      ? Object.getOwnPropertyDescriptor(step, "id")
      : undefined;
  return typeof id?.value === "string" ? `Step ${id.value}` : `Step ${index + 1}`;
};

export const plannerTools = (
  store: PlanStore,
  catalog: Effect.Effect<Catalog, AgentToolError>,
): ReadonlyArray<AgentTool> => {
  const edit = (change: (plan: Plan) => Plan) =>
    store.read.pipe(Effect.map(change), Effect.tap(store.write));

  return [
    {
      name: "set_workflow",
      description:
        "Sets the workflow's name, its trigger, and the IDs of its top-level steps in the order they run. Give only what changes.",
      parameters: objectOf({
        name: { type: "string" },
        trigger: { type: "object", description: "A Trigger" },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Every top-level step ID, in order",
        },
      }),
      execute: (args) =>
        decodeArguments(SetWorkflowArguments)(args).pipe(
          Effect.flatMap((change) => edit((plan) => changeWorkflow(plan, change))),
          Effect.map((plan) => `Saved.${layoutNote(plan)}`),
        ),
    },
    {
      name: "put_steps",
      description:
        "Adds steps, or replaces the steps with the same IDs. A step never contains other steps: where it holds a list of steps, the list names their IDs, and each of those steps is put too.",
      parameters: objectOf(
        { steps: { type: "array", items: { type: "object" }, description: "Steps" } },
        ["steps"],
      ),
      execute: (args) =>
        Effect.gen(function* () {
          const { steps } = yield* decodeArguments(PutStepsArguments)(args);
          const decoded = steps.map((step, index) =>
            Schema.decodeUnknownResult(PlanStep)(step).pipe(
              Result.mapError((error) => `${stepLabel(step, index)}: ${error.message}`),
            ),
          );
          const saved = decoded.flatMap((result) =>
            Result.isSuccess(result) ? [result.success] : [],
          );
          const rejected = decoded.flatMap((result) =>
            Result.isFailure(result) ? [result.failure] : [],
          );
          if (saved.length === 0) {
            return yield* new AgentToolError({
              message: `Nothing was saved.\n${rejected.join("\n")}`,
            });
          }
          const plan = yield* edit((current) => putSteps(current, saved));
          return (
            [
              `Saved ${saved.map((step) => step.id).join(", ")}.`,
              ...(rejected.length === 0
                ? []
                : [`Not saved, fix and put again:\n${rejected.join("\n")}`]),
            ].join("\n") + layoutNote(plan)
          );
        }),
    },
    {
      name: "remove_steps",
      description:
        "Removes steps and every step nested in them, and takes their IDs out of every list.",
      parameters: objectOf({ ids: { type: "array", items: { type: "string" } } }, ["ids"]),
      execute: (args) =>
        Effect.gen(function* () {
          const { ids } = yield* decodeArguments(RemoveStepsArguments)(args);
          const before = yield* store.read;
          const unknown = ids.filter((id) => before.stepsById[id] === undefined);
          const plan = yield* edit((current) => removeSteps(current, ids));
          return (
            [
              `Removed ${ids.filter((id) => !unknown.includes(id)).join(", ") || "nothing"}.`,
              ...(unknown.length === 0 ? [] : [`No step ${unknown.join(", ")}.`]),
            ].join(" ") + layoutNote(plan)
          );
        }),
    },
    {
      name: "set_permissions",
      description:
        'Sets the permission of each operation given, by operation ID: "auto", or {"ask":"<role>"}. Others stay as they are.',
      parameters: objectOf(
        {
          permissions: {
            type: "object",
            additionalProperties: {
              anyOf: [
                { type: "string", enum: ["auto"] },
                {
                  type: "object",
                  properties: { ask: { type: "string" } },
                  required: ["ask"],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        ["permissions"],
      ),
      execute: (args) =>
        decodeArguments(SetPermissionsArguments)(args).pipe(
          Effect.flatMap(({ permissions }) => edit((plan) => setPermissions(plan, permissions))),
          Effect.as("Saved."),
        ),
    },
    {
      name: "ask_question",
      description: `Asks the person 1–${MAX_QUESTIONS} questions, each with ${MIN_OPTIONS}–${MAX_OPTIONS} answers to pick from, and waits for their answers, which it returns. The studio takes the questions one at a time and adds a row to every question for the person to write their own answer, so never add an "Other" option. They may skip questions, or write a message instead.`,
      parameters: objectOf(
        {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: MAX_QUESTIONS,
            items: objectOf(
              {
                question: {
                  type: "string",
                  description: "The whole question in plain words, ending with a question mark",
                },
                header: {
                  type: "string",
                  maxLength: MAX_HEADER_LENGTH,
                  description: `A name for the question of at most ${MAX_HEADER_LENGTH} characters, shown on its tab, such as "Approver" or "Time zone"`,
                },
                options: {
                  type: "array",
                  minItems: MIN_OPTIONS,
                  maxItems: MAX_OPTIONS,
                  items: objectOf(
                    {
                      label: {
                        type: "string",
                        maxLength: MAX_LABEL_LENGTH,
                        description: "The answer in 1–5 words",
                      },
                      description: {
                        type: "string",
                        description: "What picking it means for the automation",
                      },
                    },
                    ["label"],
                  ),
                },
                multiSelect: {
                  type: "boolean",
                  description: "Whether the person may pick more than one option",
                },
              },
              ["question", "header", "options"],
            ),
          },
        },
        ["questions"],
      ),
      execute: (args, call) =>
        Effect.gen(function* () {
          const { questions } = yield* decodeArguments(AskQuestionArguments)(args);
          const problems = questionnaireProblems(questions);
          if (problems.length > 0) {
            return yield* new AgentToolError({
              message: `Nothing was shown. Fix these and ask again:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
            });
          }
          const answer = yield* store.ask(call.id, questions);
          return answerResult(questions, answer);
        }),
    },
    {
      name: "show_workflow",
      description: "Shows the workflow as it stands after your changes, in YAML.",
      parameters: objectOf({}),
      execute: () => store.read.pipe(Effect.map((plan) => `${planYaml(plan)}${layoutNote(plan)}`)),
    },
    {
      name: "check_workflow",
      description:
        "Lists everything still wrong with the workflow: its shape, and how it fits the entity types, templates, connections, and roles.",
      parameters: objectOf({}),
      execute: () =>
        Effect.gen(function* () {
          const plan = yield* store.read;
          const checked = yield* assemblePlan(plan).pipe(
            Effect.flatMap((workflow) =>
              Effect.flatMap(catalog, (current) => checkWorkflow(current, workflow)),
            ),
            Effect.result,
          );
          return Result.isSuccess(checked)
            ? "No problems found."
            : `Problems to fix:\n${checked.failure.message}`;
        }),
    },
  ];
};
