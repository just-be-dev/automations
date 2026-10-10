/** Presents the entity store's type definitions and records with forms for editing both and confirming deletion. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { CircleAlert, Database, LoaderCircle, Pencil, Plus, Trash2 } from "lucide";
import { fieldInputHeadingView, fieldInputView } from "@/components/field-input";
import { button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { input, inputLabelClass, inputWrapperClass } from "@/components/ui/input";
import { select } from "@/components/ui/select";
import { componentName } from "@/lib/component";
import { localDateTimeText } from "@/lib/datetime";
import { plural, withArticle } from "@/lib/format";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import {
  type EntityField,
  type EntityRecord,
  type EntityType,
  type FieldType,
} from "../../../entities.ts";
import { entitiesHref } from "../../route.ts";
import { Message, toChangeMessage } from "./message.ts";
import * as Change from "../../change/index.ts";
import {
  Activity,
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

const noteClass = "text-sm text-muted-foreground";
const chipClass = "rounded-[4px] bg-chip px-1.5 py-0.5 font-mono text-[0.92em] text-sand-11";
const cardClass = "rounded-[10px] bg-card shadow-card";

const fieldTypeLabel = (field: EntityField) =>
  field.type === "ref" ? `ref → ${field.to ?? "?"}` : field.type;

export const headerView = Submodel.defineView<Model, Message>((_model, h) =>
  h.div(
    [componentName("entities-header"), h.Class("flex min-w-0 items-center gap-2")],
    [
      h.div([h.Class("truncate text-sm font-medium tracking-tight")], ["Entity store"]),
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
);

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [componentName("entities"), h.Class("flex flex-1 flex-col lg:min-h-0")],
    [
      h.div(
        [h.Class("grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[15rem_minmax(0,1fr)]")],
        [typeListView(model, h), detailView(model, h)],
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

const typeListView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [
      componentName("type-list"),
      h.AriaLabel("Entity types"),
      h.Class(
        "flex flex-col border-b px-3 py-4 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0",
      ),
    ],
    [
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
    [componentName("type-link")],
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
      componentName("detail"),
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
    { className: cn("max-w-xl", cardClass), attributes: [componentName("no-type")] },
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

const typeDetailView = (type: EntityType, model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("type-detail"), h.Class("flex flex-col gap-8")],
    [
      h.div(
        [h.Class("flex flex-wrap items-start justify-between gap-4")],
        [
          h.div(
            [h.Class("min-w-0")],
            [
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
              button(
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
    [componentName("fields-table"), h.Class(cn("overflow-x-auto", cardClass))],
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
    [componentName("entities-section"), h.Class("flex flex-col gap-3")],
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
    return h.span([componentName("cell-value"), h.Class("text-sand-9")], ["—"]);
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
    [componentName("entities-table"), h.Class(cn("overflow-x-auto", cardClass))],
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
  h.div(
    [componentName("entity-actions"), h.Class("flex items-center justify-end gap-1")],
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
          isDisabled: isWorking(model),
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
    [componentName("form-actions"), h.Class("flex items-center gap-2")],
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
    [componentName("labelled-select"), h.Class(inputWrapperClass)],
    [
      h.label([h.For(config.id), h.Class(inputLabelClass)], [config.label]),
      select(
        {
          className: "md:text-[13px]",
          attributes: [h.Id(config.id), h.Value(config.value), h.OnChange(config.onChange)],
        },
        Array.map(config.options, ([value, label]) =>
          h.option([h.Value(value), h.Selected(value === config.value)], [label]),
        ),
        h,
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
          wrapperAttributes: [componentName("entity-field")],
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
      componentName("entity-form"),
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
              className: "font-mono",
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
      componentName("type-form"),
      h.AriaLabel(isNew ? "New entity type" : `Edit ${draft.name}`),
      h.OnSubmit(Message.SubmittedType()),
      h.Class("flex max-w-3xl flex-col gap-6"),
    ],
    [
      h.h2([h.Class("text-xl font-semibold")], [isNew ? "Create entity type" : "Edit entity type"]),
      h.div(
        [h.Class("grid gap-4 sm:grid-cols-2")],
        [
          input(
            {
              id: "type-name",
              label: "Name",
              value: draft.label,
              placeholder: "Employee",
              onInput: (value) => Message.UpdatedTypeLabel({ value }),
            },
            h,
          ),
          input(
            {
              id: "type-id",
              label: "ID",
              value: draft.name,
              isReadOnly: !isNew,
              placeholder: "employee",
              onInput: (value) => Message.UpdatedTypeName({ value }),
              className: "font-mono",
              ...(isNew ? {} : { description: "IDs can't change" }),
            },
            h,
          ),
        ],
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
      h.fieldset(
        [h.Class(cn("@container/fields flex flex-col gap-2 px-4 py-4", cardClass))],
        [
          h.legend([h.Class("sr-only")], ["Fields"]),
          fieldInputHeadingView("Field", h),
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

const fieldRowView = (field: FieldDraft, targets: ReadonlyArray<string>, h: HtmlBuilder<Message>) =>
  h.keyed("div")(
    String(field.key),
    [componentName("field-row")],
    [
      fieldInputView(
        field,
        targets,
        {
          kind: "Field",
          onName: (value) => Message.UpdatedFieldName({ key: field.key, value }),
          onLabel: (value) => Message.UpdatedFieldLabel({ key: field.key, value }),
          onType: (value) => Message.SelectedFieldType({ key: field.key, value }),
          onTarget: (value) => Message.SelectedFieldTarget({ key: field.key, value }),
          onRemove: Message.ClickedRemoveField({ key: field.key }),
        },
        h,
      ),
    ],
  );

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
