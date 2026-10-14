/** Decides, in a Worker's or Durable Object's Init, whether it runs under `alchemy dev` on a developer's stage. */
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/** `alchemy dev` runs on `dev_$USER` unless told otherwise; deployed stages are named otherwise. */
export const isDevelopmentStage = (stage: string) => stage.startsWith("dev_");

/**
 * Whether this Worker runs locally under `alchemy dev`, which is also what turns Cloudflare Access
 * off (see `stack.ts`). Read it in the outer Effect only.
 *
 * Alchemy binds every Config value read during Init onto the Worker, and only a value that is set
 * gets bound. `alchemy dev` sets `ALCHEMY_DEV`, and plan time reads it only on a `dev_` stage, so
 * `alchemy dev --stage prod` binds nothing. `alchemy deploy` never sets it, so a deployed Worker has
 * no binding and the value defaults to false at runtime, where the stage isn't known.
 */
export const localDevelopment = Effect.gen(function* () {
  if (!globalThis.__ALCHEMY_RUNTIME__ && !isDevelopmentStage(yield* Alchemy.Stage)) {
    return false;
  }
  return yield* Alchemy.ALCHEMY_DEV.pipe(Effect.orDie);
});
