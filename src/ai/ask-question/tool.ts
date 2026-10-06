import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type AgentTool, AgentToolError } from "../pi.ts";
import {
  answerResult,
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  Question,
  questionnaireProblems,
  type QuestionsAnswer,
} from "./question.ts";

/**
 * The `ask_question` tool, for any agent whose host can show the person questions. It checks the
 * questions, tells the model every problem with them in plain words, and otherwise waits for the
 * answer through `ask` and returns it as the result the model reads.
 */

/**
 * Shows the person the questions one call asks and waits for their answer. Asking again with the
 * same call ID, as pi does when it reruns a call after a restart, waits for the same answer, or
 * returns it if it already came.
 */
export type Ask = (
  callId: string,
  questions: ReadonlyArray<Question>,
) => Effect.Effect<QuestionsAnswer, AgentToolError>;

const AskQuestionArguments = Schema.Struct({ questions: Schema.Array(Question) });

const decodeArguments = (args: unknown) =>
  Schema.decodeUnknownEffect(AskQuestionArguments)(args).pipe(
    Effect.mapError((error) => new AgentToolError({ message: error.message })),
  );

const objectOf = (properties: Schema.JsonObject, required: ReadonlyArray<string>) => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});

export const askQuestionTool = (ask: Ask): AgentTool => ({
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
                    description: "What picking it means",
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
      const { questions } = yield* decodeArguments(args);
      const problems = questionnaireProblems(questions);
      if (problems.length > 0) {
        return yield* new AgentToolError({
          message: `Nothing was shown. Fix these and ask again:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
        });
      }
      const answer = yield* ask(call.id, questions);
      return answerResult(questions, answer);
    }),
});
