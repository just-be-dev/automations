/** Presents a run as a live checklist of its saved plan, on its own page or beside another page,
 * with a footer that runs the saved version again. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { HtmlBuilder } from "foldkit/html";
import { CircleAlert, LoaderCircle, Maximize2, OctagonX, Pencil, Play, X } from "lucide";
import { badge } from "@/components/ui/badge";
import { button, buttonClass } from "@/components/ui/button";
import { select } from "@/components/ui/select";
import { componentName } from "@/lib/component";
import { formatTime, runDotClass, runStatusClass, runStatusLabel, withArticle } from "@/lib/format";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Run } from "../../workflow.ts";
import type { SubjectOption } from "../api.ts";
import { Message } from "../message.ts";
import {
  type Model,
  type OpenRun,
  Page,
  RunDetail,
  RunNotice,
  RunStart,
  runSubjectType,
  SubjectChoices,
} from "../model.ts";
import { automationHref } from "../route.ts";
import { runChecklistView } from "./run-checklist.ts";
import { panelTitleView } from "./shared.ts";

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

const loadedRun = (openRun: OpenRun) =>
  RunDetail.match(openRun.detail, {
    Loading: () => Option.none<{ run: Run; maybeSubjectTitle: Option.Option<string> }>(),
    Unavailable: () => Option.none<{ run: Run; maybeSubjectTitle: Option.Option<string> }>(),
    Loaded: (loaded) => Option.some(loaded),
  });

const automationName = (openRun: OpenRun) =>
  Option.match(loadedRun(openRun), {
    onNone: () => openRun.runId,
    onSome: ({ run }) => run.workflow.name,
  });

/** What the run is for: its subject, or the automation when it has none. */
const runForText = (openRun: OpenRun) =>
  Option.flatMap(loadedRun(openRun), ({ run, maybeSubjectTitle }) =>
    Option.orElse(maybeSubjectTitle, () => Option.some(run.workflow.name)),
  );

const savedVersionTagView = (isSmall: boolean, h: HtmlBuilder<Message>) =>
  badge(
    {
      variant: "secondary",
      className: cn(
        "rounded-md font-medium text-sand-12",
        isSmall ? "h-5 px-1.5 text-[11px]" : "h-6 px-2 text-xs",
      ),
      attributes: [
        componentName("saved-version-tag"),
        h.Title("Runs the version saved when it started"),
      ],
    },
    ["Saved version"],
    h,
  );

const runBadgeView = (run: Run, h: HtmlBuilder<Message>) =>
  h.span(
    [
      componentName("run-badge"),
      h.Class(
        cn(
          "inline-flex items-center gap-1.5 font-medium whitespace-nowrap",
          runStatusClass[run.status],
        ),
      ),
    ],
    [
      h.span([h.Class(cn("size-1.5 rounded-full", runDotClass[run.status])), h.AriaHidden(true)]),
      runStatusLabel[run.status],
    ],
  );

const separatorView = (h: HtmlBuilder<Message>) => h.span([h.AriaHidden(true)], ["·"]);

/** "Run · Ada Lovelace", then the automation, status, and start time beneath. */
/** Where the heading sits: the run page's card, or the narrow panel, which may name the automation. */
type HeadingPlace = "page" | "panel" | "panelBesideStudio";

const runHeadingView = (openRun: OpenRun, place: HeadingPlace, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("run-heading"), h.Class("flex min-w-0 flex-col gap-1")],
    [
      h.h2(
        [h.Class("flex min-w-0 items-baseline gap-1.5 text-base font-semibold")],
        [
          h.span([], ["Run"]),
          ...Option.match(runForText(openRun), {
            onNone: () => [],
            onSome: (title) => [
              h.span(
                [h.Class("min-w-0 truncate font-normal text-muted-foreground")],
                [` · ${title}`],
              ),
            ],
          }),
        ],
      ),
      Option.match(
        Option.filter(
          loadedRun(openRun),
          ({ maybeSubjectTitle }) => place === "panel" && Option.isSome(maybeSubjectTitle),
        ),
        {
          onNone: () => h.empty,
          onSome: ({ run }) =>
            h.p([h.Class("truncate text-xs text-muted-foreground")], [run.workflow.name]),
        },
      ),
      Option.match(loadedRun(openRun), {
        onNone: () => h.empty,
        onSome: ({ run }) =>
          h.p(
            [
              h.Class(
                "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground",
              ),
            ],
            [
              runBadgeView(run, h),
              separatorView(h),
              h.span([], [`Started ${formatTime(run.startedAt)}`]),
              ...(place === "page"
                ? [separatorView(h), h.span([h.Class("font-mono")], [run.id])]
                : [savedVersionTagView(true, h)]),
            ],
          ),
      }),
    ],
  );

