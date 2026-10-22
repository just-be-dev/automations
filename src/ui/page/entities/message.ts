/** Describes entity-store editing, deletion confirmations, and the outcomes of loading and saving records. */
import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { EntityRecord, EntityType, Subject } from "../../../entities.ts";
import * as Change from "../../change/index.ts";

export const Message = defineMessageUnion({
  GotChangeMessage: { message: Change.Message },
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
  SucceededSaveEntity: { entity: Subject },
  SucceededDeleteEntity: { type: Schema.String, id: Schema.String },
  FailedRequest: { error: Schema.String },
  CompletedNavigateToEntities: {},
});
export type Message = typeof Message.Type;

export const toChangeMessage = (message: Change.Message) => Message.GotChangeMessage({ message });
