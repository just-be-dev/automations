import * as Option from "effect/Option";
import type { Document, HtmlBuilder } from "foldkit/html";
import { Monitor, Moon, Sun } from "lucide";
import { button } from "@/components/ui/button";
import { componentName } from "@/lib/component";
import { icon } from "@/lib/icons";
import { Message, toEntitiesMessage, toOverviewMessage, toTemplatesMessage } from "../message.ts";
import { listedName, type Model, Page } from "../model.ts";
import { Entities, Overview, Templates } from "../page/index.ts";
import { nextTheme, type Theme } from "../theme.ts";
import { conversationView } from "./conversation.ts";
import { newAutomationDialogView } from "./new-automation.ts";
import { runPageView, runPanelView } from "./run.ts";
import { sidebarView } from "./sidebar.ts";
import { workflowPanelView } from "./studio.ts";

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Automations studio",
  body: h.div(
    [componentName("app"), h.Class("flex min-h-full flex-col bg-sidebar lg:h-full lg:flex-row")],
    [
      sidebarView(model, h),
      h.div(
        [h.Class("flex min-w-0 flex-1 flex-col bg-background lg:min-h-0 lg:border-l")],
        [
          headerView(model, h),
          h.div(
            [h.Class("flex flex-1 flex-col lg:min-h-0 lg:flex-row")],
            [
              pageView(model, h),
              Option.match(model.maybeRunPanel, {
                onNone: () => h.empty,
                onSome: (openRun) => runPanelView(model, openRun, h),
              }),
            ],
          ),
        ],
      ),
      newAutomationDialogView(model, h),
    ],
  ),
});

const pageView = (model: Model, h: HtmlBuilder<Message>) =>
  Page.match(model.page, {
    Overview: ({ overview }) =>
      h.main(
        [componentName("page"), h.Class("flex min-w-0 flex-1 flex-col lg:min-h-0")],
        [
          h.submodel({
            slotId: "overview",
            model: overview,
            view: Overview.view,
            toParentMessage: toOverviewMessage,
          }),
        ],
      ),
    Templates: ({ templates }) =>
      h.main(
        [componentName("page"), h.Class("flex min-w-0 flex-1 flex-col lg:min-h-0")],
        [
          h.submodel({
            slotId: "templates",
            model: templates,
            view: Templates.view,
            toParentMessage: toTemplatesMessage,
          }),
        ],
      ),
    Entities: ({ entities }) =>
      h.main(
        [componentName("page"), h.Class("flex min-w-0 flex-1 flex-col lg:min-h-0")],
        [
          h.submodel({
            slotId: "entities",
            model: entities,
            view: Entities.view,
            toParentMessage: toEntitiesMessage,
          }),
        ],
      ),
    Studio: () =>
      h.main(
        [
          componentName("page"),
          h.Class(
            "grid min-w-0 flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]",
          ),
        ],
        [conversationView(model, h), workflowPanelView(model, h)],
      ),
    Run: ({ openRun }) => runPageView(model, openRun, h),
  });

const headerView = (model: Model, h: HtmlBuilder<Message>) =>
  h.header(
    [
      componentName("header"),
      h.Class("flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4"),
    ],
    [headerTitleView(model, h), themeToggleView(model.theme, h)],
  );

const headerTitleView = (model: Model, h: HtmlBuilder<Message>) =>
  Page.match(model.page, {
    Overview: () => headerLabelView("Overview", h),
    Templates: () => headerLabelView("Templates", h),
    Entities: () => headerLabelView("Entity store", h),
    Studio: () => automationTitleView(model, h),
    Run: () => automationTitleView(model, h),
  });

const headerLabelView = (label: string, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("header-label"), h.Class("truncate text-sm font-medium tracking-tight")],
    [label],
  );

/** The open automation's name, falling back to its ID until the sidebar lists it. */
const automationTitleView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("automation-title"), h.Class("flex min-w-0 items-baseline gap-2")],
    Option.match(listedName(model.directory, model.automationId), {
      onNone: () => [
        h.span([h.Class("truncate font-mono text-[13px] font-medium")], [model.automationId]),
      ],
      onSome: (name) => [
        h.span([h.Class("truncate text-sm font-medium tracking-tight")], [name]),
        h.span(
          [h.Class("hidden shrink-0 font-mono text-[11px] text-sand-10 sm:inline")],
          [model.automationId],
        ),
      ],
    }),
  );

const themeIcon: Record<Theme, Parameters<typeof icon>[1]> = {
  System: Monitor,
  Light: Sun,
  Dark: Moon,
};

const themeToggleView = (theme: Theme, h: HtmlBuilder<Message>) =>
  button(
    {
      onClick: Message.ClickedThemeToggle(),
      variant: "ghost",
      size: "icon-sm",
      className: "rounded-[10px] text-sand-10",
      attributes: [
        componentName("theme-toggle"),
        h.AriaLabel(`Color theme: ${theme}`),
        h.Title(`Color theme: ${theme}. Click for ${nextTheme[theme]}.`),
      ],
    },
    [icon(h, themeIcon[theme], "size-4")],
    h,
  );
