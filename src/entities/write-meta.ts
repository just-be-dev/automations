/**
 * What automations stores in `meta` on the entity writes it makes, and reads back from
 * entity-store's changes. entity-store keeps it with the change without reading it, so an event
 * chain keeps its depth across the service boundary, and a confirmed change can find its write.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { MAX_EVENT_DEPTH } from "../events/model.ts";
import type { WriteMeta } from "./entity-store-api.ts";

export const ChangeMeta = Schema.Struct({
  /** The depth of the lifecycle event the write publishes. */
  depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_EVENT_DEPTH })),
  /** The event whose `entity.put` command made the write. */
  sourceEventId: Schema.optionalKey(Schema.String),
  /** The confirmed change (`Changes` proposal ID) that made the write. */
  changeId: Schema.optionalKey(Schema.String),
});
export type ChangeMeta = typeof ChangeMeta.Type;

export const changeMeta = (meta: ChangeMeta): WriteMeta => ({ ...meta });

/** The change ID a write's `meta` names, if any. */
export const changeIdOf = (meta: WriteMeta | null) => {
  const changeId = meta?.["changeId"];
  return typeof changeId === "string" ? changeId : undefined;
};

/**
 * The depth to publish a change's lifecycle event at. A write without automations' `meta` (made
 * in entity-store directly) starts a chain at 0. A depth that isn't one automations writes is
 * taken as the limit, so a chain it can't trust stops instead of continuing.
 */
export const depthOf = (meta: WriteMeta | null): number => {
  if (meta === null || meta["depth"] === undefined) {
    return 0;
  }
  return Option.getOrElse(
    Schema.decodeUnknownOption(ChangeMeta.fields.depth)(meta["depth"]),
    () => MAX_EVENT_DEPTH,
  );
};
