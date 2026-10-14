/** Presents a run's saved snapshot, outcomes, and open tasks on its own page or beside another page. */
import * as Option from "effect/Option";
import type { HtmlBuilder } from "foldkit/html";
import { CircleAlert, LoaderCircle, Maximize2, OctagonX, Pencil, X } from "lucide";
import { button, buttonClass } from "@/components/ui/button";
import { componentName } from "@/lib/component";
import { formatTime, runDotClass, runStatusClass, runStatusLabel } from "@/lib/format";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Run } from "../../workflow.ts";
import { Message } from "../message.ts";
import { type Model, type OpenRun, readyRoles, RunDetail, RunNotice } from "../model.ts";
import { automationHref } from "../route.ts";
import { chipClass, eyebrowClass, panelTitleView } from "./shared.ts";
import { openTasksView } from "./task.ts";
import { workflowView } from "./workflow.ts";

const editAutomationView = (automationId: string, h: HtmlBuilder<Message>) =>
  h.a(
    [
      componentName("edit-automation"),
      h.Href(automationHref(automationId)),
      h.DataAttribute("slot", "button"),
      h.Class(buttonClass({ variant: "outline", size: "sm" })),
    ],
    [icon(h, Pencil, "size-3.5", "inline-start"), "Edit automation"],
  );

const runTitle = (openRun: OpenRun) =>
  RunDetail.match(openRun.detail, {
    Loading: () => openRun.runId,
    Unavailable: () => openRun.runId,
    Loaded: ({ run }) => run.workflow.name,
  });

const runStatusBadgeView = (openRun: OpenRun, isCompact: boolean, h: HtmlBuilder<Message>) =>
  RunDetail.match(openRun.detail, {
    Loading: () => h.empty,
    Unavailable: () => h.empty,
    Loaded: ({ run }) => runBadgeView(run, isCompact, h),
  });

const runBodyView = (openRun: OpenRun, model: Model, h: HtmlBuilder<Message>) =>
  RunDetail.match(openRun.detail, {
    Loading: () =>
      h.p(
        [componentName("run-body"), h.Class("text-sm text-muted-foreground")],
        ["Loading the run…"],
      ),
    Unavailable: ({ error }) =>
      h.p(
        [
          componentName("run-body"),
          h.Role("alert"),
          h.Class(
            "flex items-start gap-2 rounded-[10px] bg-destructive/10 px-3 py-2 text-sm text-destructive",
          ),
        ],
        [icon(h, CircleAlert, "mt-0.5 size-3.5"), `Couldn't load this run: ${error}`],
      ),
    Loaded: ({ run, maybeSubjectTitle, resumesAt }) =>
      runView(openRun, run, maybeSubjectTitle, resumesAt, model, h),
  });

const runNoticeView = (openRun: OpenRun, className: string, h: HtmlBuilder<Message>) =>
  RunNotice.match(openRun.notice, {
    Idle: () => h.empty,
    Sending: () =>
      h.div(
        [
          componentName("run-notice"),
          h.Role("status"),
          h.Class(cn(noticeBarClass, "text-muted-foreground", className)),
        ],
        [icon(h, LoaderCircle, "size-3.5 animate-spin text-signal"), "Sending your answer…"],
      ),
    Sent: () =>
      h.div(
        [
          componentName("run-notice"),
          h.Role("status"),
          h.Class(cn(noticeBarClass, "text-muted-foreground", className)),
        ],
        ["Answer sent."],
      ),
    Resuming: () =>
      h.div(
        [
          componentName("run-notice"),
          h.Role("status"),
          h.Class(cn(noticeBarClass, "text-muted-foreground", className)),
        ],
        [icon(h, LoaderCircle, "size-3.5 animate-spin text-dev"), "Resuming the wait now…"],
      ),
    Resumed: () =>
      h.div(
        [
          componentName("run-notice"),
          h.Role("status"),
          h.Class(cn(noticeBarClass, "text-muted-foreground", className)),
        ],
        ["Resumed now instead of at the scheduled time."],
      ),
    Failed: ({ error }) =>
      h.div(
        [
          componentName("run-notice"),
          h.Role("status"),
          h.Class(cn(noticeBarClass, "text-destructive", className)),
        ],
        [icon(h, CircleAlert, "size-3.5"), error],
      ),
  });

const noticeBarClass = "flex min-w-0 items-center gap-2 border-t py-3 text-xs";

export const runPageView = (model: Model, openRun: OpenRun, h: HtmlBuilder<Message>) =>
  h.main(
    [
      componentName("run-page"),
      h.Class("flex min-w-0 flex-1 flex-col lg:min-h-0"),
      h.AriaLabel("Run"),
    ],
    [
      h.div(
        [h.Class("flex-1 px-6 py-6 lg:overflow-y-auto")],
        [
          h.div(
            [h.Class("flex max-w-3xl flex-col gap-6")],
            [
              h.div(
                [h.Class("flex items-start justify-between gap-4")],
                [
                  panelTitleView("Run", runTitle(openRun), h),
                  h.div(
                    [h.Class("flex shrink-0 items-center gap-3")],
                    [
                      runStatusBadgeView(openRun, false, h),
                      editAutomationView(openRun.automationId, h),
                    ],
                  ),
                ],
              ),
              runBodyView(openRun, model, h),
            ],
          ),
        ],
      ),
      runNoticeView(openRun, "px-6", h),
    ],
  );

