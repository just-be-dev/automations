import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AutomationApplication } from "./application.ts";

/** Remote clients preserve the operations, but failures cross a transport boundary as unknown. */
export type AutomationClient = {
  readonly [K in keyof AutomationApplication]: (
    ...args: Parameters<AutomationApplication[K]>
  ) => Effect.Effect<Effect.Success<ReturnType<AutomationApplication[K]>>, unknown>;
};

/** Address an automation without exposing its hosting platform to callers. */
export class Automations extends Context.Service<
  Automations,
  { readonly get: (id: string) => AutomationClient }
>()("automations/Automations") {}
