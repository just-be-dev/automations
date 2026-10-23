/** Serves schema-checked eval calls and judge requests with the Worker's Workers AI binding. */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { json, NotFound, respond } from "../../src/http/response.ts";
import { PLANNER_MODEL } from "../../src/platform/cloudflare/workers-ai.ts";
import { agent } from "../calls/agent.ts";
import { decide } from "../calls/decide.ts";
import { namer } from "../calls/namer.ts";
import { planner } from "../calls/planner.ts";
import { progress } from "../calls/progress.ts";
import type { Call } from "./call.ts";
import { grade } from "./judge.ts";
import { WorkersAi } from "./models.ts";

/**
 * The Evals Worker runs the LLM calls and the judge where Workers AI is bound, so the models are
 * reached through Alchemy like the app's are. `mise run eval` starts it with `alchemy dev`, sends
 * it each case's input, and checks what comes back. It's never deployed.
 *
 *   POST /calls/<name>  { input, model? }           → { output }
 *   POST /judge         { criterion, material, model? } → { pass, reason }
 *
 * `model` swaps the Workers AI model pi or the judge uses; the planner's is the default.
 */

const CallRequest = Schema.Struct({
  input: Schema.Unknown,
  model: Schema.optionalKey(Schema.String),
});

const JudgeRequest = Schema.Struct({
  criterion: Schema.String,
  material: Schema.String,
  model: Schema.optionalKey(Schema.String),
});

const CallParams = Schema.Struct({ name: Schema.String });

/** Decodes a call's input, runs it, and encodes its output. */
const serve =
  <I, O>(call: Call<I, O>) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(call.input)(input).pipe(
      Effect.flatMap(call.run),
      Effect.flatMap(Schema.encodeEffect(call.output)),
    );

const calls: Readonly<Record<string, ReturnType<typeof serve>>> = {
  [agent.name]: serve(agent),
  [decide.name]: serve(decide),
  [namer.name]: serve(namer),
  [planner.name]: serve(planner),
  [progress.name]: serve(progress),
};

const routes = (ai: Cloudflare.Workers.AIClient) => {
  const withModel =
    (model: string | undefined) => (effect: Effect.Effect<unknown, unknown, WorkersAi>) =>
      Effect.flatMap(ai.raw, (binding) =>
        Effect.provideService(effect, WorkersAi, { binding, model: model ?? PLANNER_MODEL }),
      );
  return Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/calls/:name",
      respond(
        Effect.gen(function* () {
          const { name } = yield* HttpRouter.schemaPathParams(CallParams);
          const run = calls[name];
          if (run === undefined) {
            return yield* new NotFound({ message: `No call ${name}` });
          }
          const request = yield* HttpServerRequest.schemaBodyJson(CallRequest);
          return { output: yield* withModel(request.model)(run(request.input)) };
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/judge",
      respond(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.schemaBodyJson(JudgeRequest);
          return yield* withModel(request.model)(grade(request.criterion, request.material));
        }),
      ),
    ),
    HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
  );
};

export default class Evals extends Cloudflare.Worker<Evals>()(
  "Evals",
  { main: import.meta.url, compatibility: { date: "2026-10-04" } },
  Effect.gen(function* () {
    const ai = yield* Cloudflare.Workers.AI();
    const handler = yield* HttpRouter.toHttpEffect(routes(ai));
    return { fetch: handler };
  }).pipe(Effect.provide(Cloudflare.Workers.AIBinding)),
) {}
