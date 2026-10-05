import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AutomationSummary } from "./model.ts";

export class AutomationIndexError extends Schema.TaggedError<AutomationIndexError>()(
  "AutomationIndexError",
  { message: Schema.String },
) {}

/** Keeps the studio's directory of automations independently of their host. */
export class AutomationIndex extends Context.Service<
  AutomationIndex,
  {
    readonly record: (id: string, name: string) => Effect.Effect<void, AutomationIndexError>;
    readonly recordIfMissing: (
      id: string,
      name: string,
    ) => Effect.Effect<void, AutomationIndexError>;
    readonly list: Effect.Effect<ReadonlyArray<AutomationSummary>, AutomationIndexError>;
  }
>()("automations/AutomationIndex") {}
