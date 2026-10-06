/** Keeps shared studio headings, step metadata, and text-submission affordances consistent across views. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { Html, HtmlBuilder, TextareaAttribute } from "foldkit/html";
import { componentName } from "@/lib/component";
import { cn } from "@/lib/utils";
import { maxMessageLength } from "../constant.ts";
import type { ShortcutModifier } from "../platform.ts";
import type { Message } from "../message.ts";

export const eyebrowClass = "text-xs font-medium text-sand-10";

export const panelTitleView = (eyebrow: string, title: string, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("panel-title"), h.Class("min-w-0")],
    [
      h.div([h.Class(eyebrowClass)], [eyebrow]),
      h.h2([h.Class("truncate text-xl font-semibold")], [title]),
    ],
  );

export const chipClass =
  "rounded-[4px] bg-chip px-1.5 py-0.5 font-mono text-[0.92em] box-decoration-clone";

export const notifyLabel: Record<"email" | "slack", string> = { email: "Email", slack: "Slack" };

export const stepMetaView = (items: ReadonlyArray<Html | string>, h: HtmlBuilder<Message>) =>
  h.ul(
    [
      componentName("step-meta"),
      h.Class("flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground"),
    ],
    Array.map(items, (item) => h.li([], [item])),
  );

/** The platform's modifier with Enter in a textarea sends `message`; Enter alone adds a line. */
export const submitShortcut = (
  modifier: ShortcutModifier,
  message: Message,
  h: HtmlBuilder<Message>,
): ReadonlyArray<TextareaAttribute<Message>> => [
  h.AriaKeyshortcuts(`${modifier}+Enter`),
  h.OnKeyDownPreventDefault((key, modifiers) =>
    key === "Enter" && (modifier === "Meta" ? modifiers.metaKey : modifiers.ctrlKey)
      ? Option.some(message)
      : Option.none(),
  ),
];

/** How much of a chat message's length a textarea has used. */
export const characterCountView = (
  length: number,
  className: string | undefined,
  h: HtmlBuilder<Message>,
) =>
  h.span(
    [
      componentName("character-count"),
      h.Class(cn("font-mono text-[11px] text-muted-foreground tabular-nums", className)),
    ],
    [`${length} / ${maxMessageLength.toLocaleString("en-US")}`],
  );
