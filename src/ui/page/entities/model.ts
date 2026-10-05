import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import { EntityRecord, EntityType, FieldType } from "../../../entities.ts";

export const Types = defineTaggedUnion({
  Loading: {},
  Ready: { types: Schema.Array(EntityType) },
  Unavailable: { error: Schema.String },
});

export const Records = defineTaggedUnion({
  NotSelected: {},
  Loading: { type: Schema.String },
  Ready: { type: Schema.String, entities: Schema.Array(EntityRecord) },
  Unavailable: { type: Schema.String, error: Schema.String },
});

export const FieldDraft = Schema.Struct({
  key: Schema.Int,
  name: Schema.String,
  label: Schema.String,
  type: FieldType,
  to: Schema.String,
});
export type FieldDraft = typeof FieldDraft.Type;

export const TypeDraft = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  /** The `key` of the field that titles an entity, so renaming that field keeps it the title. */
  titleKey: Schema.Int,
  fields: Schema.Array(FieldDraft),
  nextKey: Schema.Int,
});
export type TypeDraft = typeof TypeDraft.Type;

export const TypeEditor = defineTaggedUnion({
  Closed: {},
  Creating: { draft: TypeDraft },
  Editing: { draft: TypeDraft },
});
export type TypeEditor = typeof TypeEditor.Type;

export const EntityDraft = Schema.Struct({
  id: Schema.String,
  values: Schema.Record(Schema.String, Schema.String),
});
export type EntityDraft = typeof EntityDraft.Type;

export const EntityEditor = defineTaggedUnion({
  Closed: {},
  Creating: { draft: EntityDraft },
  Editing: { draft: EntityDraft },
});
export type EntityEditor = typeof EntityEditor.Type;

export const Confirmation = defineTaggedUnion({
  None: {},
  DeleteType: { type: Schema.String },
  DeleteEntity: { type: Schema.String, id: Schema.String },
});

export const Activity = defineTaggedUnion({
  Idle: {},
  Ready: { notice: Schema.String },
  Working: { notice: Schema.String },
  Failed: { error: Schema.String },
});

export const Triggered = Schema.Struct({
  automation: Schema.String,
  runId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type Triggered = typeof Triggered.Type;

export const Model = Schema.Struct({
  maybeTypeName: Schema.Option(Schema.String),
  types: Types,
  records: Records,
  typeEditor: TypeEditor,
  entityEditor: EntityEditor,
  confirmation: Confirmation,
  activity: Activity,
});
export type Model = typeof Model.Type;

export const loadedTypes = (model: Model): ReadonlyArray<EntityType> =>
  Types.guards.Ready(model.types) ? model.types.types : [];

export const selectedType = (model: Model): Option.Option<EntityType> =>
  Option.flatMap(model.maybeTypeName, (name) =>
    Array.findFirst(loadedTypes(model), (type) => type.name === name),
  );

export const isWorking = (model: Model) => Activity.guards.Working(model.activity);
