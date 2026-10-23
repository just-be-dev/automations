/** Lists every automation in the directory with its saved trigger, runs in flight, and latest run. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { messageOf } from "../error.ts";
import { AutomationIndex } from "./index.ts";
import type { AutomationOverview } from "./model.ts";
import { Automations } from "./service.ts";

/** One automation that can't answer is listed with its error rather than hiding the others. */
export const listOverview = Effect.fn("Automation.listOverview")(function* () {
  const index = yield* AutomationIndex;
  const automations = yield* Automations;
  const listed = yield* index.list;
  return yield* Effect.forEach(
    listed,
    (automation) =>
      automations
        .get(automation.id)
        .overview()
        .pipe(
          Effect.map((status): AutomationOverview => ({ ...automation, ...status })),
          Effect.catchCause((cause) =>
            Effect.succeed<AutomationOverview>({
              ...automation,
              activeRuns: [],
              error: messageOf(Cause.squash(cause)),
            }),
          ),
        ),
    { concurrency: 8 },
  );
});