const alertClass = "flex items-start gap-2 rounded-[10px] px-3 py-2 text-sm";

const runOutcomeView = (run: Run, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("run-outcome"), h.Class("flex flex-col gap-2 empty:hidden")],
    [
      run.error === undefined
        ? h.empty
        : h.p(
            [h.Role("alert"), h.Class(cn(alertClass, "bg-destructive/10 text-destructive"))],
            [icon(h, CircleAlert, "mt-0.5 size-3.5 shrink-0"), run.error],
          ),
      run.stopReason === undefined
        ? h.empty
        : h.p(
            [h.Role("status"), h.Class(cn(alertClass, "bg-sidebar text-foreground"))],
            [icon(h, OctagonX, "mt-0.5 size-3.5 shrink-0"), `Stopped: ${run.stopReason}`],
          ),
    ],
  );

const runBodyView = (openRun: OpenRun, model: Model, h: HtmlBuilder<Message>) =>
  RunDetail.match(openRun.detail, {
    Loading: () =>
      h.p(
        [componentName("run-body"), h.Class("py-3 text-sm text-muted-foreground")],
        ["Loading the run…"],
      ),
    Unavailable: ({ error }) =>
      h.p(
        [
          componentName("run-body"),
          h.Role("alert"),
          h.Class(cn(alertClass, "my-3 bg-destructive/10 text-destructive")),
        ],
        [icon(h, CircleAlert, "mt-0.5 size-3.5"), `Couldn't load this run: ${error}`],
      ),
    Loaded: ({ run, resumesAt }) =>
      h.div(
        [componentName("run-body"), h.Class("flex flex-col gap-3")],
        [
          runOutcomeView(run, h),
          runChecklistView(
            run,
            openRun,
            {
              expandedStepIds: model.expandedStepIds,
              liveConnections: model.liveConnections,
              waits: {
                resumesAt,
                canResumeNow: model.isLocalDevelopment,
                isBusy:
                  RunNotice.guards.Sending(openRun.notice) ||
                  RunNotice.guards.Resuming(openRun.notice),
              },
            },
            h,
          ),
        ],
      ),
  });

const noticeBarClass = "flex min-w-0 items-center gap-2 border-t py-3 text-xs";

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

