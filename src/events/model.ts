/** Named, replay-stable messages shared by producers and consumers. */
import * as Schema from "effect/Schema";
import { EntityData, EntityId, EntityName, Subject } from "../entities/model.ts";

export const EntityPut = Schema.Struct({ type: EntityName, id: EntityId, data: EntityData });

/** Data supplied for a targeted manual run, not a publication. The wrapper preserves JSON null. */
export const SuppliedEvent = Schema.Struct({ data: Schema.Json });
export type SuppliedEvent = typeof SuppliedEvent.Type;

export const EventName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_.-]{0,119}$/));
export const Event = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  name: EventName,
  data: Schema.Json,
  subject: Schema.optionalKey(Subject),
  /** Bounds event chains, including entity mutations, so a cycle cannot run forever. */
  depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16 })),
});
export type Event = typeof Event.Type;

/** Lifecycle facts are emitted only by the entity writer, never by clients or workflows. */
export const PublishEvent = Schema.Struct({
  ...Event.fields,
  name: EventName.check(
    Schema.makeFilter(
      (name) => !["entity.created", "entity.updated", "entity.deleted"].includes(name),
      {
        message: "Entity lifecycle events can only be emitted by the entity store",
      },
    ),
    // Provider ingress (src/channels/) publishes these; automations trust them to come from Slack.
    Schema.makeFilter((name) => !name.startsWith("slack."), {
      message: "Slack events can only be published by the Slack integration",
    }),
  ),
});
