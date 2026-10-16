/** Titles a studio agent thread from its first message, as the assistant's first reply does. */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Namer, nameFromReply, nameThread } from "../../src/agents/namer/namer.ts";
import { workersAiNamer } from "../../src/platform/cloudflare/workers-ai.ts";
import type { Call } from "../framework/call.ts";
import { WorkersAi } from "../framework/models.ts";
import { NamerOutput } from "./namer.ts";

export const threadNamer: Call<string, NamerOutput> = {
  name: "thread-namer",
  input: Schema.String,
  output: NamerOutput,
  timeout: "10 seconds",
  run: (message) =>
    Effect.gen(function* () {
      const { binding } = yield* WorkersAi;
      const model = workersAiNamer(binding);
      const seen = yield* Ref.make<{ readonly reply?: string; readonly error?: string }>({});
      const recording = Namer.of({
        complete: (request) =>
          model.complete(request).pipe(
            Effect.tap((reply) => Ref.set(seen, { reply })),
            Effect.tapError((error) => Ref.set(seen, { error: error.message })),
          ),
      });
      const name = yield* nameThread(message).pipe(Effect.provideService(Namer, recording));
      const { reply, error } = yield* Ref.get(seen);
      return {
        name,
        ...(reply === undefined ? {} : { reply }),
        ...(error === undefined ? {} : { error }),
        fallback: reply === undefined || Option.isNone(nameFromReply(reply)),
      };
    }),
};
