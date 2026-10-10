/** Presents approved wording, slots, and the automations using each template, with editing and deletion warnings. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import { Submodel } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { CircleAlert, FileText, LoaderCircle, Pencil, Plus, Trash2 } from "lucide";
import { fieldInputHeadingView, fieldInputView } from "@/components/field-input";
import { button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { input } from "@/components/ui/input";
import { inputGroup, inputGroupControlClass } from "@/components/ui/input-group";
import { textarea, textareaClass } from "@/components/ui/textarea";
import { componentName } from "@/lib/component";
import { plural } from "@/lib/format";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { type EntityField, type Template } from "../../../entities.ts";
import { templateParts, type TemplateUser, type TemplateUsage } from "../../../workflow.ts";
import { automationHref, templatesHref } from "../../route.ts";
import { textInputs } from "./draft.ts";
import { Message, toChangeMessage } from "./message.ts";
import * as Change from "../../change/index.ts";
import {
  Activity,
  Catalog,
  type ContentDraft,
  Editor,
  isWorking,
  loadedTypes,
  type Model,
  selectedTemplate,
  type SlotDraft,
  type TemplateDraft,
  Usage,
} from "./model.ts";

const noteClass = "text-sm text-muted-foreground";
const chipClass = "rounded-[4px] bg-chip px-1.5 py-0.5 font-mono text-[0.92em] text-sand-11";
const cardClass = "rounded-[10px] bg-card shadow-card";
const tableClass = "w-full border-collapse text-left text-[13px]";
const headCellClass = "border-b px-3 py-2 text-xs font-medium text-sand-10";
const cellClass = "border-b px-3 py-2 align-top";
const textInputsListId = "template-text-inputs";

const slotTypeLabel = (slot: EntityField) =>
  slot.type === "ref" ? `ref → ${slot.to ?? "?"}` : slot.type;

export const headerView = Submodel.defineView<Model, Message>((_model, h) =>
  h.div(
    [componentName("templates-header"), h.Class("flex min-w-0 items-center gap-2")],
    [
      h.div([h.Class("truncate text-sm font-medium tracking-tight")], ["Templates"]),
      button(
        {
          onClick: Message.ClickedNewTemplate(),
          variant: "ghost",
          size: "icon-xs",
          className: "text-sand-10",
          attributes: [h.AriaLabel("New template"), h.Title("New template")],
        },
        [icon(h, Plus, "size-3.5")],
        h,
      ),
    ],
  ),
);

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [componentName("templates"), h.Class("flex flex-1 flex-col lg:min-h-0")],
    [
      h.div(
        [h.Class("grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[15rem_minmax(0,1fr)]")],
        [templateListView(model, h), detailView(model, h)],
      ),
      h.div(
        [h.Class("flex min-h-12 items-center gap-4 border-t px-6 py-3")],
        [statusView(model, h)],
      ),
      h.submodel({
        slotId: "change",
        model: model.change,
        view: Change.view,
        toParentMessage: toChangeMessage,
      }),
    ],
  ),
);

const templateListView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [
      componentName("template-list"),
      h.AriaLabel("Templates"),
      h.Class(
        "flex flex-col border-b px-3 py-4 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0",
      ),
    ],
    [
      Catalog.match(model.catalog, {
        Loading: () => h.p([h.Class(cn(noteClass, "px-1.5 text-xs"))], ["Loading…"]),
        Unavailable: ({ error }) =>
          h.p([h.Class("px-1.5 text-xs text-destructive")], [`Couldn't load templates: ${error}`]),
        Ready: ({ templates }) =>
          Array.match(templates, {
            onEmpty: () => h.p([h.Class(cn(noteClass, "px-1.5 text-xs"))], ["No templates yet."]),
            onNonEmpty: (listed) =>
              h.ul(
                [h.Class("flex flex-col")],
                Array.map(listed, (template) =>
                  templateLinkView(
                    template,
                    Option.contains(model.maybeTemplateName, template.name),
                    h,
                  ),
                ),
              ),
          }),
      }),
    ],
  );

const templateLinkView = (template: Template, isCurrent: boolean, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    template.name,
    [componentName("template-link")],
    [
      h.a(
        [
          h.Href(templatesHref(Option.some(template.name))),
          ...(isCurrent ? [h.AriaCurrent("page")] : []),
          h.Class(
            cn(
              "my-px flex flex-col gap-0.5 rounded-[8px] px-2 py-1.5 text-muted-foreground transition-colors duration-100 outline-none hover:bg-hover hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
              isCurrent && "bg-hover text-foreground",
            ),
          ),
        ],
        [
          h.span([h.Class("truncate text-[13px] font-medium tracking-tight")], [template.label]),
          h.span([h.Class("truncate font-mono text-[11px] text-sand-10")], [template.name]),
        ],
      ),
    ],
  );

const detailView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [
      componentName("detail"),
      h.AriaLabel("Template"),
      h.Class("flex flex-col gap-8 px-6 py-5 lg:min-h-0 lg:overflow-y-auto"),
    ],
    [
      Editor.match(model.editor, {
        Creating: ({ draft }) => templateFormView(draft, true, model, h),
        Editing: ({ draft }) => templateFormView(draft, false, model, h),
        Closed: () =>
          Option.match(selectedTemplate(model), {
            onNone: () => noTemplateView(model, h),
            onSome: (template) => templateDetailView(template, model, h),
          }),
      }),
    ],
  );

const noTemplateView = (model: Model, h: HtmlBuilder<Message>) => {
  const maybeMissing = Option.filter(model.maybeTemplateName, () =>
    Catalog.guards.Ready(model.catalog),
  );
  return h.div(
    [componentName("no-template"), h.Class("flex max-w-xl flex-col gap-6")],
    [
      Empty(
        { className: cardClass },
        [
          Empty.header(
            {},
            [
              Empty.media({ className: "icon-tile" }, [icon(h, FileText, "size-3.5")], h),
              Empty.title(
                {},
                [
                  Option.match(maybeMissing, {
                    onNone: () => "Templates",
                    onSome: (name) => `No template named ${name}`,
                  }),
                ],
                h,
              ),
              Empty.description(
                {},
                [
                  "Templates are approved wording, such as the standard welcome email. Automations fill their slots from what a run knows, and the planner uses a template whenever one fits instead of writing the text itself.",
                ],
                h,
              ),
            ],
            h,
          ),
          button(
            { onClick: Message.ClickedNewTemplate(), size: "sm" },
            [icon(h, Plus, "size-3.5", "inline-start"), "New template"],
            h,
          ),
        ],
        h,
      ),
      Option.isSome(maybeMissing) ? usageSectionView(model, h) : h.empty,
    ],
  );
};

const templateDetailView = (template: Template, model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("template-detail"), h.Class("flex max-w-3xl flex-col gap-8")],
    [
      h.div(
        [h.Class("flex flex-wrap items-start justify-between gap-4")],
        [
          h.div(
            [h.Class("flex min-w-0 flex-col gap-1")],
            [
              h.h2(
                [h.Class("flex items-center gap-2 text-xl font-semibold")],
                [
                  template.label,
                  h.span([h.Class(cn(chipClass, "text-xs font-normal"))], [template.name]),
                ],
              ),
              h.p([h.Class(noteClass)], [template.description]),
            ],
          ),
          h.div(
            [h.Class("flex items-center gap-2")],
            [
              button(
                { onClick: Message.ClickedEditTemplate(), variant: "outline", size: "sm" },
                [icon(h, Pencil, "size-3.5", "inline-start"), "Edit template"],
                h,
              ),
              button(
                { onClick: Message.ClickedDeleteTemplate(), variant: "ghost", size: "sm" },
                [icon(h, Trash2, "size-3.5", "inline-start"), "Delete"],
                h,
              ),
            ],
          ),
        ],
      ),
      usageSectionView(model, h),
      slotsSectionView(template, h),
      contentSectionView(template, h),
    ],
  );

const sectionHeadingView = (heading: string, h: HtmlBuilder<Message>) =>
  h.h3([h.Class("text-sm font-semibold")], [heading]);

const usageSectionView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [componentName("usage-section"), h.AriaLabel("Used by"), h.Class("flex flex-col gap-3")],
    [
      sectionHeadingView("Used by", h),
      Usage.match(model.usage, {
        NotSelected: () => h.empty,
        Loading: () => h.p([h.Class(noteClass)], ["Checking automations…"]),
        Unavailable: ({ error }) =>
          h.p([h.Class("text-sm text-destructive")], [`Couldn't check automations: ${error}`]),
        Ready: ({ usage }) => usageView(usage, h),
      }),
    ],
  );

const usageView = (usage: TemplateUsage, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("usage"), h.Class("flex flex-col gap-2")],
    [
      Array.match(usage.automations, {
        onEmpty: () => h.p([h.Class(noteClass)], ["No automation uses this template."]),
        onNonEmpty: (users) =>
          h.ul(
            [h.Class(cn("flex flex-col divide-y", cardClass))],
            Array.map(users, (user) => templateUserView(user, h)),
          ),
      }),
      ...Array.map(usage.unchecked, (automation) =>
        h.p(
          [h.Class("text-xs text-destructive")],
          [`Couldn't check ${automation.name}: ${automation.error}`],
        ),
      ),
    ],
  );

const usePlace = (user: TemplateUser) => {
  if (user.saved && user.draft) {
    return "Saved and draft";
  }
  return user.saved ? "Saved" : "Draft only";
};

const templateUserView = (user: TemplateUser, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    user.id,
    [componentName("template-user"), h.Class("group/template-user")],
    [
      h.a(
        [
          h.Href(automationHref(user.id)),
          h.Class(
            "flex items-center justify-between gap-3 px-3 py-2 text-[13px] transition-colors duration-100 outline-none group-first/template-user:rounded-t-[10px] group-last/template-user:rounded-b-[10px] hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50",
          ),
        ],
        [
          h.span([h.Class("truncate font-medium tracking-tight")], [user.name]),
          h.span(
            [
              h.Class("shrink-0 text-xs text-sand-10"),
              h.Title(
                user.saved
                  ? "Runs that start now use this template"
                  : "Only the unsaved draft uses this template",
              ),
            ],
            [usePlace(user)],
          ),
        ],
      ),
    ],
  );

const slotsSectionView = (template: Template, h: HtmlBuilder<Message>) =>
  h.section(
    [componentName("slots-section"), h.AriaLabel("Slots"), h.Class("flex flex-col gap-3")],
    [
      sectionHeadingView("Slots", h),
      Array.match(template.slots, {
        onEmpty: () =>
          h.p([h.Class(noteClass)], ["No slots: the wording is the same for every run."]),
        onNonEmpty: (slots) => slotsTableView(template, slots, h),
      }),
    ],
  );

const slotsTableView = (
  template: Template,
  slots: ReadonlyArray<EntityField>,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [componentName("slots-table"), h.Class(cn("overflow-x-auto", cardClass))],
    [
      h.table(
        [h.Class(tableClass), h.AriaLabel(`${template.label} slots`)],
        [
          h.thead(
            [],
            [
              h.tr(
                [],
                Array.map(["Slot", "Label", "Type"], (heading) =>
                  h.th([h.Scope("col"), h.Class(headCellClass)], [heading]),
                ),
              ),
            ],
          ),
          h.tbody(
            [],
            Array.map(slots, (slot) =>
              h.keyed("tr")(
                slot.name,
                [],
                [
                  h.td([h.Class(cn(cellClass, "font-mono"))], [slot.name]),
                  h.td([h.Class(cellClass)], [slot.label]),
                  h.td([h.Class(cn(cellClass, "font-mono text-sand-11"))], [slotTypeLabel(slot)]),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  );

const contentTextView = (text: string, h: HtmlBuilder<Message>) =>
  h.p(
    [componentName("content-text"), h.Class("text-sm break-words whitespace-pre-wrap")],
    Array.map(templateParts(text), (part) =>
      part.kind === "text"
        ? part.text
        : h.span([h.Class(cn(chipClass, "text-foreground"))], [part.ref]),
    ),
  );

const contentSectionView = (template: Template, h: HtmlBuilder<Message>) =>
  h.section(
    [componentName("content-section"), h.AriaLabel("Content"), h.Class("flex flex-col gap-3")],
    [
      sectionHeadingView("Content", h),
      h.dl(
        [h.Class(cn("flex flex-col divide-y", cardClass))],
        Array.map(Object.entries(template.content), ([inputName, text]) =>
          h.keyed("div")(
            inputName,
            [h.Class("flex flex-col gap-1.5 px-4 py-3")],
            [
              h.dt([h.Class("font-mono text-xs text-sand-10")], [inputName]),
              h.dd([], [contentTextView(text, h)]),
            ],
          ),
        ),
      ),
    ],
  );

const formActionsView = (saveLabel: string, model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("form-actions"), h.Class("flex items-center gap-2")],
    [
      button({ type: "submit", size: "sm", isDisabled: isWorking(model) }, saveLabel, h),
      button(
        { onClick: Message.ClickedCancelTemplate(), variant: "ghost", size: "sm" },
        "Cancel",
        h,
      ),
    ],
  );

const editingNoteView = (model: Model, h: HtmlBuilder<Message>) => {
  const users = Usage.guards.Ready(model.usage) ? model.usage.usage.automations.length : 0;
  return users === 0
    ? h.empty
    : h.p(
        [componentName("editing-note"), h.Class("text-xs text-muted-foreground")],
        [`${plural(users, "automation uses", "automations use")} this template.`],
      );
};

const templateFormView = (
  draft: TemplateDraft,
  isNew: boolean,
  model: Model,
  h: HtmlBuilder<Message>,
) => {
  const targets = Array.map(loadedTypes(model), (type) => type.name);
  return h.form(
    [
      componentName("template-form"),
      h.AriaLabel(isNew ? "New template" : `Edit ${draft.name}`),
      h.OnSubmit(Message.SubmittedTemplate()),
      h.Class("flex max-w-3xl flex-col gap-6"),
    ],
    [
      h.h2([h.Class("text-xl font-semibold")], [isNew ? "Create template" : "Edit template"]),
      h.div(
        [h.Class("grid gap-4 sm:grid-cols-2")],
        [
          input(
            {
              id: "template-name",
              label: "Name",
              value: draft.label,
              placeholder: "Welcome email",
              onInput: (value) => Message.UpdatedTemplateLabel({ value }),
            },
            h,
          ),
          input(
            {
              id: "template-id",
              label: "ID",
              value: draft.name,
              isReadOnly: !isNew,
              placeholder: "welcome_email",
              onInput: (value) => Message.UpdatedTemplateName({ value }),
              className: "font-mono",
              ...(isNew ? {} : { description: "IDs can't change" }),
            },
            h,
          ),
        ],
      ),
      textarea(
        {
          id: "template-description",
          label: "Description",
          value: draft.description,
          rows: 2,
          placeholder: "The standard welcome email for every new hire. Send it before they start.",
          description:
            "Who and what it's for. The planner reads it to decide when the template fits.",
          onInput: (value) => Message.UpdatedTemplateDescription({ value }),
        },
        h,
      ),
      slotsFieldsetView(draft, targets, h),
      contentFieldsetView(draft, h),
      editingNoteView(model, h),
      formActionsView(isNew ? "Create template" : "Save template", model, h),
    ],
  );
};

const slotsFieldsetView = (
  draft: TemplateDraft,
  targets: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
) =>
  h.fieldset(
    [
      componentName("slots-fieldset"),
      h.Class(cn("@container/fields flex flex-col gap-2 px-4 py-4", cardClass)),
    ],
    [
      h.legend([h.Class("float-left mb-1 text-sm font-semibold")], ["Slots"]),
      h.p(
        [h.Class("clear-left text-xs text-muted-foreground")],
        [
          "What the automation fills in. A ref slot takes an entity, such as the new hire; any other slot takes text.",
        ],
      ),
      Array.match(draft.slots, {
        onEmpty: () => h.empty,
        onNonEmpty: (slots) =>
          h.div(
            [h.Class("flex flex-col gap-2")],
            [
              fieldInputHeadingView("Slot", h),
              ...Array.map(slots, (slot) => slotRowView(slot, targets, h)),
            ],
          ),
      }),
      h.div(
        [],
        [
          button(
            { onClick: Message.ClickedAddSlot(), variant: "ghost", size: "xs" },
            [icon(h, Plus, "size-3", "inline-start"), "Add slot"],
            h,
          ),
        ],
      ),
    ],
  );

const slotRowView = (slot: SlotDraft, targets: ReadonlyArray<string>, h: HtmlBuilder<Message>) =>
  h.keyed("div")(
    String(slot.key),
    [componentName("slot-row")],
    [
      fieldInputView(
        slot,
        targets,
        {
          kind: "Slot",
          onName: (value) => Message.UpdatedSlotName({ key: slot.key, value }),
          onLabel: (value) => Message.UpdatedSlotLabel({ key: slot.key, value }),
          onType: (value) => Message.SelectedSlotType({ key: slot.key, value }),
          onTarget: (value) => Message.SelectedSlotTarget({ key: slot.key, value }),
          onRemove: Message.ClickedRemoveSlot({ key: slot.key }),
        },
        h,
      ),
    ],
  );

const contentFieldsetView = (draft: TemplateDraft, h: HtmlBuilder<Message>) =>
  h.fieldset(
    [componentName("content-fieldset"), h.Class(cn("flex flex-col gap-3 px-4 py-4", cardClass))],
    [
      h.legend([h.Class("float-left mb-1 text-sm font-semibold")], ["Content"]),
      h.p(
        [h.Class("clear-left text-xs text-muted-foreground")],
        [
          "The text for each action input the template fills, such as ",
          h.span([h.Class(chipClass)], ["subject"]),
          " and ",
          h.span([h.Class(chipClass)], ["body"]),
          ". Read a slot with ",
          h.span([h.Class(chipClass)], ["{{hire.name}}"]),
          ".",
        ],
      ),
      h.datalist(
        [h.Id(textInputsListId)],
        Array.map(textInputs, (name) => h.option([h.Value(name)])),
      ),
      ...Array.map(draft.content, (content) => contentRowView(content, h)),
      h.div(
        [],
        [
          button(
            { onClick: Message.ClickedAddContent(), variant: "ghost", size: "xs" },
            [icon(h, Plus, "size-3", "inline-start"), "Add input"],
            h,
          ),
        ],
      ),
    ],
  );

const contentRowView = (content: ContentDraft, h: HtmlBuilder<Message>) => {
  const name = content.input.trim() || "new input";
  return h.keyed("div")(
    String(content.key),
    [componentName("content-row"), h.Class("flex flex-col gap-1.5")],
    [
      inputGroup(
        {
          label: `${name} input`,
          removeLabel: `Remove input ${name}`,
          onRemove: Message.ClickedRemoveContent({ key: content.key }),
          className: "w-56 max-w-full",
        },
        [
          h.input([
            h.AriaLabel(`Input name (${name})`),
            h.Value(content.input),
            h.Placeholder("body"),
            h.List(textInputsListId),
            h.Spellcheck(false),
            h.OnInput((value) => Message.UpdatedContentInput({ key: content.key, value })),
            h.Class(cn(inputGroupControlClass, "flex-1 font-mono")),
          ]),
        ],
        h,
      ),
      h.textarea([
        h.AriaLabel(`Text (${name})`),
        h.Value(content.text),
        h.Rows(4),
        h.OnInput((value) => Message.UpdatedContentText({ key: content.key, value })),
        h.Class(cn(textareaClass, "min-h-24 md:text-[13px]")),
      ]),
    ],
  );
};

const statusView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [
      componentName("status"),
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
