/**
 * Consumes entity-store's change queue: each committed entity write becomes automations'
 * lifecycle event and reaches the automations watching its type, whoever made the write. Delivery
 * is at least once and unordered, so everything here is keyed by the entity and its revision.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Event } from "../events/model.ts";
import { Events } from "../events/service.ts";
import { ChangeEvent } from "./entity-store-api.ts";
import { EntityStore } from "./store.ts";
import { EntitySubscribers } from "./subscribers.ts";
import { depthOf, isMigration } from "./write-meta.ts";

export class EntityChangeError extends Schema.TaggedError<EntityChangeError>()(
  "EntityChangeError",
  { message: Schema.String },
) {}

/** The ID a change's lifecycle event, and the runs it starts, are known by. */
export const changeKey = (id: string, rev: number) => `entity:${id}:${rev}`;

/**
 * Delivers one queue message:
 *
 * 1. Reads the change from entity-store, with its data at the type's latest version.
 * 2. Publishes `entity.created`, `entity.updated` or `entity.deleted` as `entity:<id>:<rev>`, at
 *    the depth the write's `meta` carries, so an event chain stops at the same limit it would
 *    without the service boundary.
 * 3. For anything but a delete, notifies each automation watching the type under the same key, so
 *    a redelivered message finds the run it started instead of starting another. A write made by
 *    an event chain passes its lifecycle event as the run's origin, at that depth.
 *
 * A failure fails the message so the queue retries it. Messages that can never be delivered are
 * dropped with a warning: one that isn't a change, and one whose change is gone because its type
 * was deleted. Changes to roles, to types automations can't use, and the data migration's
 * writes publish nothing.
 */
export const deliverEntityChange = Effect.fn("EntityChanges.deliver")(function* (input: unknown) {
  const message = Schema.decodeUnknownOption(ChangeEvent)(input);
  if (message._tag === "None") {
    return yield* Effect.logWarning("Dropped an entity-store message that isn't a change");
  }
  const { id, rev } = message.value;
  if (isMigration(message.value.meta)) {
    return;
  }
  const store = yield* EntityStore;
  const change = yield* store.getChange(id, rev);
  if (change === undefined) {
    return yield* Effect.logWarning("Dropped an entity change entity-store no longer has").pipe(
      Effect.annotateLogs({ id, rev }),
    );
  }
  if (change.entityType === undefined || isMigration(change.meta)) {
    return;
  }
  const depth = depthOf(change.meta);
  const event: Event = {
    id: changeKey(id, rev),
    name:
      change.op === "delete"
        ? "entity.deleted"
        : change.op === "create"
          ? "entity.created"
          : "entity.updated",
    data: { before: change.before, after: change.after },
    subject: { type: change.type, id, data: change.after ?? change.before ?? {} },
    depth,
  };
  yield* (yield* Events).publish(event);
  if (change.after === null) {
    return;
  }
  const subscribers = yield* EntitySubscribers;
  const outcomes = yield* subscribers.notify(
    { before: change.before ?? undefined, after: { type: change.type, id, data: change.after } },
    event.id,
    depth > 0 ? event : undefined,
  );
  const failed = outcomes.filter((outcome) => outcome.error !== null);
  if (failed.length > 0) {
    return yield* new EntityChangeError({
      message: failed.map((outcome) => `${outcome.automation}: ${outcome.error}`).join("; "),
    });
  }
});
