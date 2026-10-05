import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Command, Http, Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { pushUrl } from "foldkit/navigation";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { CircleAlert, Database, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide";
import { button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { input, inputClass, inputLabelClass, inputWrapperClass } from "@/components/ui/input";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import {
  EntityRecord,
  EntityType,
  FieldType,
  Subject,
  type EntityData,
  type EntityField,
} from "../../entities.ts";
import { errorText, requestJson, sendJson } from "../api.ts";
import { localDateTimeText } from "../datetime.ts";
import { entitiesHref, entitiesPath } from "../route.ts";

/**
 * A debug page for the entity store at `/entities`: define entity types, and create, edit, and
 * delete their entities. `?type=<name>` selects a type, so the URL decides what's open and the root
 * app passes it in with `reflectUrl`.
 */

// MODEL

const Types = defineTaggedUnion({
  Loading: {},
  Ready: { types: Schema.Array(EntityType) },
  Unavailable: { error: Schema.String },
});

const Records = defineTaggedUnion({
  NotSelected: {},
  Loading: { type: Schema.String },
  Ready: { type: Schema.String, entities: Schema.Array(EntityRecord) },
  Unavailable: { type: Schema.String, error: Schema.String },
});

const FieldDraft = Schema.Struct({
  key: Schema.Int,
  name: Schema.String,
  label: Schema.String,
  type: FieldType,
  to: Schema.String,
});
type FieldDraft = typeof FieldDraft.Type;

const TypeDraft = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  /** The `key` of the field that titles an entity, so renaming that field keeps it the title. */
  titleKey: Schema.Int,
  fields: Schema.Array(FieldDraft),
  nextKey: Schema.Int,
});
type TypeDraft = typeof TypeDraft.Type;

const TypeEditor = defineTaggedUnion({
  Closed: {},
  Creating: { draft: TypeDraft },
  Editing: { draft: TypeDraft },
});
type TypeEditor = typeof TypeEditor.Type;

const EntityDraft = Schema.Struct({
  id: Schema.String,
  values: Schema.Record(Schema.String, Schema.String),
});
type EntityDraft = typeof EntityDraft.Type;

const EntityEditor = defineTaggedUnion({
  Closed: {},
  Creating: { draft: EntityDraft },
  Editing: { draft: EntityDraft },
});
type EntityEditor = typeof EntityEditor.Type;

const Confirmation = defineTaggedUnion({
  None: {},
  DeleteType: { type: Schema.String },
  DeleteEntity: { type: Schema.String, id: Schema.String },
});

const Activity = defineTaggedUnion({
  Idle: {},
  Ready: { notice: Schema.String },
  Working: { notice: Schema.String },
  Failed: { error: Schema.String },
});

