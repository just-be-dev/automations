/** Coordinates entity-store editing and confirmed deletion, validating drafts before they're proposed.
 * Ignores record loads for types that are no longer selected. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { snakeCaseId, withArticle } from "@/lib/format";
import { EntityType, FieldType, Subject } from "../../../entities.ts";
import * as Change from "../../change/index.ts";
import type { ChangeProposal } from "../../../changes/model.ts";
import { entitiesHref, entitiesPath } from "../../route.ts";
import { DeleteEntity, DeleteType, NavigateToEntities, SaveEntity, SaveType } from "./command.ts";
import {
  entityDataFromDraft,
  entityDraftOf,
  newTypeDraft,
  typeDraftOf,
  typeFromDraft,
} from "./draft.ts";
import { loadRecords } from "./init.ts";
import { Message, toChangeMessage } from "./message.ts";
import {
  Activity,
  Confirmation,
  type EntityDraft,
  EntityEditor,
  type FieldDraft,
  isWorking,
  loadedTypes,
  type Model,
  Records,
  selectedType,
  type TypeDraft,
  TypeEditor,
  Types,
} from "./model.ts";

export type UpdateReturn = Update.Return<Model, Message>;

const typeOrder = Order.mapInput(Order.String, (type: EntityType) => type.name);

const working = (model: Model, notice: string) =>
  modifyFields(model, { activity: () => Activity.Working({ notice }) });

const fail = (model: Model, error: string): UpdateReturn => ({
  model: modifyFields(model, { activity: () => Activity.Failed({ error }) }),
});

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

const validEntityId = /^[a-zA-Z0-9_.@-]{1,128}$/;

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
            model: working(model, `Preparing changes to ${type.name}…`),
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
        return fail(model, "IDs use letters, numbers, _ . @ and - (up to 128 characters)");
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
          model: working(model, `Preparing changes to ${id}…`),
          commands: [SaveEntity({ type: type.name, id, data })],
        }),
      });
    },
  });
};

export const update = (model: Model, message: Message): UpdateReturn => {
  if (
    isWorking(model) &&
    /^(Updated|Selected|Clicked(New|Edit|Cancel|Add|Remove|Delete))/.test(message._tag)
  ) {
    return { model };
  }
  if (
    /^Clicked(New|Edit)/.test(message._tag) &&
    (model.typeEditor._tag !== "Closed" || model.entityEditor._tag !== "Closed")
  ) {
    return fail(model, "Save or cancel your open form before opening another.");
  }
  return Message.match<UpdateReturn>(message, {
    GotChangeMessage: ({ message }) =>
      message._tag === "SucceededPrepare" && !isWorking(model)
        ? { model }
        : foldChange(model, message),
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
      TypeEditor.guards.Creating(model.typeEditor)
        ? withTypeDraft(model, (draft) => modifyFields(draft, { name: () => snakeCaseId(value) }))
        : { model },
    UpdatedTypeLabel: ({ value }) =>
      withTypeDraft(model, (draft) =>
        modifyFields(draft, {
          label: () => value,
          name: (name) =>
            TypeEditor.guards.Creating(model.typeEditor)
              ? snakeCaseId(value).replace(/_$/, "")
              : name,
        }),
      ),
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
          model: working(model, "Preparing change…"),
          commands: [DeleteType({ type: type.name })],
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
          model: working(model, "Preparing change…"),
          commands: [DeleteEntity({ type, id })],
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
        ? {
            model: modifyFields(model, { records: () => Records.Unavailable({ type, error }) }),
          }
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
    SucceededSaveEntity: ({ entity }) => ({
      model: modifyFields(model, {
        entityEditor: () => EntityEditor.Closed(),
        activity: () => Activity.Ready({ notice: `Saved ${entity.id}` }),
      }),
      commands: loadRecords(model.maybeTypeName),
    }),
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
};

const decodeApplied = <T, E>(
  model: Model,
  schema: Schema.Codec<T, E>,
  result: Schema.Json,
  message: (value: T) => Message,
): UpdateReturn =>
  Option.match(Schema.decodeUnknownOption(schema)(result), {
    onNone: () =>
      fail(model, "The applied change returned an invalid result. Your draft has been kept."),
    onSome: (value) => update(model, message(value)),
  });

const applied = (model: Model, proposal: ChangeProposal, result: Schema.Json): UpdateReturn => {
  const action = proposal.action;
  if (action.kind === "putType") {
    return decodeApplied(model, EntityType, result, (type) =>
      Message.SucceededSaveType({ type, isNew: TypeEditor.guards.Creating(model.typeEditor) }),
    );
  }
  if (action.kind === "putEntity") {
    return decodeApplied(
      model,
      Schema.Struct({ entity: Subject }),
      result,
      Message.SucceededSaveEntity,
    );
  }
  if (action.kind === "deleteType") {
    return decodeApplied(model, Schema.Struct({ deleted: Schema.String }), result, () =>
      Message.SucceededDeleteType({ type: action.name }),
    );
  }
  if (action.kind === "deleteEntity") {
    return decodeApplied(model, Schema.Struct({ deleted: Subject }), result, () =>
      Message.SucceededDeleteEntity({ type: action.type, id: action.id }),
    );
  }
  return fail(model, "This change belongs to another page.");
};

const foldChange = Update.foldChild({
  update: Change.update,
  read: (model: Model) => Option.some(model.change),
  write: (model: Model, nextChange: Change.Model) =>
    modifyFields(model, { change: () => nextChange }),
  toParentMessage: toChangeMessage,
  foldOutMessage:
    (outMessage: Change.OutMessage) =>
    (model: Model): UpdateReturn =>
      Change.OutMessage.match(outMessage, {
        Applied: ({ proposal, result }) => applied(model, proposal, result),
        Cancelled: () => ({ model: modifyFields(model, { activity: () => Activity.Idle() }) }),
      }),
});
