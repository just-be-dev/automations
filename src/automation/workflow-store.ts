/** Reads snapshots and the current catalog; saving validates, persists, schedules, and updates subscriptions. */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EntityStore } from "../entities/store.ts";
import { checkWorkflow } from "../workflow/catalog.ts";
import { isTimed, subjectType, triggerSchedule, Workflow } from "../workflow/model.ts";
import { MAX_SCHEDULED_RUNS, nextOccurrence, tooManyRuns } from "../workflow/schedule.ts";
import { AutomationHost, decodeStored } from "./host.ts";
import { AutomationIndex } from "./index.ts";
import { AutomationError } from "./model.ts";
import { makeSubjects } from "./subjects.ts";
import { STUDIO_LINK_KEY, StudioLink } from "./studio-link.ts";

/** The entity types and templates a workflow is checked against, as they are now. */
export const catalogOf = (entities: EntityStore["Service"]) =>
  Effect.all({
    types: entities.listTypes,
    templates: entities.listTemplates,
  });

/** Draft and saved snapshots share the same storage and current catalog. */
/**
 * When the saved trigger took effect: the first save of it, kept while later saves keep the same
 * trigger. Entity changes committed before it don't start runs.
 */
export const TRIGGER_SINCE_KEY = "triggerSince";

/** JSON with sorted keys, so stored values compare by content. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)))
      : item,
  );

export const makeWorkflowStore = Effect.fn("Automation.makeWorkflowStore")(function* () {
  const { storage, jobs } = yield* AutomationHost;
  const entities = yield* EntityStore;
  const index = yield* AutomationIndex;
  const subjects = yield* makeSubjects();
  const read = (key: "draft" | "saved") =>
    storage.get(key).pipe(Effect.flatMap(decodeStored(Workflow)));
  const catalog = catalogOf(entities);
  /** The automation's ID and studio origin as its latest save recorded them. */
  const studioLink = storage.get(STUDIO_LINK_KEY).pipe(Effect.flatMap(decodeStored(StudioLink)));

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
   *
   * `studioOrigin` is the studio the save came from, when the caller knows it. Saving keeps it
   * with the automation's ID, so messages its runs send can link back to them.
   */
  const save = Effect.fn("Automation.save")(function* (
    automationId: string,
    studioOrigin?: string,
  ) {
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
    const previous = yield* read("saved");
    yield* storage
      .transaction(
        Effect.gen(function* () {
          yield* storage.put("saved", draft);
          if (previous === undefined || canonical(previous.trigger) !== canonical(trigger)) {
            yield* storage.put(TRIGGER_SINCE_KEY, now);
          }
          // A save that doesn't know the studio keeps the origin an earlier one recorded.
          const origin = studioOrigin ?? (yield* studioLink)?.origin;
          const link: StudioLink = { automationId, ...(origin === undefined ? {} : { origin }) };
          yield* storage.put(STUDIO_LINK_KEY, link);
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

  const triggerSince = storage
    .get(TRIGGER_SINCE_KEY)
    .pipe(Effect.flatMap(decodeStored(Schema.Finite)));

  return { read, catalog, save, studioLink, triggerSince };
});

export type WorkflowStore = Effect.Success<ReturnType<typeof makeWorkflowStore>>;
