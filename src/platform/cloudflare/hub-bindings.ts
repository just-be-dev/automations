/**
 * The Studio's bindings to the agents project's prod Workers (stack `cfp`) for the hub shell
 * (hub.ts). Every deployed stage binds prod, which owns the assistant; `alchemy dev` binds nothing.
 * Only the stack imports this module: the edge, which imports hub.ts at runtime, must not reach
 * Alchemy.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import type * as Effect from "effect/Effect";

const AGENTS_STACK = "cfp";
const AGENTS_STAGE = "prod";

/** Agents' `Api` and `Embed` Workers by typed ref (another stack's state), on deployed stages. */
export const hubBindings = (
  dev: boolean,
): Readonly<Record<string, Effect.Effect<Cloudflare.Worker>>> =>
  dev
    ? {}
    : {
        HUB_API: Cloudflare.Worker.ref("Api", { stack: AGENTS_STACK, stage: AGENTS_STAGE }),
        HUB_EMBED: Cloudflare.Worker.ref("Embed", { stack: AGENTS_STACK, stage: AGENTS_STAGE }),
      };
