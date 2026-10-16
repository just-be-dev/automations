/** Picks the progress phrase the studio shows for the planner's latest reasoning. */

import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { pickProgress } from "../../src/agents/planner/planner.ts";
import { workersAiClassifier } from "../../src/platform/cloudflare/workers-ai.ts";
import type { Call } from "../framework/call.ts";
import { WorkersAi } from "../framework/models.ts";

export const ProgressOutput = Schema.Struct({
  /** Nothing when the classifier's answer didn't decode or it wasn't sure. */
  phrase: Schema.optionalKey(Schema.String),
  problem: Schema.optionalKey(Schema.String),
  /** The classifier's answer as it came. */
  raw: Schema.optionalKey(Schema.Unknown),
});
export type ProgressOutput = typeof ProgressOutput.Type;

export const progress: Call<string, ProgressOutput> = {
  name: "progress",
  input: Schema.String,
  output: ProgressOutput,
  timeout: "10 seconds",
  run: (reasoning) =>
    Effect.gen(function* () {
      const { binding } = yield* WorkersAi;
      const classifier = workersAiClassifier(binding);
      const raw = yield* Ref.make<unknown>(undefined);
      const picked = yield* pickProgress(
        (request) =>
          classifier.classify(request).pipe(Effect.tap((answer) => Ref.set(raw, answer))),
        reasoning,
      ).pipe(Effect.result);
      const answer = yield* Ref.get(raw);
      if (picked._tag === "Success") {
        return { phrase: picked.success, raw: answer };
      }
      if (picked.failure._tag === "ClassifierError") {
        return yield* picked.failure;
      }
      return {
        problem:
          picked.failure._tag === "UnsurePick"
            ? `Unsure (confidence ${picked.failure.confidence})`
            : `Undecodable answer: ${picked.failure.message}`,
        raw: answer,
      };
    }),
};
