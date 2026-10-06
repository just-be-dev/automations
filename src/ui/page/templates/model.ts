/** Tracks the selected approved template, its automation usage, and unsaved slot and wording edits. */
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import { EntityType, FieldType, Template } from "../../../entities.ts";
import { TemplateUsage } from "../../../workflow.ts";
import * as Change from "../../change/index.ts";

/** The templates, and the entity types their slots can point to. */
export const Catalog = defineTaggedUnion({
  Loading: {},
  Ready: { templates: Schema.Array(Template), types: Schema.Array(EntityType) },
  Unavailable: { error: Schema.String },
});

/** Which automations use the open template. */
export const Usage = defineTaggedUnion({
  NotSelected: {},
  Loading: { name: Schema.String },
  Ready: { name: Schema.String, usage: TemplateUsage },
  Unavailable: { name: Schema.String, error: Schema.String },
});

export const SlotDraft = Schema.Struct({
  key: Schema.Int,
  name: Schema.String,
  label: Schema.String,
  type: FieldType,
  to: Schema.String,
});
export type SlotDraft = typeof SlotDraft.Type;

/** One action input the template fills, such as `subject`, with its text. */
export const ContentDraft = Schema.Struct({
  key: Schema.Int,
  input: Schema.String,
  text: Schema.String,
});
export type ContentDraft = typeof ContentDraft.Type;

export const TemplateDraft = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  description: Schema.String,
  slots: Schema.Array(SlotDraft),
  content: Schema.Array(ContentDraft),
  nextKey: Schema.Int,
});
export type TemplateDraft = typeof TemplateDraft.Type;

export const Editor = defineTaggedUnion({
  Closed: {},
  Creating: { draft: TemplateDraft },
  Editing: { draft: TemplateDraft },
});
export type Editor = typeof Editor.Type;

export const Confirmation = defineTaggedUnion({
  None: {},
  Delete: { name: Schema.String },
});

export const Activity = defineTaggedUnion({
  Idle: {},
  Ready: { notice: Schema.String },
  Working: { notice: Schema.String },
  Failed: { error: Schema.String },
});

export const Model = Schema.Struct({
  change: Change.Model.pipe(Schema.withConstructorDefault(Effect.succeed(Change.initial))),
  maybeTemplateName: Schema.Option(Schema.String),
  catalog: Catalog,
  usage: Usage,
  editor: Editor,
  confirmation: Confirmation,
  activity: Activity,
});
export type Model = typeof Model.Type;

export const loadedTemplates = (model: Model): ReadonlyArray<Template> =>
  Catalog.guards.Ready(model.catalog) ? model.catalog.templates : [];

export const loadedTypes = (model: Model): ReadonlyArray<EntityType> =>
  Catalog.guards.Ready(model.catalog) ? model.catalog.types : [];

export const selectedTemplate = (model: Model): Option.Option<Template> =>
  Option.flatMap(model.maybeTemplateName, (name) =>
    Array.findFirst(loadedTemplates(model), (template) => template.name === name),
  );

export const isWorking = (model: Model) => Activity.guards.Working(model.activity);
