/**
 * Builds agent prompts and decide requests and validates their answers into step records. PiAgent
 * runs agent steps; the classifier makes decisions.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChoiceAnswer, type ClassifyRequest } from "../ai/classifier.ts";
import { valueMatches, type AgentStep, type DecideStep } from "./model.ts";
import type { ExecutionValues } from "./execution.ts";

export class AgentAnswerError extends Schema.TaggedError<AgentAnswerError>()("AgentAnswerError", {
  message: Schema.String,
}) {}

const context = (state: ExecutionValues) =>
  [
    `The run is about: ${state.subject === null ? "nothing in particular" : JSON.stringify(state.subject)}`,
    ...(state.event === undefined ? [] : [`The triggering event: ${JSON.stringify(state.event)}`]),
    `Earlier steps recorded: ${JSON.stringify(state.steps)}`,
  ].join("\n");

export const agentPrompt = (step: AgentStep, instruction: string, state: ExecutionValues) =>
  [
    "You are carrying out one step of an automation. Do the work the instruction describes and answer with the result itself, not a description of what you would do. You can't contact anyone or call any service; later steps act on your answer.",
    `Step: ${step.title}`,
    `Instruction: ${instruction}`,
    context(state),
    ...(step.output === undefined
      ? []
      : [
          `Respond with ONLY a JSON object with these fields: ${step.output.fields
            .map(
              (field) =>
                `"${field.name}" (${field.type}${field.description === undefined ? "" : `: ${field.description}`})`,
            )
            .join(", ")}. Dates are YYYY-MM-DD; datetimes are ISO 8601 with a UTC offset.`,
        ]),
  ].join("\n\n");

const unfence = (text: string) => text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");

const parseObject = (text: string) =>
  Effect.try({
    try: () => JSON.parse(unfence(text)) as unknown,
    catch: () =>
      new AgentAnswerError({ message: `The agent didn't answer with JSON: ${text.slice(0, 200)}` }),
  }).pipe(
    Effect.filterOrFail(
      (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value),
      () => new AgentAnswerError({ message: "The agent's answer isn't a JSON object" }),
    ),
  );

/** The step's `output`: the answer text, or the requested fields checked against their types. */
export const agentOutput = (step: AgentStep, answer: string) => {
  const output = step.output;
  if (output === undefined) {
    return Effect.succeed<Schema.Json>(answer);
  }
  return parseObject(answer).pipe(
    Effect.flatMap((value) => {
      const wrong = output.fields.filter((field) => !valueMatches(field.type, value[field.name]));
      return wrong.length === 0
        ? Effect.succeed<Schema.Json>(
            Object.fromEntries(
              output.fields.map((field) => [field.name, value[field.name] as Schema.Json]),
            ),
          )
        : Effect.fail(
            new AgentAnswerError({
              message: `The agent's answer has missing or mistyped fields: ${wrong.map((field) => `${field.name} (${field.type})`).join(", ")}`,
            }),
          );
    }),
  );
};

/** Asks the step's classifier model which option fits the question, given the run so far. */
export const decideRequest = (
  step: DecideStep,
  question: string,
  state: ExecutionValues,
): ClassifyRequest => ({
  model: step.model,
  state: {
    subject: state.subject,
    ...(state.event === undefined ? {} : { event: state.event }),
    steps: state.steps,
  },
  questions: {
    decision: {
      type: "choice",
      instructions: question,
      criteria: Object.fromEntries(step.options.map((option) => [option.id, option.description])),
    },
  },
});

const DecideResponse = Schema.Struct({ answers: Schema.Struct({ decision: ChoiceAnswer }) });

/** The classifier's decision; the interpreter rejects a choice that isn't one of the options. */
export const decision = (response: unknown) =>
  Schema.decodeUnknownEffect(DecideResponse)(response).pipe(
    Effect.map(
      ({
        answers: {
          decision: { choice, confidence, probabilities },
        },
      }) => ({
        choice,
        confidence,
        probabilities: probabilities ?? { [choice]: confidence },
      }),
    ),
    Effect.mapError(
      (error) =>
        new AgentAnswerError({
          message: `The decision model's answer didn't decode: ${error.message}`,
        }),
    ),
  );
