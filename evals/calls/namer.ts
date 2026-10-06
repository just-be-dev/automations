import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { AutomationNamer, nameAutomation, nameFromReply } from "../../src/agents/namer/namer.ts";
import { workersAiNamer } from "../../src/platform/cloudflare/workers-ai.ts";
import type { Call } from "../framework/call.ts";
import { WorkersAi } from "../framework/models.ts";

/** Names an automation from its description, as `POST /api/automations` does. */

export const NamerOutput = Schema.Struct({
  name: Schema.String,
  /** What the model said, before the name was cleaned up. */
  reply: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  /** The model didn't answer within its five seconds, failed, or said nothing usable. */
  fallback: Schema.Boolean,
});
export type NamerOutput = typeof NamerOutput.Type;

export const namer: Call<string, NamerOutput> = {
  name: "namer",
  input: Schema.String,
  output: NamerOutput,
  timeout: "20 seconds",
  run: (description) =>
    Effect.gen(function* () {
      const { binding } = yield* WorkersAi;
      const model = workersAiNamer(binding);
      const seen = yield* Ref.make<{ readonly reply?: string; readonly error?: string }>({});
      const recording = AutomationNamer.of({
        complete: (request) =>
          model.complete(request).pipe(
            Effect.tap((reply) => Ref.set(seen, { reply })),
            Effect.tapError((error) => Ref.set(seen, { error: error.message })),
          ),
      });
      const name = yield* nameAutomation(description).pipe(
        Effect.provideService(AutomationNamer, recording),
      );
      const { reply, error } = yield* Ref.get(seen);
      return {
        name,
        ...(reply === undefined ? {} : { reply }),
        ...(error === undefined ? {} : { error }),
        fallback: reply === undefined || Option.isNone(nameFromReply(reply)),
      };
    }),
};
