import * as Effect from "effect/Effect";
import { EntityStore } from "../entities/store.ts";
import { checkWorkflow } from "../workflow/catalog.ts";
import { Workflow } from "../workflow/model.ts";
import { AutomationHost, decodeOrDrop } from "./host.ts";
import { AutomationIndex } from "./index.ts";
import { AutomationError } from "./model.ts";

/** Draft and saved snapshots share the same storage and current catalog. */
export const makeWorkflowStore = Effect.fn("Automation.makeWorkflowStore")(function* () {
  const { storage } = yield* AutomationHost;
  const entities = yield* EntityStore;
  const index = yield* AutomationIndex;
  const read = (key: "draft" | "saved") =>
    storage.get(key).pipe(Effect.flatMap(decodeOrDrop(Workflow)));
  const catalog = Effect.all({
    types: entities.listTypes,
    templates: entities.listTemplates,
    roles: entities.listRoles,
  });

  /**
   * Save is complete only after the trigger subscription is updated. These stores cannot share
   * a transaction: if subscribing fails, the snapshot remains saved and the caller gets the
   * failure. Retrying save repeats the subscription write safely. Directory updates only label
   * the studio, so their failure must not fail a save.
   */
  const save = Effect.fn("Automation.save")(function* (automationId: string) {
    const draft = yield* read("draft");
    if (draft === undefined) {
      return yield* new AutomationError({ message: "No draft to save" });
    }
    yield* checkWorkflow(yield* catalog, draft);
    yield* storage.put("saved", draft);
    const trigger = draft.trigger;
    yield* entities.subscribe(automationId, trigger.kind === "entity" ? trigger.entity : undefined);
    yield* index.record(automationId, draft.name).pipe(Effect.ignore);
    return { saved: draft };
  });

  return { read, catalog, save };
});

export type WorkflowStore = Effect.Success<ReturnType<typeof makeWorkflowStore>>;