/** A run beside the overview or the studio, so it can play out while the page stays put. */
export const runPanelView = (model: Model, openRun: OpenRun, h: HtmlBuilder<Message>) =>
  h.aside(
    [
      componentName("run-panel"),
      h.AriaLabel("Run preview"),
      h.Class(
        `flex flex-col border-t bg-background animate-in fade-in slide-in-from-right-2 duration-200 lg:fixed lg:top-12 lg:bottom-0 lg:z-30 lg:w-[22rem] lg:shrink-0 lg:border-t-0 lg:border-l lg:shadow-xl 2xl:static 2xl:min-h-0 2xl:w-[28rem] 2xl:shadow-none ${model.assistant.collapsed ? "lg:right-14" : "lg:right-[360px]"}`,
      ),
    ],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-3 border-b px-5 py-3")],
        [
          h.div(
            [h.Class("flex min-w-0 flex-col gap-0.5")],
            [
              h.div(
                [h.Class("flex items-center gap-2")],
                [h.span([h.Class(eyebrowClass)], ["Run"]), runStatusBadgeView(openRun, true, h)],
              ),
              h.h2([h.Class("truncate text-base font-semibold")], [runTitle(openRun)]),
            ],
          ),
          h.div(
            [h.Class("flex shrink-0 items-center gap-0.5")],
            [
              button(
                {
                  onClick: Message.ClickedExpandRunPanel(),
                  variant: "ghost",
                  size: "icon-sm",
                  className: "text-sand-10",
                  attributes: [h.AriaLabel("Open the run's page"), h.Title("Open the run's page")],
                },
                [icon(h, Maximize2, "size-4")],
                h,
              ),
              button(
                {
                  onClick: Message.ClickedCloseRunPanel(),
                  variant: "ghost",
                  size: "icon-sm",
                  className: "text-sand-10",
                  attributes: [h.AriaLabel("Close the run"), h.Title("Close the run")],
                },
                [icon(h, X, "size-4")],
                h,
              ),
            ],
          ),
        ],
      ),
      h.div([h.Class("flex-1 px-5 py-5 lg:overflow-y-auto")], [runBodyView(openRun, model, h)]),
      runNoticeView(openRun, "px-5", h),
    ],
  );

const runBadgeView = (run: Run, isCompact: boolean, h: HtmlBuilder<Message>) =>
  h.span(
    [
      componentName("run-badge"),
      h.Class(
        cn(
          "inline-flex items-center gap-1.5 text-sm font-semibold whitespace-nowrap",
          runStatusClass[run.status],
        ),
      ),
    ],
    [
      h.span([h.Class(cn("size-1.5 rounded-full", runDotClass[run.status])), h.AriaHidden(true)]),
      runStatusLabel[run.status],
      isCompact
        ? h.empty
        : h.span([h.Class("font-mono text-xs font-normal text-sand-10")], [run.id]),
    ],
  );

const runView = (
  openRun: OpenRun,
  run: Run,
  maybeSubjectTitle: Option.Option<string>,
  resumesAt: Readonly<Record<string, number>>,
  model: Model,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [componentName("run"), h.Class("flex max-w-2xl flex-col gap-6")],
    [
      h.p(
        [h.Class("text-sm text-muted-foreground")],
        [
          ...Option.match(maybeSubjectTitle, {
            onNone: () => [],
            onSome: (title) => [
              "For ",
              h.span([h.Class(cn(chipClass, "text-foreground"))], [title]),
              " · ",
            ],
          }),
          `Started ${formatTime(run.startedAt)} · Runs the version saved when it started`,
        ],
      ),
      run.error === undefined
        ? h.empty
        : h.p(
            [
              h.Role("alert"),
              h.Class(
                "flex items-start gap-2 rounded-[10px] bg-destructive/10 px-3 py-2 text-sm text-destructive",
              ),
            ],
            [icon(h, CircleAlert, "mt-0.5 size-3.5"), run.error],
          ),
      run.stopReason === undefined
        ? h.empty
        : h.p(
            [
              h.Role("status"),
              h.Class(
                "flex items-start gap-2 rounded-[10px] bg-sidebar px-3 py-2 text-sm text-foreground",
              ),
            ],
            [icon(h, OctagonX, "mt-0.5 size-3.5"), `Stopped: ${run.stopReason}`],
          ),
      openTasksView(run, openRun, model.liveConnections, h),
      workflowView(
        run.workflow,
        {
          scope: "run",
          expandedStepIds: model.expandedStepIds,
          maybeRunSteps: Option.some(run.steps),
          maybeRunWaits: Option.some({
            resumesAt,
            canResumeNow: model.isLocalDevelopment,
            isBusy:
              RunNotice.guards.Sending(openRun.notice) || RunNotice.guards.Resuming(openRun.notice),
          }),
          roles: readyRoles(model.roles),
          liveConnections: model.liveConnections,
        },
        h,
      ),
    ],
  );
