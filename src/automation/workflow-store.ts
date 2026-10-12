/** Reads snapshots and the current catalog; saving validates, persists, schedules, and updates subscriptions. */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { EntityStore } from "../entities/store.ts";
import { checkWorkflow } from "../workflow/catalog.ts";
import { isTimed, subjectType, triggerSchedule, Workflow } from "../workflow/model.ts";
import { MAX_SCHEDULED_RUNS, nextOccurrence, tooManyRuns } from "../workflow/schedule.ts";
import { AutomationHost, decodeOrDrop } from "./host.ts";
import { AutomationIndex } from "./index.ts";
import { AutomationError } from "./model.ts";
import { makeSubjects } from "./subjects.ts";

/** The entity types, templates, and roles a workflow is checked against, as they are now. */
export const catalogOf = (entities: EntityStore["Service"]) =>
  Effect.all({
    types: entities.listTypes,
    templates: entities.listTemplates,
    roles: entities.listRoles,
  });

/** Draft and saved snapshots share the same storage and current catalog. */
export const makeWorkflowStore = Effect.fn("Automation.makeWorkflowStore")(function* () {
  const { storage, jobs } = yield* AutomationHost;
  const entities = yield* EntityStore;
  const index = yield* AutomationIndex;
  const subjects = yield* makeSubjects();
  const read = (key: "draft" | "saved") =>
    storage.get(key).pipe(Effect.flatMap(decodeOrDrop(Workflow)));
  const catalog = catalogOf(entities);

  /**
   * Save is complete only after the trigger subscription is updated. The subscription records
   * the entity type the trigger is about, which also keeps that type from being deleted. The
   * snapshot and its schedule commit together, but the entity store cannot share that
   * transaction: if subscribing fails, the snapshot remains saved and the caller gets the
   * failure. Retrying save repeats the subscription write safely. Directory updates only label
   * the studio, so their failure must not fail a save.
   *
   * A timed trigger that would already match more entities than one occurrence may start isn't
   * saved, so the person hears about it now rather than from a failed run.
   */
  const save = Effect.fn("Automation.save")(function* (automationId: string) {
    const draft = yield* read("draft");
    if (draft === undefined) {
      return yield* new AutomationError({ message: "No draft to save" });
    }
    yield* checkWorkflow(yield* catalog, draft);
    const { trigger } = draft;
    const now = yield* Clock.currentTimeMillis;
    if (isTimed(trigger)) {
      const matching = yield* subjects.due(trigger, now);
      if (matching.length > MAX_SCHEDULED_RUNS) {
        return yield* new AutomationError({ message: tooManyRuns(matching.length) });
      }
    }
    yield* storage
      .transaction(
        Effect.gen(function* () {
          yield* storage.put("saved", draft);
          yield* isTimed(trigger)
            ? jobs.tick(nextOccurrence(triggerSchedule(trigger), now))
            : jobs.cancelTick;
        }),
      )
      .pipe(Effect.orDie);
    yield* entities.subscribe(automationId, subjectType(trigger));
    yield* index
      .record(automationId, draft.name)
      .pipe(Effect.ignore({ log: "Warn", message: "Couldn't update the automation directory" }));
    return { saved: draft };
  });

  return { read, catalog, save };
});

export type WorkflowStore = Effect.Success<ReturnType<typeof makeWorkflowStore>>;
