/** Supplies one event payload for a targeted run and explains which saved filter must match. */
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Condition, Trigger } from "../../workflow.ts";
import * as Schema from "effect/Schema";
import * as Submodel from "foldkit/submodel";
import { Plus } from "lucide";
import { EventInput } from "../domain/index.ts";
import { Message } from "../domain/event-input.ts";
import { input } from "./ui/input.ts";
import { inputGroup, inputGroupControlClass } from "./ui/input-group.ts";
import { select } from "./ui/select.ts";
import { button } from "./ui/button.ts";
import { labelFromName } from "../lib/format.ts";
import { componentName } from "../lib/component.ts";
import { icon } from "../lib/icons.ts";

const comparisonWords = {
  equals: "equals",
  notEquals: "does not equal",
  greaterThan: "is more than",
  lessThan: "is less than",
  contains: "contains",
  before: "is before",
  after: "is after",
};

const conditionText = (condition: Condition): string => {
  if ("all" in condition) {
    return `(${condition.all.map(conditionText).join(" and ")})`;
  }
  if ("any" in condition) {
    return `(${condition.any.map(conditionText).join(" or ")})`;
  }
  if ("not" in condition) {
    return `not ${conditionText(condition.not)}`;
  }
  const field = condition.ref.startsWith("event.data.")
    ? condition.ref.slice("event.data.".length).split(".").map(labelFromName).join(" → ")
    : condition.ref === "event.data"
      ? "Event data"
      : condition.ref;
  return condition.op === "exists"
    ? `${field} is set`
    : `${field} ${comparisonWords[condition.op]} ${
        typeof condition.value === "boolean"
          ? condition.value
            ? "Yes"
            : "No"
          : JSON.stringify(condition.value)
      }`;
};

export const eventInputView = <M>(
  trigger: Extract<Trigger, { kind: "event" }>,
  editor: EventInput.Model,
  toMessage: (message: EventInput.Message) => M,
  isDisabled: boolean,
  h: HtmlBuilder<M>,
) =>
  h.submodel({
    slotId: "event-input",
    model: editor,
    view: eventInputBodyView,
    viewInputs: { trigger, isDisabled },
    toParentMessage: toMessage,
  });

const eventInputBodyView = Submodel.defineView<
  EventInput.Model,
  Message,
  { readonly trigger: Extract<Trigger, { kind: "event" }>; readonly isDisabled: boolean }
>((editor, { trigger, isDisabled }, h) =>
  h.div(
    [
      componentName("event-input-body"),
      h.Class("@container/event-input flex w-full max-w-lg flex-col gap-2"),
    ],
    [
      h.p([h.Class("text-sm font-medium")], [`Run with ${trigger.event}`]),
      h.p(
        [h.Class("text-xs text-muted-foreground")],
        ["Runs only this automation; the input is not published. Workflow actions still execute."],
      ),
      h.p(
        [h.Class("text-xs text-muted-foreground")],
        ["Fields are suggested from the saved automation. Add or adjust them as needed."],
      ),
      h.div(
        [h.Class("max-h-[45vh] overflow-y-auto")],
        [eventNodeView(editor.root, "Event data", false, isDisabled, h)],
      ),
      trigger.when === undefined
        ? h.empty
        : h.p(
            [h.Class("text-xs text-muted-foreground")],
            [`Must match: ${conditionText(trigger.when)}`],
          ),
    ],
  ),
);

const kindLabels: Record<EventInput.Kind, string> = {
  object: "Object",
  array: "List",
  text: "Text",
  number: "Number",
  boolean: "Yes / No",
  null: "Empty",
};

