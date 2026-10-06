import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { HtmlBuilder } from "foldkit/html";
import { LayoutDashboard, Database, Plus, Workflow as WorkflowIcon } from "lucide";
import { button } from "@/components/ui/button";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { Message } from "../message.ts";
import { type AutomationSummary, Directory, type Model, Page } from "../model.ts";
import { automationHref, entitiesHref, overviewHref } from "../route.ts";

const sidebarNoteClass = "px-1.5 py-1 text-xs text-muted-foreground";

const navItemClass =
  "group/nav-item my-px flex items-start gap-2 rounded-[8px] py-1.5 pr-2.5 pl-1.5 text-muted-foreground transition-colors duration-100 outline-none hover:bg-hover hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

export const sidebarView = (model: Model, h: HtmlBuilder<Message>) =>
  h.nav(
    [
      h.AriaLabel("Automations"),
      h.Class("flex shrink-0 flex-col border-b px-2 pb-2 lg:min-h-0 lg:w-60 lg:border-b-0"),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-1.5 px-2 py-3")],
        [
          h.span(
            [
              h.Class(
                "flex size-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-brand/80 to-brand text-[13px] font-medium text-signal-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.3)]",
              ),
              h.AriaHidden(true),
            ],
            ["A"],
          ),
          h.span([h.Class("truncate text-sm font-medium")], ["Automations studio"]),
        ],
      ),
      h.a(
        [
          h.Href(overviewHref),
          ...(Page.guards.Overview(model.page) ? [h.AriaCurrent("page")] : []),
          h.Class(
            cn(
              navItemClass,
              "items-center text-[13px] font-medium tracking-tight",
              Page.guards.Overview(model.page) && "bg-hover text-foreground",
            ),
          ),
        ],
        [icon(h, LayoutDashboard, "size-4"), "Overview"],
      ),
      h.div(
        [h.Class("mt-3 mb-px flex h-[22px] items-center justify-between gap-2 pr-0.5 pl-1.5")],
        [
          h.h2([h.Class("text-[11px] font-semibold tracking-tight text-sand-10")], ["Automations"]),
          button(
            {
              onClick: Message.ClickedNewAutomation(),
              variant: "ghost",
              size: "icon-sm",
              className: "-my-1 text-muted-foreground hover:text-foreground",
              attributes: [h.AriaLabel("New automation"), h.Title("New automation")],
            },
            [icon(h, Plus, "size-4")],
            h,
          ),
        ],
      ),
      h.div(
        [h.Class("max-h-56 overflow-y-auto lg:max-h-none lg:flex-1")],
        [
          Directory.match(model.directory, {
            Loading: () => h.p([h.Class(sidebarNoteClass)], ["Loading…"]),
            Unavailable: ({ error }) =>
              h.p(
                [h.Class(cn(sidebarNoteClass, "text-destructive"))],
                [`Couldn't load automations: ${error}`],
              ),
            Ready: ({ automations }) =>
              Array.match(automations, {
                onEmpty: () => h.empty,
                onNonEmpty: (listed) =>
                  h.ul(
                    [h.Class("flex flex-col")],
                    Array.map(listed, (automation) =>
                      automationLinkView(
                        automation,
                        Page.guards.Studio(model.page) && automation.id === model.automationId,
                        h,
                      ),
                    ),
                  ),
              }),
          }),
        ],
      ),
      h.div(
        [h.Class("mt-2 border-t pt-2")],
        [
          h.h2(
            [
              h.Class(
                "mb-px flex h-[22px] items-center pl-1.5 text-[11px] font-semibold tracking-tight text-sand-10",
              ),
            ],
            ["Debug"],
          ),
          h.a(
            [
              h.Href(entitiesHref(Option.none())),
              ...(Page.guards.Entities(model.page) ? [h.AriaCurrent("page")] : []),
              h.Class(
                cn(
                  navItemClass,
                  "items-center text-[13px] font-medium tracking-tight",
                  Page.guards.Entities(model.page) && "bg-hover text-foreground",
                ),
              ),
            ],
            [icon(h, Database, "size-4"), "Entity store"],
          ),
        ],
      ),
    ],
  );

const automationLinkView = (
  automation: AutomationSummary,
  isCurrent: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.keyed("li")(
    automation.id,
    [],
    [
      h.a(
        [
          h.Href(automationHref(automation.id)),
          ...(isCurrent ? [h.AriaCurrent("page")] : []),
          h.Class(cn(navItemClass, isCurrent && "bg-hover text-foreground")),
        ],
        [
          h.span([h.Class("flex h-5 shrink-0 items-center")], [icon(h, WorkflowIcon, "size-4")]),
          h.span(
            [h.Class("flex min-w-0 flex-col gap-0.5")],
            [
              h.span(
                [h.Class("truncate text-[13px] font-medium tracking-tight")],
                [automation.name],
              ),
              h.span([h.Class("truncate font-mono text-[11px] text-sand-10")], [automation.id]),
            ],
          ),
        ],
      ),
    ],
  );
