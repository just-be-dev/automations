import type { HtmlBuilder } from "foldkit/html";
import { type EntityField, FieldType } from "../../entities.ts";
import { componentName } from "../lib/component.ts";
import { labelFromName } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { inputClass } from "./ui/input.ts";
import { inputGroup, inputGroupControlClass } from "./ui/input-group.ts";
import { select } from "./ui/select.ts";

const gridClass =
  "grid min-w-0 grid-cols-2 gap-2 @min-[32rem]/fields:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_6rem]";
const controlClass = cn(inputClass, "text-xs md:text-xs");

export const fieldInputHeadingView = <M>(kind: "Field" | "Slot", h: HtmlBuilder<M>) =>
  h.div(
    [
      componentName("field-input-heading"),
      h.Class(cn(gridClass, "hidden text-xs font-medium text-sand-10 @min-[32rem]/fields:grid")),
    ],
    [kind, "Label", "Points to"].map((heading) => h.span([h.Class("px-2.5")], [heading])),
  );

export const fieldInputView = <M>(
  field: EntityField,
  targets: ReadonlyArray<string>,
  config: {
    readonly kind: "Field" | "Slot";
    readonly onName: (value: string) => M;
    readonly onLabel: (value: string) => M;
    readonly onType: (value: string) => M;
    readonly onTarget: (value: string) => M;
    readonly onRemove: M;
  },
  h: HtmlBuilder<M>,
) => {
  const name = field.name.trim() || `new ${config.kind.toLowerCase()}`;
  return h.div(
    [
      componentName("field-input"),
      h.Role("group"),
      h.AriaLabel(`${config.kind} ${name}`),
      h.Class(gridClass),
    ],
    [
      inputGroup(
        {
          label: `${config.kind} ${name} definition`,
          removeLabel: `Remove ${config.kind.toLowerCase()} ${name}`,
          onRemove: config.onRemove,
          className: "col-span-2 @min-[32rem]/fields:col-span-1",
        },
        [
          h.input([
            h.AriaLabel(`${config.kind} name (${name})`),
            h.Value(field.name),
            h.Placeholder(config.kind === "Slot" ? "hire" : "start_date"),
            h.Spellcheck(false),
            h.OnInput(config.onName),
            h.Class(cn(inputGroupControlClass, "flex-1 font-mono")),
          ]),
          select(
            {
              isGrouped: true,
              attributes: [
                h.AriaLabel(`${config.kind} type (${name})`),
                h.Value(field.type),
                h.OnChange(config.onType),
              ],
            },
            FieldType.literals.map((type) =>
              h.option([h.Value(type), h.Selected(type === field.type)], [type]),
            ),
            h,
          ),
        ],
        h,
      ),
      h.input([
        h.AriaLabel(`${config.kind} label (${name})`),
        h.Value(field.label),
        h.Placeholder(
          labelFromName(field.name) || (config.kind === "Slot" ? "New hire" : "Start date"),
        ),
        h.OnInput(config.onLabel),
        h.Class(controlClass),
      ]),
      field.type === "ref"
        ? select(
            {
              className: "text-xs md:text-xs",
              attributes: [
                h.AriaLabel(`Points to (${name})`),
                h.Value(field.to ?? ""),
                h.OnChange(config.onTarget),
              ],
            },
            [
              h.option([h.Value(""), h.Selected(!field.to)], ["Choose…"]),
              ...targets.map((target) =>
                h.option([h.Value(target), h.Selected(target === field.to)], [target]),
              ),
            ],
            h,
          )
        : h.span([h.Class("flex items-center px-2.5 text-xs text-sand-9")], ["—"]),
    ],
  );
};
