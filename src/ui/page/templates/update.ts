/** Coordinates approved-template editing and deletion, validating slots and content before saving.
 * Keeps the catalogue and selected template's usage in step with request outcomes. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { FieldType, Template } from "../../../entities.ts";
import * as Change from "../../change/index.ts";
import { templatesHref, templatesPath } from "../../route.ts";
import { DeleteTemplate, NavigateToTemplates, SaveTemplate } from "./command.ts";
import { newTemplateDraft, templateDraftOf, templateFromDraft } from "./draft.ts";
import { Message, toChangeMessage } from "./message.ts";
import {
  Activity,
  Catalog,
  Confirmation,
  type ContentDraft,
  Editor,
  isWorking,
  loadedTemplates,
  type Model,
  selectedTemplate,
  type SlotDraft,
  type TemplateDraft,
  Usage,
} from "./model.ts";

export type UpdateReturn = Update.Return<Model, Message>;

const templateOrder = Order.mapInput(Order.String, (template: Template) => template.name);

const working = (model: Model, notice: string) =>
  modifyFields(model, { activity: () => Activity.Working({ notice }) });

const fail = (model: Model, error: string): UpdateReturn => ({
  model: modifyFields(model, { activity: () => Activity.Failed({ error }) }),
});

const withDraft = (
  model: Model,
  change: (draft: TemplateDraft) => TemplateDraft,
): UpdateReturn => ({
  model: modifyFields(model, {
    editor: (editor) =>
      Editor.match(editor, {
        Closed: () => editor,
        Creating: ({ draft }) => Editor.Creating({ draft: change(draft) }),
        Editing: ({ draft }) => Editor.Editing({ draft: change(draft) }),
      }),
  }),
});

const withSlot = (model: Model, key: number, change: (slot: SlotDraft) => SlotDraft) =>
  withDraft(model, (draft) =>
    modifyFields(draft, {
      slots: (slots) => Array.map(slots, (slot) => (slot.key === key ? change(slot) : slot)),
    }),
  );

const withContent = (model: Model, key: number, change: (content: ContentDraft) => ContentDraft) =>
  withDraft(model, (draft) =>
    modifyFields(draft, {
      content: (contents) =>
        Array.map(contents, (content) => (content.key === key ? change(content) : content)),
    }),
  );

const submitTemplate = (model: Model, draft: TemplateDraft, isNew: boolean): UpdateReturn => {
  if (isWorking(model)) {
    return { model };
  }
  return Result.match(templateFromDraft(draft), {
    onFailure: (error) => fail(model, error),
    onSuccess: (template) =>
      isNew && Array.some(loadedTemplates(model), (existing) => existing.name === template.name)
        ? fail(model, `There is already a template named ${template.name}`)
        : {
            model: working(model, `Preparing changes to ${template.name}…`),
            commands: [SaveTemplate({ template, isNew })],
          },
  });
};

const withTemplates = (
  model: Model,
  change: (templates: ReadonlyArray<Template>) => ReadonlyArray<Template>,
) =>
  Catalog.guards.Ready(model.catalog)
    ? Catalog.Ready({ templates: change(model.catalog.templates), types: model.catalog.types })
    : model.catalog;

export const update = (model: Model, message: Message): UpdateReturn => {
  if (
    isWorking(model) &&
    /^(Updated|Selected|Clicked(New|Edit|Cancel|Add|Remove|Delete))/.test(message._tag)
  ) {
    return { model };
  }
  if (/^Clicked(New|Edit)/.test(message._tag) && model.editor._tag !== "Closed") {
    return fail(model, "Save or cancel your open form before opening another.");
  }
  return Message.match<UpdateReturn>(message, {
    GotChangeMessage: ({ message }) =>
      message._tag === "SucceededPrepare" && !isWorking(model)
        ? { model }
        : foldChange(model, message),
    ClickedNewTemplate: () => ({
      model: modifyFields(model, {
        editor: () => Editor.Creating({ draft: newTemplateDraft }),
        confirmation: () => Confirmation.None(),
      }),
    }),
    ClickedEditTemplate: () =>
      Option.match(selectedTemplate(model), {
        onNone: () => ({ model }),
        onSome: (template) => ({
          model: modifyFields(model, {
            editor: () => Editor.Editing({ draft: templateDraftOf(template) }),
            confirmation: () => Confirmation.None(),
          }),
        }),
      }),
    ClickedCancelTemplate: () => ({
      model: modifyFields(model, { editor: () => Editor.Closed() }),
    }),
    UpdatedTemplateName: ({ value }) =>
      withDraft(model, (draft) => modifyFields(draft, { name: () => value })),
    UpdatedTemplateLabel: ({ value }) =>
      withDraft(model, (draft) => modifyFields(draft, { label: () => value })),
    UpdatedTemplateDescription: ({ value }) =>
      withDraft(model, (draft) => modifyFields(draft, { description: () => value })),
    ClickedAddSlot: () =>
      withDraft(model, (draft) =>
        modifyFields(draft, {
          slots: (slots) =>
            Array.append(slots, {
              key: draft.nextKey,
              name: "",
              label: "",
              type: "ref",
              to: "",
            }),
          nextKey: (key) => key + 1,
        }),
      ),
    ClickedRemoveSlot: ({ key }) =>
      withDraft(model, (draft) =>
        modifyFields(draft, {
          slots: (slots) => Array.filter(slots, (slot) => slot.key !== key),
        }),
      ),
    UpdatedSlotName: ({ key, value }) =>
      withSlot(model, key, (slot) => modifyFields(slot, { name: () => value })),
    UpdatedSlotLabel: ({ key, value }) =>
      withSlot(model, key, (slot) => modifyFields(slot, { label: () => value })),
    SelectedSlotType: ({ key, value }) =>
      Option.match(Schema.decodeUnknownOption(FieldType)(value), {
        onNone: () => ({ model }),
        onSome: (type) => withSlot(model, key, (slot) => modifyFields(slot, { type: () => type })),
      }),
    SelectedSlotTarget: ({ key, value }) =>
      withSlot(model, key, (slot) => modifyFields(slot, { to: () => value })),
    ClickedAddContent: () =>
      withDraft(model, (draft) =>
        modifyFields(draft, {
          content: (contents) =>
            Array.append(contents, { key: draft.nextKey, input: "", text: "" }),
          nextKey: (key) => key + 1,
        }),
      ),
    ClickedRemoveContent: ({ key }) =>
      withDraft(model, (draft) =>
        modifyFields(draft, {
          content: (contents) => Array.filter(contents, (content) => content.key !== key),
        }),
      ),
    UpdatedContentInput: ({ key, value }) =>
      withContent(model, key, (content) => modifyFields(content, { input: () => value })),
    UpdatedContentText: ({ key, value }) =>
      withContent(model, key, (content) => modifyFields(content, { text: () => value })),
    SubmittedTemplate: () =>
      Editor.match(model.editor, {
        Closed: () => ({ model }),
        Creating: ({ draft }) => submitTemplate(model, draft, true),
        Editing: ({ draft }) => submitTemplate(model, draft, false),
      }),
    ClickedDeleteTemplate: () =>
      Option.match(selectedTemplate(model), {
        onNone: () => ({ model }),
        onSome: (template) => ({
          model: working(model, "Preparing change…"),
          commands: [DeleteTemplate({ name: template.name })],
        }),
      }),
    ClickedConfirmDelete: () => {
      if (isWorking(model)) {
        return { model };
      }
      return Confirmation.match<UpdateReturn>(model.confirmation, {
        None: () => ({ model }),
        Delete: ({ name }) => ({
          model: modifyFields(working(model, `Deleting ${name}…`), {
            confirmation: () => Confirmation.None(),
          }),
          commands: [DeleteTemplate({ name })],
        }),
      });
    },
    ClickedCancelDelete: () => ({
      model: modifyFields(model, { confirmation: () => Confirmation.None() }),
    }),
    SucceededLoadCatalog: ({ templates, types }) => ({
      model: modifyFields(model, {
        catalog: () => Catalog.Ready({ templates: Array.sort(templates, templateOrder), types }),
      }),
    }),
    FailedLoadCatalog: ({ error }) => ({
      model: modifyFields(model, { catalog: () => Catalog.Unavailable({ error }) }),
    }),
    SucceededLoadUsage: ({ name, usage }) =>
      Option.contains(model.maybeTemplateName, name)
        ? { model: modifyFields(model, { usage: () => Usage.Ready({ name, usage }) }) }
        : { model },
    FailedLoadUsage: ({ name, error }) =>
      Option.contains(model.maybeTemplateName, name)
        ? { model: modifyFields(model, { usage: () => Usage.Unavailable({ name, error }) }) }
        : { model },
    SucceededSaveTemplate: ({ template, isNew }) => ({
      model: modifyFields(model, {
        catalog: () =>
          withTemplates(model, (templates) =>
            Array.sort(
              Array.append(
                Array.filter(templates, (existing) => existing.name !== template.name),
                template,
              ),
              templateOrder,
            ),
          ),
        editor: () => Editor.Closed(),
        activity: () => Activity.Ready({ notice: `Saved ${template.name}` }),
      }),
      ...(isNew
        ? {
            commands: [NavigateToTemplates({ url: templatesHref(Option.some(template.name)) })],
          }
        : {}),
    }),
    SucceededDeleteTemplate: ({ name }) => ({
      model: modifyFields(model, {
        catalog: () =>
          withTemplates(model, (templates) =>
            Array.filter(templates, (existing) => existing.name !== name),
          ),
        activity: () => Activity.Ready({ notice: `Deleted ${name}` }),
      }),
      commands: [NavigateToTemplates({ url: templatesPath })],
    }),
    FailedRequest: ({ error }) => fail(model, error),
    CompletedNavigateToTemplates: () => ({ model }),
  });
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
        Cancelled: () => ({ model: modifyFields(model, { activity: () => Activity.Idle() }) }),
        Applied: ({ proposal, result }) => {
          const action = proposal.action;
          if (action.kind === "putTemplate") {
            return Option.match(Schema.decodeUnknownOption(Template)(result), {
              onNone: () =>
                fail(
                  model,
                  "The applied change returned an invalid result. Your draft has been kept.",
                ),
              onSome: (template) =>
                update(
                  model,
                  Message.SucceededSaveTemplate({
                    template,
                    isNew: Editor.guards.Creating(model.editor),
                  }),
                ),
            });
          }
          if (action.kind === "deleteTemplate") {
            return Option.match(
              Schema.decodeUnknownOption(Schema.Struct({ deleted: Schema.String }))(result),
              {
                onNone: () => fail(model, "The applied change returned an invalid result."),
                onSome: () => update(model, Message.SucceededDeleteTemplate({ name: action.name })),
              },
            );
          }
          return fail(model, "This change belongs to another page.");
        },
      }),
});
