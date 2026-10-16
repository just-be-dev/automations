/** Provides the Workers AI binding and opens isolated production pi agents over in-memory storage. */

import { MemoryStorage } from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { AgentTool } from "../../src/ai/pi.ts";
import { openPiAgent } from "../../src/platform/cloudflare/pi.ts";
import { PLANNER_THINKING_LEVEL } from "../../src/platform/cloudflare/workers-ai.ts";

/**
 * The real models, inside the Evals Worker (`worker.ts`): Workers AI through the binding Alchemy
 * gives it, so `alchemy dev` reaches them with the Cloudflare profile and no API token.
 */
export class WorkersAi extends Context.Service<
  WorkersAi,
  {
    readonly binding: Ai;
    /** The model pi uses for this request: the planner's unless the run asked for another. */
    readonly model: string;
  }
>()("evals/WorkersAi") {}

/** The production pi agent over memory instead of a Durable Object. Each trial opens its own. */
export const openPi = (tools: ReadonlyArray<AgentTool> = []) =>
  Effect.gen(function* () {
    const { binding, model } = yield* WorkersAi;
    return yield* openPiAgent({
      storage: async () => new MemoryStorage(),
      ai: binding,
      model,
      thinkingLevel: PLANNER_THINKING_LEVEL,
      tools,
    });
  });
