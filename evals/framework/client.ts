/**
 * Starts the Evals Worker the way `alchemy dev` starts the app, on its own stage, and talks to it.
 * Workers AI is reached with the Alchemy Cloudflare profile (`ALCHEMY_PROFILE`, or the default).
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Core from "alchemy/Test/Core";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Call } from "./call.ts";
import { CallFailed, CheckFailed, EvalWorker } from "./eval.ts";
import Stack from "./stack.ts";

const Failure = Schema.Struct({ error: Schema.String });
const Called = Schema.Struct({ output: Schema.Unknown });
const Grade = Schema.Struct({ pass: Schema.Boolean, reason: Schema.String });

/** Starts the Worker for as long as the surrounding scope lasts, and resolves with its URL. */
const start = Effect.gen(function* () {
  const options: Core.MakeOptions = {
    providers: Cloudflare.providers(),
    dev: true,
    stage: `eval_${process.env["USER"] ?? "unknown"}`,
  };
  const scope = yield* Effect.scope;
  const sidecar = Core.makeSidecarHandle(options);
  if (sidecar !== undefined) {
    yield* Effect.addFinalizer(() => sidecar.close);
  }
  const { url } = yield* Core.toEffect(Core.deploy(options, Stack), options, scope, sidecar);
  if (url === undefined) {
    return yield* new CallFailed({ message: "The Evals Worker started without a URL" });
  }
  // workerd starts the Worker on its first request; this keeps that out of the first trial's time.
  yield* Effect.tryPromise(() => fetch(url)).pipe(Effect.ignore);
  return url;
});

export const layer = Layer.effect(
  EvalWorker,
  Effect.gen(function* () {
    const url = yield* start;
    const plannerModel = yield* Config.option(Config.NonEmptyString("EVAL_PLANNER_MODEL"));
    const judgeModel = yield* Config.option(Config.NonEmptyString("EVAL_JUDGE_MODEL"));
    const modelOf = (model: Option.Option<string>) =>
      Option.match(model, { onNone: () => ({}), onSome: (name) => ({ model: name }) });

    /** POSTs JSON and resolves with the body, failing with the Worker's `{ error }`. */
    const post = (path: string, body: object) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(new URL(path, url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal,
            // Bun gives up on a request after five minutes; each call's own `timeout` limits it.
            timeout: false,
          });
          return { ok: response.ok, body: (await response.json()) as unknown };
        },
        catch: (cause) => new CallFailed({ message: `The Evals Worker failed: ${String(cause)}` }),
      }).pipe(
        Effect.flatMap(({ ok, body }) =>
          ok
            ? Effect.succeed(body)
            : Schema.decodeUnknownEffect(Failure)(body).pipe(
                Effect.mapError(() => new CallFailed({ message: JSON.stringify(body) })),
                Effect.flatMap(({ error }) => Effect.fail(new CallFailed({ message: error }))),
              ),
        ),
      );

    const decode =
      <A>(schema: Schema.Codec<A, unknown>) =>
      (value: unknown) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError((error) => new CallFailed({ message: error.message })),
        );

    return EvalWorker.of({
      call: Effect.fn("EvalWorker.call")(function* <I, O>(call: Call<I, O>, input: I) {
        const encoded = yield* Schema.encodeEffect(call.input)(input).pipe(
          Effect.mapError((error) => new CallFailed({ message: error.message })),
        );
        const body = yield* post(`/calls/${call.name}`, {
          input: encoded,
          ...modelOf(plannerModel),
        });
        const { output } = yield* decode(Called)(body);
        return yield* decode(call.output)(output);
      }),
      judge: (criterion, material) =>
        post("/judge", { criterion, material, ...modelOf(judgeModel) }).pipe(
          Effect.flatMap(decode(Grade)),
          Effect.mapError((error) => new CheckFailed({ message: error.message })),
          Effect.flatMap((grade) =>
            grade.pass ? Effect.void : Effect.fail(new CheckFailed({ message: grade.reason })),
          ),
        ),
    });
  }),
);
