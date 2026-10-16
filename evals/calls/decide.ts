/**
 * Makes a decide step's decision, as a run does: the step's request to its classifier model, and
 * the decision `decision` makes of the response.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { workersAiClassifier } from "../../src/platform/cloudflare/workers-ai.ts";
import { decideRequest, decision } from "../../src/workflow/agent-step.ts";
import { DecideStep, DecisionModel } from "../../src/workflow/model.ts";
import type { Call } from "../framework/call.ts";
import { RunState, values } from "../fixtures.ts";
import { WorkersAi } from "../framework/models.ts";

export const DecideInput = Schema.Struct({
  question: Schema.String,
  /** Descriptions by option ID. */
  options: Schema.Record(Schema.String, Schema.String),
  ...RunState,
  /** The step's model; `clef-flash` when left out, as the planner chooses for simple routing. */
  model: Schema.optionalKey(DecisionModel),
});
export type DecideInput = typeof DecideInput.Type;

export const DecideOutput = Schema.Struct({
  choice: Schema.optionalKey(Schema.String),
  confidence: Schema.optionalKey(Schema.Finite),
  /** Why the response isn't a decision. */
  problem: Schema.optionalKey(Schema.String),
  /** The classifier's response as it came. */
  raw: Schema.optionalKey(Schema.Unknown),
});
export type DecideOutput = typeof DecideOutput.Type;

const stepOf = (input: DecideInput) =>
  Schema.decodeEffect(DecideStep)({
    id: "step",
    title: input.question,
    kind: "decide",
    model: input.model ?? "clef-flash",
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
  timeout: "15 seconds",
  run: (input) =>
    Effect.gen(function* () {
      const step = yield* stepOf(input);
      const { binding } = yield* WorkersAi;
      const raw = yield* workersAiClassifier(binding).classify(
        decideRequest(step, step.question, values(input)),
      );
      const decided = yield* decision(raw).pipe(Effect.result);
      return decided._tag === "Success"
        ? { choice: decided.success.choice, confidence: decided.success.confidence, raw }
        : { problem: decided.failure.message, raw };
    }),
};
