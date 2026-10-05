import * as Option from "effect/Option";
import type { Document, HtmlBuilder } from "foldkit/html";
import { Input } from "@foldkit/ui";
import { Hash, Monitor, Moon, Sun } from "lucide";
import { button } from "@/components/ui/button";
import { icon } from "@/lib/icons";
import { automationIdInputId } from "../constant.ts";
import { Message, toEntitiesMessage, toOverviewMessage } from "../message.ts";
import { type Model, Page } from "../model.ts";
import { Entities, Overview } from "../page/index.ts";
import { nextTheme, type Theme } from "../theme.ts";
import { conversationView } from "./conversation.ts";
import { runPageView, runPanelView } from "./run.ts";
import { sidebarView } from "./sidebar.ts";
import { workflowPanelView } from "./studio.ts";

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Automations studio",
  body: h.div(
    [h.Class("flex min-h-full flex-col bg-sidebar lg:h-full lg:flex-row")],
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
    ],
  ),
});

const pageView = (model: Model, h: HtmlBuilder<Message>) =>
  Page.match(model.page, {
    Overview: ({ overview }) =>
      h.main(
        [h.Class("flex min-w-0 flex-1 flex-col lg:min-h-0")],
        [
          h.submodel({
            slotId: "overview",
            model: overview,
            view: Overview.view,
            toParentMessage: toOverviewMessage,
          }),
        ],
      ),
    Entities: ({ entities }) =>
      h.main(
        [h.Class("flex min-w-0 flex-1 flex-col lg:min-h-0")],
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
      h.Class(
        "grid h-12 shrink-0 grid-cols-[1fr_minmax(0,28rem)_1fr] items-center gap-2 border-b px-4",
      ),
    ],
    [
      h.div([]),
      Input.view(
        {
          id: automationIdInputId,
          value: model.automationIdInput,
          placeholder: "new-automation-id",
          onInput: (value) => Message.UpdatedAutomationId({ value }),
          toView: (attributes) =>
            h.div(
              [
                h.Class(
                  "flex h-8 w-full max-w-md items-center gap-1.5 rounded-[10px] border bg-sidebar px-2 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25",
                ),
              ],
              [
                icon(h, Hash, "size-4 text-muted-foreground"),
                h.label([...attributes.label, h.Class("sr-only")], ["Automation ID"]),
                h.input([
                  ...attributes.input,
                  h.Autocomplete("off"),
                  h.Spellcheck(false),
                  h.OnChange(() => Message.ChangedAutomationId()),
                  h.Class(
                    "h-full min-w-0 flex-1 bg-transparent px-0.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground",
                  ),
                ]),
              ],
            ),
        },
        h,
      ),
      themeToggleView(model.theme, h),
    ],
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
      className: "justify-self-end rounded-[10px] text-sand-10",
      attributes: [
        h.AriaLabel(`Color theme: ${theme}`),
        h.Title(`Color theme: ${theme}. Click for ${nextTheme[theme]}.`),
      ],
    },
    [icon(h, themeIcon[theme], "size-4")],
    h,
  );
