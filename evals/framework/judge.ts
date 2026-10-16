/**
 * The LLM judge, for what code can't check, such as whether a reply reads well to someone who
 * doesn't build software. It runs in the Evals Worker; checks reach it through `judged`.
 */

import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { cloudflareAI, piModel } from "../../src/platform/cloudflare/pi.ts";
import { WorkersAi } from "./models.ts";

export const Grade = Schema.Struct({ pass: Schema.Boolean, reason: Schema.String });

export class JudgeError extends Schema.TaggedError<JudgeError>()("JudgeError", {
  message: Schema.String,
}) {}

const instructions = `You grade the output of an AI system against one criterion. Read the material, decide whether the criterion holds, and answer with ONLY a JSON object: {"pass": true or false, "reason": "<one sentence>"}. Be strict: if it only partly holds, it fails.`;

/** The grade object in the answer, which some models wrap in a fence or a sentence. */
const gradeText = (text: string) => text.match(/\{[\s\S]*\}/)?.[0] ?? text.trim();

const ask = Effect.fn("Judge.ask")(function* (criterion: string, material: string) {
  const { binding, model } = yield* WorkersAi;
  const ai = cloudflareAI(binding);
  const answer = yield* Effect.tryPromise({
    try: () =>
      ai.completeSimple(piModel(ai, model).model, {
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
  return answer;
});

/** Grades material against a criterion, retrying a model call the account's rate limit refused. */
export const grade = Effect.fn("Judge.grade")(function* (criterion: string, material: string) {
  const answer = yield* ask(criterion, material).pipe(
    Effect.retry({
      schedule: Schedule.exponential("2 seconds"),
      times: 4,
      while: (error) => /rate.?limit/i.test(error.message),
    }),
  );
  const text = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  const said = text.join("");
  return yield* Schema.decodeEffect(Schema.fromJsonString(Grade))(gradeText(said)).pipe(
    Effect.mapError(
      (error) =>
        new JudgeError({
          message: `The judge didn't grade: ${error.message} (it said: ${JSON.stringify(said.slice(0, 300))})`,
        }),
    ),
  );
});