const runSubjectOptionView = (
  subject: SubjectOption,
  isSelected: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.keyed("option")(
    subject.id,
    [componentName("run-subject-option"), h.Value(subject.id), h.Selected(isSelected)],
    [subject.title],
  );

const runSubjectPickerView = (openRun: OpenRun, h: HtmlBuilder<Message>) =>
  SubjectChoices.match(openRun.subjectChoices, {
    NotNeeded: () => h.empty,
    Loading: ({ entityType }) =>
      h.span(
        [componentName("run-subject-picker"), h.Class("text-xs text-muted-foreground")],
        [`Loading ${entityType.replaceAll("_", " ")} records…`],
      ),
    Unavailable: ({ entityType, error }) =>
      h.span(
        [componentName("run-subject-picker"), h.Class("text-xs text-destructive"), h.Title(error)],
        [`Couldn't load ${entityType.replaceAll("_", " ")} records`],
      ),
    Ready: ({ entityType, label, subjects }) =>
      h.div(
        [componentName("run-subject-picker"), h.Class("flex min-w-0 items-center")],
        [
          h.label([h.For("run-subject"), h.Class("sr-only")], [label]),
          select(
            {
              wrapperClass: "w-44 min-w-0 shrink",
              className: "bg-background md:text-[13px]",
              attributes: [
                h.Id("run-subject"),
                h.Value(Option.getOrElse(openRun.maybeSubjectId, () => "")),
                h.OnChange((subjectId) => Message.SelectedRunSubject({ subjectId })),
              ],
            },
            [
              h.option(
                [h.Value(""), h.Selected(Option.isNone(openRun.maybeSubjectId))],
                [`Choose ${withArticle(entityType)}…`],
              ),
              ...Array.map(subjects, (subject) =>
                runSubjectOptionView(
                  subject,
                  Option.contains(openRun.maybeSubjectId, subject.id),
                  h,
                ),
              ),
            ],
            h,
          ),
        ],
      ),
  });

/** The subject picker and the button that runs the automation's saved version again. */
const runFooterView = (openRun: OpenRun, className: string, h: HtmlBuilder<Message>) =>
  Option.match(
    Option.filter(loadedRun(openRun), ({ run }) => run.workflow.trigger.kind !== "event"),
    {
      onNone: () => h.empty,
      onSome: ({ run }) =>
        h.div(
          [
            componentName("run-footer"),
            h.Class(cn("flex items-center gap-3 border-t bg-sidebar py-3", className)),
          ],
          [
            Option.isSome(runSubjectType(run)) ? runSubjectPickerView(openRun, h) : h.empty,
            RunStart.match(openRun.start, {
              Idle: () => h.empty,
              Starting: () => h.empty,
              Failed: ({ error }) =>
                h.span([h.Role("alert"), h.Class("min-w-0 text-xs text-destructive")], [error]),
            }),
            button(
              {
                onClick: Message.ClickedRunSavedVersion(),
                isDisabled: RunStart.guards.Starting(openRun.start),
                size: "sm",
                className: "ml-auto h-8 shrink-0 px-3",
              },
              RunStart.guards.Starting(openRun.start)
                ? [icon(h, LoaderCircle, "size-3.5 animate-spin", "inline-start"), "Starting…"]
                : [icon(h, Play, "size-3.5", "inline-start"), "Run saved version"],
              h,
            ),
          ],
        ),
    },
  );

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
            [h.Class("flex max-w-2xl flex-col gap-5")],
            [
              h.div(
                [h.Class("flex items-start justify-between gap-4")],
                [
                  panelTitleView("Automation", automationName(openRun), h),
                  editAutomationView(openRun.automationId, h),
                ],
              ),
              h.section(
                [
                  h.AriaLabel("Run progress"),
                  h.Class("overflow-hidden rounded-xl bg-card shadow-card"),
                ],
                [
                  h.div(
                    [h.Class("flex items-start justify-between gap-3 border-b px-5 py-4")],
                    [runHeadingView(openRun, "page", h), savedVersionTagView(false, h)],
                  ),
                  h.div([h.Class("px-5 py-2")], [runBodyView(openRun, model, h)]),
                  runNoticeView(openRun, "px-5", h),
                  runFooterView(openRun, "px-5", h),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );

/** A run beside the overview or the studio, so it can play out while the page stays put. */
export const runPanelView = (model: Model, openRun: OpenRun, h: HtmlBuilder<Message>) =>
  h.aside(
    [
      componentName("run-panel"),
      h.AriaLabel("Run preview"),
      h.Class(
        `flex flex-col border-t bg-background animate-in fade-in slide-in-from-right-2 duration-200 lg:fixed lg:top-12 lg:bottom-0 lg:z-30 lg:w-[22rem] lg:shrink-0 lg:border-t-0 lg:border-l lg:shadow-xl 2xl:static 2xl:min-h-0 2xl:w-[28rem] 2xl:shadow-none lg:right-0`,
      ),
    ],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-3 border-b px-5 py-3.5")],
        [
          runHeadingView(
            openRun,
            Page.guards.Studio(model.page) ? "panelBesideStudio" : "panel",
            h,
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
      h.div([h.Class("flex-1 px-5 py-2 lg:overflow-y-auto")], [runBodyView(openRun, model, h)]),
      runNoticeView(openRun, "px-5", h),
      runFooterView(openRun, "px-5", h),
    ],
  );