const eventNodeView = (
  node: EventInput.Node,
  label: string,
  isField: boolean,
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const isGroup = node.kind === "object" || node.kind === "array";
  return h.div(
    [
      componentName("event-node"),
      h.Class(
        node.id === 0
          ? "@container/event-input min-w-0 rounded-lg border border-border bg-card p-2.5"
          : isGroup
            ? "@container/event-input min-w-0 border-l border-border pl-3"
            : "min-w-0 py-0.5",
      ),
    ],
    [
      h.div(
        [
          h.Class(
            "grid grid-cols-1 items-center gap-1.5 " +
              (isGroup ? "mb-1.5" : "@min-[26rem]/event-input:grid-cols-[16rem_minmax(0,1fr)]"),
          ),
        ],
        [
          eventNodeFieldView(node, label, isField, isDisabled, h),
          isGroup
            ? h.empty
            : h.div(
                [
                  h.Class(
                    "col-span-full row-start-2 min-w-0 @min-[26rem]/event-input:col-span-1 @min-[26rem]/event-input:col-start-2 @min-[26rem]/event-input:row-start-1",
                  ),
                ],
                [eventNodeValueView(node, label, isDisabled, h)],
              ),
        ],
      ),
      isGroup
        ? h.div(
            [h.Class("flex flex-col gap-1")],
            [
              ...node.children.map((child, index) =>
                h.keyed("div")(
                  String(child.id),
                  [],
                  [
                    eventNodeView(
                      child,
                      node.kind === "array"
                        ? `${label} item ${index + 1}`
                        : labelFromName(child.name) || "New field",
                      node.kind === "object",
                      isDisabled,
                      h,
                    ),
                  ],
                ),
              ),
              h.div(
                [h.Class("mt-1.5 border-t border-border pt-3")],
                [
                  button(
                    {
                      onClick: Message.ClickedAdd({ id: node.id }),
                      variant: "outline",
                      size: "sm",
                      isDisabled,
                      attributes: [
                        h.AriaLabel(
                          node.kind === "object" ? `Add field to ${label}` : `Add item to ${label}`,
                        ),
                      ],
                    },
                    [icon(h, Plus, "size-3.5"), node.kind === "object" ? "Add field" : "Add item"],
                    h,
                  ),
                ],
              ),
            ],
          )
        : h.empty,
    ],
  );
};

const eventNodeFieldView = (
  node: EventInput.Node,
  label: string,
  isField: boolean,
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  inputGroup(
    {
      label: `${label} field`,
      onRemove: node.id === 0 ? undefined : Message.ClickedRemove({ id: node.id }),
      removeLabel: `Remove ${label}`,
      isDisabled,
      attributes: [componentName("event-node-field")],
    },
    [
      isField
        ? input(
            {
              id: `event-name-${node.id}`,
              label: `${label} field name`,
              value: node.name,
              onInput: (name) => Message.UpdatedName({ id: node.id, name }),
              isDisabled,
              wrapperClass: "h-full min-w-0 flex-1 gap-0",
              className: inputGroupControlClass,
              labelClass: "sr-only",
              placeholder: "Field name",
            },
            h,
          )
        : h.span([h.Class("flex min-w-0 flex-1 items-center px-2.5 text-xs font-medium")], [label]),
      h.label([h.For(`event-kind-${node.id}`), h.Class("sr-only")], [`${label} type`]),
      select(
        {
          isGrouped: true,
          attributes: [
            h.Id(`event-kind-${node.id}`),
            h.Value(node.kind),
            h.Disabled(isDisabled),
            h.OnChange((kind) =>
              Message.SelectedKind({
                id: node.id,
                kind: Schema.decodeUnknownSync(EventInput.Kind)(kind),
              }),
            ),
          ],
        },
        EventInput.Kind.literals.map((kind) =>
          h.option([h.Value(kind), h.Selected(node.kind === kind)], [kindLabels[kind]]),
        ),
        h,
      ),
    ],
    h,
  );

const eventNodeValueView = (
  node: EventInput.Node,
  label: string,
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const id = `event-value-${node.id}`;
  return node.kind === "null"
    ? h.p(
        [componentName("event-node-value"), h.Class("text-xs text-muted-foreground")],
        ["No value"],
      )
    : node.kind === "boolean"
      ? h.div(
          [componentName("event-node-value")],
          [
            h.label([h.For(id), h.Class("sr-only")], [label]),
            select(
              {
                className: "text-xs md:text-xs",
                attributes: [
                  h.Id(id),
                  h.Value(node.value),
                  h.Disabled(isDisabled),
                  h.OnChange((value) => Message.UpdatedValue({ id: node.id, value })),
                ],
              },
              [
                ["", "Choose…"],
                ["true", "Yes"],
                ["false", "No"],
              ].map(([value, text]) =>
                h.option([h.Value(value ?? ""), h.Selected(node.value === value)], [text ?? ""]),
              ),
              h,
            ),
          ],
        )
      : input(
          {
            id,
            label,
            value: node.value,
            type: node.kind === "number" ? "number" : "text",
            onInput: (value) => Message.UpdatedValue({ id: node.id, value }),
            isDisabled,
            className: "text-xs md:text-xs",
            labelClass: "sr-only",
            wrapperAttributes: [componentName("event-node-value")],
            placeholder: node.kind === "number" ? "Enter a number" : "Enter text",
          },
          h,
        );
};
