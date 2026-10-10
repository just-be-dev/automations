import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { X } from "lucide";
import { componentName } from "@/lib/component";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { button } from "./button.ts";
import { inputClass } from "./input.ts";

export const inputGroupControlClass = cn(
  inputClass,
  "h-full rounded-none border-0 bg-transparent text-xs focus-visible:ring-0 md:text-xs",
);

export const inputGroup = <M>(
  config: {
    readonly label: string;
    readonly removeLabel?: string;
    readonly onRemove?: M;
    readonly isDisabled?: boolean;
    readonly className?: string;
    readonly attributes?: ReadonlyArray<Attribute<M>>;
  },
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [
      componentName("input-group"),
      h.Role("group"),
      h.AriaLabel(config.label),
      h.Class(
        cn(
          "flex h-8 min-w-0 items-stretch overflow-hidden rounded-lg border border-border bg-background transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25",
          config.className,
        ),
      ),
      ...(config.attributes ?? []),
    ],
    [
      ...children,
      config.onRemove === undefined
        ? h.empty
        : button(
            {
              onClick: config.onRemove,
              variant: "ghost",
              size: "icon-sm",
              isDisabled: config.isDisabled,
              className:
                "h-full w-8 rounded-none border-0 border-l border-border text-muted-foreground hover:text-destructive focus-visible:ring-0 active:translate-y-0",
              attributes: [
                h.AriaLabel(config.removeLabel ?? `Remove ${config.label}`),
                h.Title(config.removeLabel ?? `Remove ${config.label}`),
              ],
            },
            icon(h, X, "size-3.5"),
            h,
          ),
    ],
  );
