import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Evals from "./worker.ts";

/** Only the Evals Worker. `mise run eval` runs it locally with `alchemy dev`; it's never deployed. */
export default Alchemy.Stack(
  "automations-evals",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const evals = yield* Evals;
    return { url: evals.url };
  }),
);
