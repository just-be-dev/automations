import { createAI } from "agents/models/pi-ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkersAi } from "./models.ts";

/**
 * The LLM judge, for what code can't check, such as whether a reply reads well to someone who
 * doesn't build software. It runs in the Evals Worker; checks reach it through `judged`.
 */

export const Grade = Schema.Struct({ pass: Schema.Boolean, reason: Schema.String });

export class JudgeError extends Schema.TaggedError<JudgeError>()("JudgeError", {
  message: Schema.String,
}) {}

const instructions = `You grade the output of an AI system against one criterion. Read the material, decide whether the criterion holds, and answer with ONLY a JSON object: {"pass": true or false, "reason": "<one sentence>"}. Be strict: if it only partly holds, it fails.`;

const unfence = (text: string) => text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");

export const grade = Effect.fn("Judge.grade")(function* (criterion: string, material: string) {
  const { binding, model } = yield* WorkersAi;
  const ai = createAI({ binding });
  const answer = yield* Effect.tryPromise({
    try: () =>
      ai.completeSimple(ai(model), {
        systemPrompt: instructions,
        messages: [
          {
            role: "user",
            content: `Criterion: ${criterion}\n\nMaterial:\n${material}`,
            timestamp: Date.now(),
          },
        ],
      }),
    catch: (cause) => new JudgeError({ message: `The judge failed: ${String(cause)}` }),
  });
  if (answer.stopReason === "error") {
    return yield* new JudgeError({
      message: `The judge failed: ${answer.errorMessage ?? "no answer"}`,
    });
  }
  const text = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  return yield* Schema.decodeEffect(Schema.fromJsonString(Grade))(unfence(text.join(""))).pipe(
    Effect.mapError(
      (error) => new JudgeError({ message: `The judge didn't grade: ${error.message}` }),
    ),
  );
});
