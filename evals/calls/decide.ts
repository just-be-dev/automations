/**
 * Makes a decide step's decision, as a run does: the step's prompt in a fresh conversation, and
 * the decision `decision` makes of the answer.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decidePrompt, decision } from "../../src/workflow/agent-step.ts";
import { ExecutionValues } from "../../src/workflow/execution.ts";
import { DecideStep } from "../../src/workflow/model.ts";
import type { Call } from "../framework/call.ts";
import { openPi } from "../framework/models.ts";

export const DecideInput = Schema.Struct({
  question: Schema.String,
  /** Descriptions by option ID. */
  options: Schema.Record(Schema.String, Schema.String),
  state: ExecutionValues,
});
export type DecideInput = typeof DecideInput.Type;

export const DecideOutput = Schema.Struct({
  answer: Schema.String,
  choice: Schema.optionalKey(Schema.String),
  confidence: Schema.optionalKey(Schema.Finite),
  /** Why the answer isn't a decision. */
  problem: Schema.optionalKey(Schema.String),
});
export type DecideOutput = typeof DecideOutput.Type;

const stepOf = (input: DecideInput) =>
  Schema.decodeEffect(DecideStep)({
    id: "step",
    title: input.question,
    kind: "decide",
    model: "clef-flash",
    question: input.question,
    options: Object.entries(input.options).map(([id, description]) => ({
      id,
      description,
      steps: [],
    })),
  });

export const decide: Call<DecideInput, DecideOutput> = {
  name: "decide",
  input: DecideInput,
  output: DecideOutput,
  timeout: "2 minutes",
  run: (input) =>
    Effect.gen(function* () {
      const step = yield* stepOf(input);
      const pi = yield* openPi();
      const conversation = yield* pi.createConversation;
      const answer = yield* pi.prompt({
        conversation,
        text: decidePrompt(step, step.question, input.state),
      });
      const decided = yield* decision(answer).pipe(Effect.result);
      return decided._tag === "Success"
        ? { answer, choice: decided.success.choice, confidence: decided.success.confidence }
        : { answer, problem: decided.failure.message };
    }),
};
