/** Native dropdowns share the input surface and an inset, non-interactive chevron. */
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { ChevronDown } from "lucide";
import { componentName } from "@/lib/component";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { inputClass } from "./input.ts";
import { inputGroupControlClass } from "./input-group.ts";

export const select = <M>(
  config: {
    readonly attributes: ReadonlyArray<Attribute<M>>;
    readonly className?: string;
    readonly isGrouped?: boolean;
    readonly wrapperClass?: string;
    readonly wrapperAttributes?: ReadonlyArray<Attribute<M>>;
  },
  options: ReadonlyArray<Html>,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [
      componentName("select"),
      h.Class(
        cn(
          "relative min-w-0",
          config.isGrouped && "h-full w-24 shrink-0 border-l border-border",
          config.wrapperClass,
        ),
      ),
      ...(config.wrapperAttributes ?? []),
    ],
    [
      h.select(
        [
          ...config.attributes,
          h.Class(
            cn(
              config.isGrouped ? inputGroupControlClass : inputClass,
              config.className,
              "appearance-none pr-7",
            ),
          ),
        ],
        options,
      ),
      h.span(
        [h.Class("pointer-events-none absolute inset-y-0 right-2 flex items-center")],
        [icon(h, ChevronDown, "size-3")],
      ),
    ],
  );
