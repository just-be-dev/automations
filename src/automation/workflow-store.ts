import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EntityStore } from "../entities/store.ts";
import { Workflow } from "../workflow/model.ts";
import { AutomationHost } from "./host.ts";

// Workflows and runs from before entity-based triggers were discarded on purpose.
export const decodeOrDrop =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (value: unknown) =>
    value === undefined
      ? Effect.succeed(undefined)
      : Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.map((decoded): A | undefined => decoded),
          Effect.orElseSucceed(() => undefined),
        );

/** Draft and saved snapshots share the same storage and current catalog. */
export const makeWorkflowStore = Effect.fn("Automation.makeWorkflowStore")(function* () {
  const { storage } = yield* AutomationHost;
  const entities = yield* EntityStore;
  return {
    read: (key: "draft" | "saved") => storage.get(key).pipe(Effect.flatMap(decodeOrDrop(Workflow))),
    catalog: Effect.all({
      types: entities.listTypes,
      templates: entities.listTemplates,
      roles: entities.listRoles,
    }),
  };
});

export type WorkflowStore = Effect.Success<ReturnType<typeof makeWorkflowStore>>;
