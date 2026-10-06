/** Describes template wording and slot edits, deletion confirmations, and catalogue and usage request outcomes. */
import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { EntityType, Template } from "../../../entities.ts";
import { TemplateUsage } from "../../../workflow.ts";
import * as Change from "../../change/index.ts";

export const Message = defineMessageUnion({
  GotChangeMessage: { message: Change.Message },
  ClickedNewTemplate: {},
  ClickedEditTemplate: {},
  ClickedCancelTemplate: {},
  UpdatedTemplateName: { value: Schema.String },
  UpdatedTemplateLabel: { value: Schema.String },
  UpdatedTemplateDescription: { value: Schema.String },
  ClickedAddSlot: {},
  ClickedRemoveSlot: { key: Schema.Int },
  UpdatedSlotName: { key: Schema.Int, value: Schema.String },
  UpdatedSlotLabel: { key: Schema.Int, value: Schema.String },
  SelectedSlotType: { key: Schema.Int, value: Schema.String },
  SelectedSlotTarget: { key: Schema.Int, value: Schema.String },
  ClickedAddContent: {},
  ClickedRemoveContent: { key: Schema.Int },
  UpdatedContentInput: { key: Schema.Int, value: Schema.String },
  UpdatedContentText: { key: Schema.Int, value: Schema.String },
  SubmittedTemplate: {},
  ClickedDeleteTemplate: {},
  ClickedConfirmDelete: {},
  ClickedCancelDelete: {},
  SucceededLoadCatalog: { templates: Schema.Array(Template), types: Schema.Array(EntityType) },
  FailedLoadCatalog: { error: Schema.String },
  SucceededLoadUsage: { name: Schema.String, usage: TemplateUsage },
  FailedLoadUsage: { name: Schema.String, error: Schema.String },
  SucceededSaveTemplate: { template: Template, isNew: Schema.Boolean },
  SucceededDeleteTemplate: { name: Schema.String },
  FailedRequest: { error: Schema.String },
  CompletedNavigateToTemplates: {},
});
export type Message = typeof Message.Type;

export const toChangeMessage = (message: Change.Message) => Message.GotChangeMessage({ message });