const Triggered = Schema.Struct({
  automation: Schema.String,
  runId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
type Triggered = typeof Triggered.Type;

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

// MESSAGE

export const Message = defineMessageUnion({
  ClickedNewType: {},
  ClickedEditType: {},
  ClickedCancelType: {},
  UpdatedTypeName: { value: Schema.String },
  UpdatedTypeLabel: { value: Schema.String },
  SelectedTitleField: { value: Schema.String },
  ClickedAddField: {},
  ClickedRemoveField: { key: Schema.Int },
  UpdatedFieldName: { key: Schema.Int, value: Schema.String },
  UpdatedFieldLabel: { key: Schema.Int, value: Schema.String },
  SelectedFieldType: { key: Schema.Int, value: Schema.String },
  SelectedFieldTarget: { key: Schema.Int, value: Schema.String },
  SubmittedType: {},
  ClickedDeleteType: {},
  ClickedNewEntity: {},
  ClickedEditEntity: { id: Schema.String },
  ClickedCancelEntity: {},
  UpdatedEntityId: { value: Schema.String },
  UpdatedEntityField: { field: Schema.String, value: Schema.String },
  SubmittedEntity: {},
  ClickedDeleteEntity: { id: Schema.String },
  ClickedConfirmDelete: {},
  ClickedCancelDelete: {},
  SucceededLoadTypes: { types: Schema.Array(EntityType) },
  FailedLoadTypes: { error: Schema.String },
  SucceededLoadEntities: { type: Schema.String, entities: Schema.Array(EntityRecord) },
  FailedLoadEntities: { type: Schema.String, error: Schema.String },
  SucceededSaveType: { type: EntityType, isNew: Schema.Boolean },
  SucceededDeleteType: { type: Schema.String },
  SucceededSaveEntity: { entity: Subject, triggered: Schema.Array(Triggered) },
  SucceededDeleteEntity: { type: Schema.String, id: Schema.String },
  FailedRequest: { error: Schema.String },
  CompletedNavigateToEntities: {},
});
export type Message = typeof Message.Type;

type UpdateReturn = Update.Return<Model, Message>;

// INIT

const recordsFor = (maybeTypeName: Option.Option<string>) =>
  Option.match(maybeTypeName, {
    onNone: () => Records.NotSelected(),
    onSome: (type) => Records.Loading({ type }),
  });

const loadRecords = (maybeTypeName: Option.Option<string>) =>
  Option.match(maybeTypeName, {
    onNone: () => [],
    onSome: (type) => [LoadEntities({ type })],
  });

export const init = (maybeTypeName: Option.Option<string>): UpdateReturn => ({
  model: Model.make({
    maybeTypeName,
    types: Types.Loading(),
    records: recordsFor(maybeTypeName),
    typeEditor: TypeEditor.Closed(),
    entityEditor: EntityEditor.Closed(),
    confirmation: Confirmation.None(),
    activity: Activity.Idle(),
  }),
  commands: [LoadTypes(), ...loadRecords(maybeTypeName)],
});

/** Opens the type the URL selects. Any open form closes; the last notice stays. */
export const reflectUrl = (model: Model, maybeTypeName: Option.Option<string>): UpdateReturn => {
  if (Equal.equals(model.maybeTypeName, maybeTypeName)) {
    return { model };
  }
  return {
    model: modifyFields(model, {
      maybeTypeName: () => maybeTypeName,
      records: () => recordsFor(maybeTypeName),
      typeEditor: () => TypeEditor.Closed(),
      entityEditor: () => EntityEditor.Closed(),
      confirmation: () => Confirmation.None(),
    }),
    commands: loadRecords(maybeTypeName),
  };
};

// UPDATE

const typeOrder = Order.mapInput(Order.String, (type: EntityType) => type.name);

const loadedTypes = (model: Model): ReadonlyArray<EntityType> =>
  Types.guards.Ready(model.types) ? model.types.types : [];

export const selectedType = (model: Model): Option.Option<EntityType> =>
  Option.flatMap(model.maybeTypeName, (name) =>
    Array.findFirst(loadedTypes(model), (type) => type.name === name),
  );

const isWorking = (model: Model) => Activity.guards.Working(model.activity);

const working = (model: Model, notice: string) =>
  modifyFields(model, { activity: () => Activity.Working({ notice }) });

const fail = (model: Model, error: string): UpdateReturn => ({
  model: modifyFields(model, { activity: () => Activity.Failed({ error }) }),
});

const newTypeDraft: TypeDraft = {
  name: "",
  label: "",
  titleKey: 0,
  fields: [{ key: 0, name: "name", label: "Name", type: "text", to: "" }],
  nextKey: 1,
};

const typeDraftOf = (type: EntityType): TypeDraft => {
  const fields = Array.map(type.fields, (field, key) => ({
    key,
    name: field.name,
    label: field.label,
    type: field.type,
    to: field.to ?? "",
  }));
  return {
    name: type.name,
    label: type.label,
    titleKey: Option.match(
      Array.findFirst(fields, (field) => field.name === type.title),
      { onNone: () => 0, onSome: (field) => field.key },
    ),
    fields,
    nextKey: fields.length,
  };
};

const withTypeDraft = (model: Model, change: (draft: TypeDraft) => TypeDraft): UpdateReturn => ({
  model: modifyFields(model, {
    typeEditor: (editor) =>
      TypeEditor.match(editor, {
        Closed: () => editor,
        Creating: ({ draft }) => TypeEditor.Creating({ draft: change(draft) }),
        Editing: ({ draft }) => TypeEditor.Editing({ draft: change(draft) }),
      }),
  }),
});

const withField = (model: Model, key: number, change: (field: FieldDraft) => FieldDraft) =>
  withTypeDraft(model, (draft) =>
    modifyFields(draft, {
      fields: (fields) => Array.map(fields, (field) => (field.key === key ? change(field) : field)),
    }),
  );

const labelFromName = (name: string) => {
  const words = name.trim().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The type a draft describes, or the first thing to fix. The server checks refs again. */
export const typeFromDraft = (draft: TypeDraft): Result.Result<EntityType, string> => {
  const untargeted = Array.findFirst(
    draft.fields,
    (field) => field.type === "ref" && field.to === "",
  );
  if (Option.isSome(untargeted)) {
    return Result.fail(`Choose the type ${untargeted.value.name || "the ref field"} points to`);
  }
  const maybeTitle = Array.findFirst(draft.fields, (field) => field.key === draft.titleKey);
  if (Option.isNone(maybeTitle)) {
    return Result.fail("Choose the field that titles each entity");
  }
  const name = draft.name.trim();
  return Schema.decodeResult(EntityType)({
    name,
    label: draft.label.trim() || labelFromName(name),
    title: maybeTitle.value.name.trim(),
    fields: Array.map(draft.fields, (field) => ({
      name: field.name.trim(),
      label: field.label.trim() || labelFromName(field.name),
      type: field.type,
      ...(field.type === "ref" ? { to: field.to } : {}),
    })),
  }).pipe(Result.mapError((error) => error.message));
};

const fieldText = (value: Schema.Json | undefined): string => {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
};

const entityDraftOf = (type: EntityType, entity: EntityRecord): EntityDraft => ({
  id: entity.id,
  values: Object.fromEntries(
    Array.map(type.fields, (field) => [field.name, fieldText(entity.data[field.name])]),
  ),
});

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const fieldTypeArticle: Record<FieldType, string> = {
  text: "text",
  number: "a number",
  boolean: "yes or no",
  date: "a date (YYYY-MM-DD)",
  datetime: "a date and time",
  ref: "an entity ID",
};

const fieldParsers: Record<FieldType, (text: string) => Option.Option<Schema.Json>> = {
  text: (text) => Option.some(text),
  ref: (text) => Option.some(text.trim()),
  number: (text) => {
    const value = Number(text.trim());
    return Number.isFinite(value) ? Option.some(value) : Option.none();
  },
  boolean: (text) => Option.some(text.trim() === "true"),
  date: (text) => (isoDate.test(text.trim()) ? Option.some(text.trim()) : Option.none()),
  datetime: (text) =>
    Number.isNaN(Date.parse(text)) ? Option.none() : Option.some(new Date(text).toISOString()),
};

const fieldValue = (field: EntityField, text: string): Result.Result<Schema.Json, string> =>
  text.trim() === ""
    ? Result.succeed(null)
    : Option.match(fieldParsers[field.type](text), {
        onNone: () => Result.fail(`${field.label} must be ${fieldTypeArticle[field.type]}`),
        onSome: (value) => Result.succeed(value),
      });

/** Every field of the type, with empty inputs sent as `null` so they clear the stored value. */
export const entityDataFromDraft = (
  type: EntityType,
  draft: EntityDraft,
): Result.Result<EntityData, string> =>
  Result.all(
    Array.map(type.fields, (field) =>
      Result.map(
        fieldValue(field, draft.values[field.name] ?? ""),
        (value): readonly [string, Schema.Json] => [field.name, value],
      ),
    ),
  ).pipe(Result.map((entries) => Object.fromEntries(entries)));

const validEntityId = /^[a-zA-Z0-9_.@-]{1,120}$/;

const withEntityDraft = (
  model: Model,
  change: (draft: EntityDraft) => EntityDraft,
): UpdateReturn => ({
  model: modifyFields(model, {
    entityEditor: (editor) =>
      EntityEditor.match(editor, {
        Closed: () => editor,
        Creating: ({ draft }) => EntityEditor.Creating({ draft: change(draft) }),
        Editing: ({ draft }) => EntityEditor.Editing({ draft: change(draft) }),
      }),
  }),
});

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const triggeredText = (triggered: ReadonlyArray<Triggered>) => {
  const started = Array.filter(triggered, (run) => run.runId !== null).length;
  const failed = Array.filter(triggered, (run) => run.error !== null).length;
  return [
    ...(started > 0 ? [`started ${plural(started, "run", "runs")}`] : []),
    ...(failed > 0 ? [`${plural(failed, "automation", "automations")} couldn't start`] : []),
  ].join("; ");
};

const submitType = (model: Model, draft: TypeDraft, isNew: boolean): UpdateReturn => {
  if (isWorking(model)) {
    return { model };
  }
  return Result.match(typeFromDraft(draft), {
    onFailure: (error) => fail(model, error),
    onSuccess: (type) =>
      isNew && Array.some(loadedTypes(model), (existing) => existing.name === type.name)
        ? fail(model, `There is already a type named ${type.name}`)
        : {
            model: working(model, `Saving ${type.name}…`),
            commands: [SaveType({ type, isNew })],
          },
  });
};

const submitEntity = (model: Model, draft: EntityDraft, isNew: boolean): UpdateReturn => {
  if (isWorking(model)) {
    return { model };
  }
  return Option.match(selectedType(model), {
    onNone: () => ({ model }),
    onSome: (type) => {
      const id = draft.id.trim();
      if (!validEntityId.test(id)) {
        return fail(model, "IDs use letters, numbers, _ . @ and - (up to 120 characters)");
      }
      const isTaken =
        isNew &&
        Records.guards.Ready(model.records) &&
        Array.some(model.records.entities, (entity) => entity.id === id);
      if (isTaken) {
        return fail(model, `There is already ${withArticle(type.name)} with ID ${id}`);
      }
      return Result.match(entityDataFromDraft(type, draft), {
        onFailure: (error) => fail(model, error),
        onSuccess: (data) => ({
          model: working(model, `Saving ${id}…`),
          commands: [SaveEntity({ type: type.name, id, data })],
        }),
      });
    },
  });
};

export const withArticle = (name: string) => {
  const words = name.replaceAll("_", " ");
  return `${/^[aeiou]/i.test(words) ? "an" : "a"} ${words}`;
};

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedNewType: () => ({
      model: modifyFields(model, {
        typeEditor: () => TypeEditor.Creating({ draft: newTypeDraft }),
        entityEditor: () => EntityEditor.Closed(),
        confirmation: () => Confirmation.None(),
      }),
    }),
    ClickedEditType: () =>
      Option.match(selectedType(model), {
        onNone: () => ({ model }),
        onSome: (type) => ({
          model: modifyFields(model, {
            typeEditor: () => TypeEditor.Editing({ draft: typeDraftOf(type) }),
            entityEditor: () => EntityEditor.Closed(),
            confirmation: () => Confirmation.None(),
          }),
        }),
      }),
    ClickedCancelType: () => ({
      model: modifyFields(model, { typeEditor: () => TypeEditor.Closed() }),
    }),
    UpdatedTypeName: ({ value }) =>
      withTypeDraft(model, (draft) => modifyFields(draft, { name: () => value })),
    UpdatedTypeLabel: ({ value }) =>
      withTypeDraft(model, (draft) => modifyFields(draft, { label: () => value })),
    SelectedTitleField: ({ value }) =>
      withTypeDraft(model, (draft) => modifyFields(draft, { titleKey: () => Number(value) })),
    ClickedAddField: () =>
      withTypeDraft(model, (draft) =>
        modifyFields(draft, {
          fields: (fields) =>
            Array.append(fields, {
              key: draft.nextKey,
              name: "",
              label: "",
              type: "text",
              to: "",
            }),
          nextKey: (key) => key + 1,
        }),
      ),
    ClickedRemoveField: ({ key }) =>
      withTypeDraft(model, (draft) =>
        modifyFields(draft, {
          fields: (fields) => Array.filter(fields, (field) => field.key !== key),
        }),
      ),
    UpdatedFieldName: ({ key, value }) =>
      withField(model, key, (field) => modifyFields(field, { name: () => value })),
    UpdatedFieldLabel: ({ key, value }) =>
      withField(model, key, (field) => modifyFields(field, { label: () => value })),
    SelectedFieldType: ({ key, value }) =>
      Option.match(Schema.decodeUnknownOption(FieldType)(value), {
        onNone: () => ({ model }),
        onSome: (type) =>
          withField(model, key, (field) => modifyFields(field, { type: () => type })),
      }),
    SelectedFieldTarget: ({ key, value }) =>
      withField(model, key, (field) => modifyFields(field, { to: () => value })),
    SubmittedType: () =>
      TypeEditor.match(model.typeEditor, {
        Closed: () => ({ model }),
        Creating: ({ draft }) => submitType(model, draft, true),
        Editing: ({ draft }) => submitType(model, draft, false),
      }),
    ClickedDeleteType: () =>
      Option.match(selectedType(model), {
        onNone: () => ({ model }),
        onSome: (type) => ({
          model: modifyFields(model, {
            confirmation: () => Confirmation.DeleteType({ type: type.name }),
          }),
        }),
      }),
    ClickedNewEntity: () =>
      Option.match(selectedType(model), {
        onNone: () => ({ model }),
        onSome: () => ({
          model: modifyFields(model, {
            entityEditor: () => EntityEditor.Creating({ draft: { id: "", values: {} } }),
            confirmation: () => Confirmation.None(),
          }),
        }),
      }),
    ClickedEditEntity: ({ id }) => {
      const maybeDraft = Option.flatMap(selectedType(model), (type) =>
        Records.guards.Ready(model.records)
          ? Option.map(
              Array.findFirst(model.records.entities, (entity) => entity.id === id),
              (entity) => entityDraftOf(type, entity),
            )
          : Option.none(),
      );
      return Option.match(maybeDraft, {
        onNone: () => ({ model }),
        onSome: (draft) => ({
          model: modifyFields(model, {
            entityEditor: () => EntityEditor.Editing({ draft }),
            confirmation: () => Confirmation.None(),
          }),
        }),
      });
    },
    ClickedCancelEntity: () => ({
      model: modifyFields(model, { entityEditor: () => EntityEditor.Closed() }),
    }),
    UpdatedEntityId: ({ value }) =>
      withEntityDraft(model, (draft) => modifyFields(draft, { id: () => value })),
    UpdatedEntityField: ({ field, value }) =>
      withEntityDraft(model, (draft) =>
        modifyFields(draft, { values: (values) => ({ ...values, [field]: value }) }),
      ),
    SubmittedEntity: () =>
      EntityEditor.match(model.entityEditor, {
        Closed: () => ({ model }),
        Creating: ({ draft }) => submitEntity(model, draft, true),
        Editing: ({ draft }) => submitEntity(model, draft, false),
      }),
    ClickedDeleteEntity: ({ id }) =>
      Option.match(model.maybeTypeName, {
        onNone: () => ({ model }),
        onSome: (type) => ({
          model: modifyFields(model, {
            confirmation: () => Confirmation.DeleteEntity({ type, id }),
          }),
        }),
      }),
    ClickedConfirmDelete: () => {
      if (isWorking(model)) {
        return { model };
      }
      return Confirmation.match<UpdateReturn>(model.confirmation, {
        None: () => ({ model }),
        DeleteType: ({ type }) => ({
          model: modifyFields(working(model, `Deleting ${type}…`), {
            confirmation: () => Confirmation.None(),
          }),
          commands: [DeleteType({ type })],
        }),
        DeleteEntity: ({ type, id }) => ({
          model: modifyFields(working(model, `Deleting ${id}…`), {
            confirmation: () => Confirmation.None(),
          }),
          commands: [DeleteEntity({ type, id })],
        }),
      });
    },
    ClickedCancelDelete: () => ({
      model: modifyFields(model, { confirmation: () => Confirmation.None() }),
    }),
    SucceededLoadTypes: ({ types }) => ({
      model: modifyFields(model, { types: () => Types.Ready({ types }) }),
    }),
    FailedLoadTypes: ({ error }) => ({
      model: modifyFields(model, { types: () => Types.Unavailable({ error }) }),
    }),
    SucceededLoadEntities: ({ type, entities }) =>
      Option.contains(model.maybeTypeName, type)
        ? { model: modifyFields(model, { records: () => Records.Ready({ type, entities }) }) }
        : { model },
    FailedLoadEntities: ({ type, error }) =>
      Option.contains(model.maybeTypeName, type)
        ? { model: modifyFields(model, { records: () => Records.Unavailable({ type, error }) }) }
        : { model },
    SucceededSaveType: ({ type, isNew }) => ({
      model: modifyFields(model, {
        types: () =>
          Types.Ready({
            types: Array.sort(
              Array.append(
                Array.filter(loadedTypes(model), (existing) => existing.name !== type.name),
                type,
              ),
              typeOrder,
            ),
          }),
        typeEditor: () => TypeEditor.Closed(),
        activity: () => Activity.Ready({ notice: `Saved ${type.name}` }),
      }),
      commands: isNew
        ? [NavigateToEntities({ url: entitiesHref(Option.some(type.name)) })]
        : loadRecords(model.maybeTypeName),
    }),
    SucceededDeleteType: ({ type }) => ({
      model: modifyFields(model, {
        types: () =>
          Types.Ready({
            types: Array.filter(loadedTypes(model), (existing) => existing.name !== type),
          }),
        activity: () => Activity.Ready({ notice: `Deleted ${type}` }),
      }),
      commands: [NavigateToEntities({ url: entitiesPath })],
    }),
    SucceededSaveEntity: ({ entity, triggered }) => {
      const runs = triggeredText(triggered);
      return {
        model: modifyFields(model, {
          entityEditor: () => EntityEditor.Closed(),
          activity: () =>
            Activity.Ready({
              notice: runs === "" ? `Saved ${entity.id}` : `Saved ${entity.id}; ${runs}`,
            }),
        }),
        commands: loadRecords(model.maybeTypeName),
      };
    },
    SucceededDeleteEntity: ({ type, id }) => ({
      model: modifyFields(model, {
        records: (records) =>
          Records.guards.Ready(records) && records.type === type
            ? Records.Ready({
                type,
                entities: Array.filter(records.entities, (entity) => entity.id !== id),
              })
            : records,
        entityEditor: (editor) =>
          EntityEditor.guards.Editing(editor) && editor.draft.id === id
            ? EntityEditor.Closed()
            : editor,
        activity: () => Activity.Ready({ notice: `Deleted ${id}` }),
      }),
    }),
    FailedRequest: ({ error }) => fail(model, error),
    CompletedNavigateToEntities: () => ({ model }),
  });

// COMMAND

const recoverRequest = Effect.catch((error: unknown) =>
  Effect.succeed(Message.FailedRequest({ error: errorText(error) })),
);

export const LoadTypes = Command.define("LoadTypes", {
  messages: [Message.SucceededLoadTypes, Message.FailedLoadTypes],
  execute: requestJson("/api/entities/types", Schema.Array(EntityType)).pipe(
    Effect.map((types) => Message.SucceededLoadTypes({ types })),
    Effect.catch((error) => Effect.succeed(Message.FailedLoadTypes({ error: errorText(error) }))),
    Effect.provide(Http.layer),
  ),
});

export const LoadEntities = Command.define("LoadEntities", {
  args: { type: Schema.String },
  messages: [Message.SucceededLoadEntities, Message.FailedLoadEntities],
  execute: ({ type }) =>
    requestJson(`/api/entities/${type}`, Schema.Array(EntityRecord)).pipe(
      Effect.map((entities) => Message.SucceededLoadEntities({ type, entities })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedLoadEntities({ type, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});

export const SaveType = Command.define("SaveType", {
  args: { type: EntityType, isNew: Schema.Boolean },
  messages: [Message.SucceededSaveType, Message.FailedRequest],
  execute: ({ type, isNew }) =>
    sendJson("PUT", `/api/entities/types/${type.name}`, EntityType, type).pipe(
      Effect.map((saved) => Message.SucceededSaveType({ type: saved, isNew })),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const DeleteType = Command.define("DeleteType", {
  args: { type: Schema.String },
  messages: [Message.SucceededDeleteType, Message.FailedRequest],
  execute: ({ type }) =>
    sendJson("DELETE", `/api/entities/types/${type}`, Schema.Unknown).pipe(
      Effect.as(Message.SucceededDeleteType({ type })),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

const SavedEntity = Schema.Struct({ entity: Subject, triggered: Schema.Array(Triggered) });

export const SaveEntity = Command.define("SaveEntity", {
  args: { type: Schema.String, id: Schema.String, data: Schema.Record(Schema.String, Schema.Json) },
  messages: [Message.SucceededSaveEntity, Message.FailedRequest],
  execute: ({ type, id, data }) =>
    sendJson("PUT", `/api/entities/${type}/${encodeURIComponent(id)}`, SavedEntity, { data }).pipe(
      Effect.map((saved) => Message.SucceededSaveEntity(saved)),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const DeleteEntity = Command.define("DeleteEntity", {
  args: { type: Schema.String, id: Schema.String },
  messages: [Message.SucceededDeleteEntity, Message.FailedRequest],
  execute: ({ type, id }) =>
    sendJson("DELETE", `/api/entities/${type}/${encodeURIComponent(id)}`, Schema.Unknown).pipe(
      Effect.as(Message.SucceededDeleteEntity({ type, id })),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const NavigateToEntities = Command.define("NavigateToEntities", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateToEntities],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateToEntities())),
});

// VIEW

const eyebrowClass = "text-xs font-medium text-sand-10";
const noteClass = "text-sm text-muted-foreground";
const chipClass = "rounded-[4px] bg-chip px-1.5 py-0.5 font-mono text-[0.92em] text-sand-11";
const cardClass = "rounded-[10px] bg-card shadow-card";
const selectClass = cn(inputClass, "bg-background md:text-[13px]");

const fieldTypeLabel = (field: EntityField) =>
  field.type === "ref" ? `ref → ${field.to ?? "?"}` : field.type;

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [h.Class("flex flex-1 flex-col lg:min-h-0")],
    [
      h.div(
        [h.Class("grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[15rem_minmax(0,1fr)]")],
        [typeListView(model, h), detailView(model, h)],
      ),
      h.div(
        [h.Class("flex min-h-12 items-center gap-4 border-t px-6 py-3")],
        [statusView(model, h)],
      ),
    ],
  ),
);

const typeListView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [
      h.AriaLabel("Entity types"),
      h.Class(
        "flex flex-col border-b px-3 py-4 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0",
      ),
    ],
    [
      h.div(
        [h.Class("mb-2 flex items-center justify-between gap-2 pl-1.5")],
        [
          h.h2(
            [h.Class("text-[11px] font-semibold tracking-tight text-sand-10")],
            ["Entity types"],
          ),
          button(
            {
              onClick: Message.ClickedNewType(),
              variant: "ghost",
              size: "icon-xs",
              className: "text-sand-10",
              attributes: [h.AriaLabel("New entity type"), h.Title("New entity type")],
            },
            [icon(h, Plus, "size-3.5")],
            h,
          ),
        ],
      ),
      Types.match(model.types, {
        Loading: () => h.p([h.Class(cn(noteClass, "px-1.5 text-xs"))], ["Loading…"]),
        Unavailable: ({ error }) =>
          h.p(
            [h.Class("px-1.5 text-xs text-destructive")],
            [`Couldn't load entity types: ${error}`],
          ),
        Ready: ({ types }) =>
          Array.match(types, {
            onEmpty: () =>
              h.p([h.Class(cn(noteClass, "px-1.5 text-xs"))], ["No entity types yet."]),
            onNonEmpty: (listed) =>
              h.ul(
                [h.Class("flex flex-col")],
                Array.map(listed, (type) =>
                  typeLinkView(type, Option.contains(model.maybeTypeName, type.name), h),
                ),
              ),
          }),
      }),
    ],
  );

const typeLinkView = (type: EntityType, isCurrent: boolean, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    type.name,
    [],
    [
      h.a(
        [
          h.Href(entitiesHref(Option.some(type.name))),
          ...(isCurrent ? [h.AriaCurrent("page")] : []),
          h.Class(
            cn(
              "my-px flex flex-col gap-0.5 rounded-[8px] px-2 py-1.5 text-muted-foreground transition-colors duration-100 outline-none hover:bg-hover hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
              isCurrent && "bg-hover text-foreground",
            ),
          ),
        ],
        [
          h.span([h.Class("truncate text-[13px] font-medium tracking-tight")], [type.label]),
          h.span(
            [h.Class("truncate font-mono text-[11px] text-sand-10")],
            [`${type.name} · ${plural(type.fields.length, "field", "fields")}`],
          ),
        ],
      ),
    ],
  );

const detailView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [
      h.AriaLabel("Entity type"),
      h.Class("flex flex-col gap-8 px-6 py-5 lg:min-h-0 lg:overflow-y-auto"),
    ],
    [
      TypeEditor.match(model.typeEditor, {
        Creating: ({ draft }) => typeFormView(draft, true, model, h),
        Editing: ({ draft }) => typeFormView(draft, false, model, h),
        Closed: () =>
          Option.match(selectedType(model), {
            onNone: () => noTypeView(model, h),
            onSome: (type) => typeDetailView(type, model, h),
          }),
      }),
    ],
  );

const noTypeView = (model: Model, h: HtmlBuilder<Message>) => {
  const maybeMissing = Option.filter(model.maybeTypeName, () => Types.guards.Ready(model.types));
  return Empty(
    { className: cn("max-w-xl", cardClass) },
    [
      Empty.header(
        {},
        [
          Empty.media({ className: "icon-tile" }, [icon(h, Database, "size-3.5")], h),
          Empty.title(
            {},
            [
              Option.match(maybeMissing, {
                onNone: () => "Entity store",
                onSome: (name) => `No entity type named ${name}`,
              }),
            ],
            h,
          ),
          Empty.description(
            {},
            [
              "Entity types describe the records automations act on, such as employees. Choose a type to see and edit its entities, or define a new one. Agents can use the same store over MCP at /api/mcp.",
            ],
            h,
          ),
        ],
        h,
      ),
      button(
        { onClick: Message.ClickedNewType(), size: "sm" },
        [icon(h, Plus, "size-3.5", "inline-start"), "New entity type"],
        h,
      ),
    ],
    h,
  );
};

const confirmView = (question: string, model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("flex items-center gap-2"), h.Role("group"), h.AriaLabel(question)],
    [
      h.span([h.Class("text-xs text-destructive")], [question]),
      button(
        {
          onClick: Message.ClickedConfirmDelete(),
          variant: "destructive",
          size: "xs",
          isDisabled: isWorking(model),
        },
        "Delete",
        h,
      ),
      button({ onClick: Message.ClickedCancelDelete(), variant: "ghost", size: "xs" }, "Keep", h),
    ],
  );

const typeDetailView = (type: EntityType, model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("flex flex-col gap-8")],
    [
      h.div(
        [h.Class("flex flex-wrap items-start justify-between gap-4")],
        [
          h.div(
            [h.Class("min-w-0")],
            [
              h.div([h.Class(eyebrowClass)], ["Entity type"]),
              h.h2(
                [h.Class("flex items-center gap-2 text-xl font-semibold")],
                [type.label, h.span([h.Class(cn(chipClass, "text-xs font-normal"))], [type.name])],
              ),
            ],
          ),
          h.div(
            [h.Class("flex items-center gap-2")],
            [
              button(
                { onClick: Message.ClickedEditType(), variant: "outline", size: "sm" },
                [icon(h, Pencil, "size-3.5", "inline-start"), "Edit type"],
                h,
              ),
              Confirmation.guards.DeleteType(model.confirmation)
                ? confirmView(`Delete ${type.name}?`, model, h)
                : button(
                    { onClick: Message.ClickedDeleteType(), variant: "ghost", size: "sm" },
                    [icon(h, Trash2, "size-3.5", "inline-start"), "Delete type"],
                    h,
                  ),
            ],
          ),
        ],
      ),
      fieldsTableView(type, h),
      entitiesSectionView(type, model, h),
    ],
  );

const tableClass = "w-full border-collapse text-left text-[13px]";
const headCellClass = "border-b px-3 py-2 text-xs font-medium text-sand-10";
const cellClass = "border-b px-3 py-2 align-top";

const fieldsTableView = (type: EntityType, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class(cn("overflow-x-auto", cardClass))],
    [
      h.table(
        [h.Class(tableClass), h.AriaLabel(`${type.label} fields`)],
        [
          h.thead(
            [],
            [
              h.tr(
                [],
                Array.map(["Field", "Label", "Type"], (heading) =>
                  h.th([h.Scope("col"), h.Class(headCellClass)], [heading]),
                ),
              ),
            ],
          ),
          h.tbody(
            [],
            Array.map(type.fields, (field) =>
              h.keyed("tr")(
                field.name,
                [],
                [
                  h.td(
                    [h.Class(cn(cellClass, "font-mono"))],
                    [
                      field.name,
                      field.name === type.title
                        ? h.span([h.Class("ml-2 font-sans text-xs text-sand-10")], ["title"])
                        : h.empty,
                    ],
                  ),
                  h.td([h.Class(cellClass)], [field.label]),
                  h.td([h.Class(cn(cellClass, "font-mono text-sand-11"))], [fieldTypeLabel(field)]),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  );

const entitiesSectionView = (type: EntityType, model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("flex flex-col gap-3")],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-2")],
        [
          h.h3([h.Class("text-sm font-semibold")], ["Entities"]),
          button(
            {
              onClick: Message.ClickedNewEntity(),
              variant: "outline",
              size: "sm",
              isDisabled: !EntityEditor.guards.Closed(model.entityEditor),
            },
            [icon(h, Plus, "size-3.5", "inline-start"), `New ${type.label.toLowerCase()}`],
            h,
          ),
        ],
      ),
      EntityEditor.match(model.entityEditor, {
        Closed: () => h.empty,
        Creating: ({ draft }) => entityFormView(type, draft, true, model, h),
        Editing: ({ draft }) => entityFormView(type, draft, false, model, h),
      }),
      Records.match(model.records, {
        NotSelected: () => h.empty,
        Loading: () => h.p([h.Class(noteClass)], ["Loading entities…"]),
        Unavailable: ({ error }) =>
          h.p([h.Class("text-sm text-destructive")], [`Couldn't load entities: ${error}`]),
        Ready: ({ entities }) =>
          Array.match(entities, {
            onEmpty: () =>
              h.p([h.Class(noteClass)], [`No ${type.label.toLowerCase()} entities yet.`]),
            onNonEmpty: (listed) => entitiesTableView(type, listed, model, h),
          }),
      }),
    ],
  );

const cellValueView = (value: Schema.Json | undefined, h: HtmlBuilder<Message>): Html | string => {
  if (value === undefined || value === null) {
    return h.span([h.Class("text-sand-9")], ["—"]);
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
};

const entitiesTableView = (
  type: EntityType,
  entities: ReadonlyArray<EntityRecord>,
  model: Model,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [h.Class(cn("overflow-x-auto", cardClass))],
    [
      h.table(
        [h.Class(tableClass), h.AriaLabel(`${type.label} entities`)],
        [
          h.thead(
            [],
            [
              h.tr(
                [],
                [
                  h.th([h.Scope("col"), h.Class(headCellClass)], ["ID"]),
                  ...Array.map(type.fields, (field) =>
                    h.th([h.Scope("col"), h.Class(headCellClass)], [field.label]),
                  ),
                  h.th(
                    [h.Scope("col"), h.Class(headCellClass)],
                    [h.span([h.Class("sr-only")], ["Actions"])],
                  ),
                ],
              ),
            ],
          ),
          h.tbody(
            [],
            Array.map(entities, (entity) =>
              h.keyed("tr")(
                entity.id,
                [],
                [
                  h.th(
                    [h.Scope("row"), h.Class(cn(cellClass, "font-mono font-normal"))],
                    [entity.id],
                  ),
                  ...Array.map(type.fields, (field) =>
                    h.td([h.Class(cellClass)], [cellValueView(entity.data[field.name], h)]),
                  ),
                  h.td(
                    [h.Class(cn(cellClass, "w-px whitespace-nowrap"))],
                    [entityActionsView(entity, model, h)],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  );

const entityActionsView = (entity: EntityRecord, model: Model, h: HtmlBuilder<Message>) =>
  Confirmation.guards.DeleteEntity(model.confirmation) && model.confirmation.id === entity.id
    ? confirmView(`Delete ${entity.id}?`, model, h)
    : h.div(
        [h.Class("flex items-center justify-end gap-1")],
        [
          button(
            {
              onClick: Message.ClickedEditEntity({ id: entity.id }),
              variant: "ghost",
              size: "icon-xs",
              attributes: [h.AriaLabel(`Edit ${entity.id}`), h.Title("Edit")],
            },
            [icon(h, Pencil, "size-3")],
            h,
          ),
          button(
            {
              onClick: Message.ClickedDeleteEntity({ id: entity.id }),
              variant: "ghost",
              size: "icon-xs",
              attributes: [h.AriaLabel(`Delete ${entity.id}`), h.Title("Delete")],
            },
            [icon(h, Trash2, "size-3")],
            h,
          ),
        ],
      );

const formActionsView = (
  saveLabel: string,
  onCancel: Message,
  model: Model,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [h.Class("flex items-center gap-2")],
    [
      button({ type: "submit", size: "sm", isDisabled: isWorking(model) }, saveLabel, h),
      button({ onClick: onCancel, variant: "ghost", size: "sm" }, "Cancel", h),
    ],
  );

const fieldInputType: Record<Exclude<FieldType, "boolean">, string> = {
  text: "text",
  number: "number",
  date: "date",
  datetime: "datetime-local",
  ref: "text",
};

const labelledSelectView = (
  config: {
    readonly id: string;
    readonly label: string;
    readonly value: string;
    readonly options: ReadonlyArray<readonly [value: string, label: string]>;
    readonly onChange: (value: string) => Message;
  },
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [h.Class(inputWrapperClass)],
    [
      h.label([h.For(config.id), h.Class(inputLabelClass)], [config.label]),
      h.select(
        [h.Id(config.id), h.Value(config.value), h.OnChange(config.onChange), h.Class(selectClass)],
        Array.map(config.options, ([value, label]) =>
          h.option([h.Value(value), h.Selected(value === config.value)], [label]),
        ),
      ),
    ],
  );

const entityFieldView = (field: EntityField, text: string, h: HtmlBuilder<Message>) => {
  const id = `entity-field-${field.name}`;
  const onInput = (value: string) => Message.UpdatedEntityField({ field: field.name, value });
  return field.type === "boolean"
    ? labelledSelectView(
        {
          id,
          label: field.label,
          value: text,
          options: [
            ["", "Unset"],
            ["true", "Yes"],
            ["false", "No"],
          ],
          onChange: onInput,
        },
        h,
      )
    : input(
        {
          id,
          label: field.label,
          type: fieldInputType[field.type],
          value: field.type === "datetime" ? localDateTimeText(text) : text,
          onInput,
          className: "bg-background",
          ...(field.type === "ref"
            ? { description: `The ID of ${withArticle(field.to ?? "entity")}` }
            : {}),
        },
        h,
      );
};

const entityFormView = (
  type: EntityType,
  draft: EntityDraft,
  isNew: boolean,
  model: Model,
  h: HtmlBuilder<Message>,
) =>
  h.form(
    [
      h.AriaLabel(isNew ? `New ${type.label.toLowerCase()}` : `Edit ${draft.id}`),
      h.OnSubmit(Message.SubmittedEntity()),
      h.Class(cn("flex flex-col gap-4 px-4 py-4", cardClass)),
    ],
    [
      h.div(
        [h.Class("grid gap-4 sm:grid-cols-2")],
        [
          input(
            {
              id: "entity-id",
              label: "ID",
              value: draft.id,
              isReadOnly: !isNew,
              placeholder: "ada",
              onInput: (value) => Message.UpdatedEntityId({ value }),
              className: "bg-background font-mono",
              ...(isNew ? {} : { description: "IDs can't change. Delete and recreate instead." }),
            },
            h,
          ),
          ...Array.map(type.fields, (field) =>
            entityFieldView(field, draft.values[field.name] ?? "", h),
          ),
        ],
      ),
      h.p(
        [h.Class("text-xs text-muted-foreground")],
        ["Empty fields are cleared. Saving starts the saved automations that watch this type."],
      ),
      formActionsView(isNew ? "Create" : "Save", Message.ClickedCancelEntity(), model, h),
    ],
  );

const typeFormView = (draft: TypeDraft, isNew: boolean, model: Model, h: HtmlBuilder<Message>) => {
  const targets = Array.dedupe([
    ...Array.map(loadedTypes(model), (type) => type.name),
    ...(draft.name.trim() === "" ? [] : [draft.name.trim()]),
  ]);
  return h.form(
    [
      h.AriaLabel(isNew ? "New entity type" : `Edit ${draft.name}`),
      h.OnSubmit(Message.SubmittedType()),
      h.Class("flex max-w-3xl flex-col gap-6"),
    ],
    [
      h.div(
        [],
        [
          h.div([h.Class(eyebrowClass)], [isNew ? "New entity type" : "Edit entity type"]),
          h.h2(
            [h.Class("text-xl font-semibold")],
            [draft.label.trim() || draft.name.trim() || "Untitled type"],
          ),
        ],
      ),
      h.div(
        [h.Class("grid gap-4 sm:grid-cols-3")],
        [
          input(
            {
              id: "type-name",
              label: "Name",
              value: draft.name,
              isReadOnly: !isNew,
              placeholder: "employee",
              onInput: (value) => Message.UpdatedTypeName({ value }),
              className: "bg-background font-mono",
              description: isNew ? "snake_case; refs and triggers use it" : "Names can't change",
            },
            h,
          ),
          input(
            {
              id: "type-label",
              label: "Label",
              value: draft.label,
              placeholder: labelFromName(draft.name) || "Employee",
              onInput: (value) => Message.UpdatedTypeLabel({ value }),
              className: "bg-background",
            },
            h,
          ),
          labelledSelectView(
            {
              id: "type-title",
              label: "Title field",
              value: String(draft.titleKey),
              options: Array.map(draft.fields, (field) => [
                String(field.key),
                field.name.trim() || "(unnamed field)",
              ]),
              onChange: (value) => Message.SelectedTitleField({ value }),
            },
            h,
          ),
        ],
      ),
      h.fieldset(
        [h.Class(cn("flex flex-col gap-2 px-4 py-4", cardClass))],
        [
          h.legend([h.Class("sr-only")], ["Fields"]),
          h.div(
            [
              h.Class(
                "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_8rem_auto] gap-2 text-xs font-medium text-sand-10",
              ),
            ],
            [
              h.span([], ["Field"]),
              h.span([], ["Label"]),
              h.span([], ["Type"]),
              h.span([], ["Points to"]),
              h.span([h.Class("w-6")]),
            ],
          ),
          ...Array.map(draft.fields, (field) => fieldRowView(field, targets, h)),
          h.div(
            [],
            [
              button(
                { onClick: Message.ClickedAddField(), variant: "ghost", size: "xs" },
                [icon(h, Plus, "size-3", "inline-start"), "Add field"],
                h,
              ),
            ],
          ),
        ],
      ),
      formActionsView(isNew ? "Create type" : "Save type", Message.ClickedCancelType(), model, h),
    ],
  );
};

const fieldRowView = (
  field: FieldDraft,
  targets: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
) => {
  const name = field.name.trim() || "new field";
  return h.keyed("div")(
    String(field.key),
    [h.Class("grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_8rem_auto] items-center gap-2")],
    [
      h.input([
        h.AriaLabel(`Field name (${name})`),
        h.Value(field.name),
        h.Placeholder("start_date"),
        h.Spellcheck(false),
        h.OnInput((value) => Message.UpdatedFieldName({ key: field.key, value })),
        h.Class(cn(selectClass, "font-mono")),
      ]),
      h.input([
        h.AriaLabel(`Field label (${name})`),
        h.Value(field.label),
        h.Placeholder(labelFromName(field.name) || "Start date"),
        h.OnInput((value) => Message.UpdatedFieldLabel({ key: field.key, value })),
        h.Class(selectClass),
      ]),
      h.select(
        [
          h.AriaLabel(`Field type (${name})`),
          h.Value(field.type),
          h.OnChange((value) => Message.SelectedFieldType({ key: field.key, value })),
          h.Class(selectClass),
        ],
        Array.map(FieldType.literals, (type) =>
          h.option([h.Value(type), h.Selected(type === field.type)], [type]),
        ),
      ),
      field.type === "ref"
        ? h.select(
            [
              h.AriaLabel(`Points to (${name})`),
              h.Value(field.to),
              h.OnChange((value) => Message.SelectedFieldTarget({ key: field.key, value })),
              h.Class(selectClass),
            ],
            [
              h.option([h.Value(""), h.Selected(field.to === "")], ["Choose…"]),
              ...Array.map(targets, (target) =>
                h.option([h.Value(target), h.Selected(target === field.to)], [target]),
              ),
            ],
          )
        : h.span([h.Class("text-xs text-sand-9")], ["—"]),
      button(
        {
          onClick: Message.ClickedRemoveField({ key: field.key }),
          variant: "ghost",
          size: "icon-xs",
          attributes: [h.AriaLabel(`Remove field ${name}`), h.Title("Remove field")],
        },
        [icon(h, X, "size-3")],
        h,
      ),
    ],
  );
};

const statusView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [
      h.Role("status"),
      h.Class(
        cn(
          "flex min-w-0 items-center gap-2 text-xs text-muted-foreground",
          Activity.guards.Failed(model.activity) && "text-destructive",
        ),
      ),
    ],
    Activity.match(model.activity, {
      Idle: () => [],
      Ready: ({ notice }) => [notice],
      Working: ({ notice }) => [icon(h, LoaderCircle, "size-3.5 animate-spin text-signal"), notice],
      Failed: ({ error }) => [icon(h, CircleAlert, "size-3.5"), error],
    }),
  );
