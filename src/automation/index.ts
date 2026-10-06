import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { AutomationError, type AutomationSummary } from "./model.ts";

export class AutomationIndexError extends Schema.TaggedError<AutomationIndexError>()(
  "AutomationIndexError",
  { message: Schema.String },
) {}

/** Keeps the studio's directory of automations independently of their host. */
export class AutomationIndex extends Context.Service<
  AutomationIndex,
  {
    /** Adds an automation unless its ID is taken, and says whether it did. */
    readonly create: (id: string, name: string) => Effect.Effect<boolean, AutomationIndexError>;
    readonly record: (id: string, name: string) => Effect.Effect<void, AutomationIndexError>;
    readonly recordIfMissing: (
      id: string,
      name: string,
    ) => Effect.Effect<void, AutomationIndexError>;
    readonly list: Effect.Effect<ReadonlyArray<AutomationSummary>, AutomationIndexError>;
  }
>()("automations/AutomationIndex") {}

const maxBaseIdLength = 60;

/** A readable automation ID from its name, such as `onboard-new-hires`. */
export const automationIdFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, maxBaseIdLength)
    .replace(/^-+|-+$/g, "") || "automation";

/**
 * Lists a new automation under the ID its name suggests, or that ID with a random suffix when an
 * automation already has it, and returns the ID.
 */
export const listNewAutomation = Effect.fn("AutomationIndex.listNewAutomation")(function* (
  name: string,
) {
  const index = yield* AutomationIndex;
  const base = automationIdFrom(name);
  if (yield* index.create(base, name)) {
    return base;
  }
  const suffix = (yield* Random.nextIntBetween(0, 36 ** 6 - 1)).toString(36).padStart(6, "0");
  const id = `${base}-${suffix}`;
  if (yield* index.create(id, name)) {
    return id;
  }
  return yield* new AutomationError({ message: "Couldn't pick an ID. Try again." });
});
