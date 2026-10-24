/** Presents the editable workflow draft, permissions, and recent runs with saving and saved-version launch controls. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { HtmlBuilder } from "foldkit/html";
import { Braces, CircleAlert, LoaderCircle, Play, Workflow as WorkflowIcon } from "lucide";
import { badge } from "@/components/ui/badge";
import { button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { select } from "@/components/ui/select";
import { eventInputView } from "../components/event-input.ts";
import { componentName } from "@/lib/component";
import {
  formatTime,
  openTasksText,
  runDotClass,
  runStatusClass,
  runStatusLabel,
  withArticle,
} from "@/lib/format";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { RunSummary, Workflow } from "../../workflow.ts";
import type { SubjectOption } from "../api.ts";
import { Message } from "../message.ts";
import {
  Activity,
  type Model,
  replyChanges,
  SubjectChoices,
  type WorkflowDisplay,
} from "../model.ts";
import { AssistantPrompt } from "../domain/index.ts";
import { runHref } from "../route.ts";
import { permissionsView } from "./permissions.ts";
import { eyebrowClass, panelTitleView } from "./shared.ts";
import { workflowView } from "./workflow.ts";
import { withAppBase } from "../base-path.ts";

export const workflowPanelView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [componentName("workflow-panel"), h.Class("flex flex-col lg:min-h-0"), h.AriaLabel("Workflow")],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-4 px-6 pt-5")],
        [
          panelTitleView(
            "Draft",
            Option.match(model.maybeDraft, {
              onNone: () => "Untitled workflow",
              onSome: (workflow) => workflow.name,
            }),
            h,
          ),
          workflowDisplayToggleView(model.workflowDisplay, h),
        ],
      ),
      h.div(
        [h.Id("graph"), h.AriaLive("polite"), h.Class("flex-1 px-6 py-6 lg:overflow-y-auto")],
        [draftView(model, h)],
      ),
      Option.match(model.maybeEventInput, {
        onNone: () => h.empty,
        onSome: (value) =>
          Option.match(model.maybeSaved, {
            onNone: () => h.empty,
            onSome: (saved) =>
              saved.trigger.kind !== "event"
                ? h.empty
                : h.div(
                    [h.Class("max-h-[65vh] shrink-0 overflow-y-auto border-t px-6 py-4")],
                    [
                      eventInputView(
                        saved.trigger,
                        value,
                        (message) => Message.GotEventInputMessage({ message }),
                        Activity.guards.Working(model.activity),
                        h,
                      ),
                    ],
                  ),
          }),
      }),
      h.div(
        [h.Class("flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-6 py-3 hub-fab:pl-18")],
        [
          statusView(model, h),
          h.div(
            [h.Class("ml-auto flex flex-wrap items-center gap-2")],
            [
              button(
                {
                  onClick: Message.ClickedSave(),
                  isDisabled: Activity.guards.Working(model.activity),
                  variant: "outline",
                  attributes: [h.Id("save")],
                },
                "Save draft",
                h,
              ),
              subjectPickerView(model, h),
              Option.isSome(model.maybeEventInput)
                ? button(
                    {
                      onClick: Message.ClickedCancelStart(),
                      variant: "ghost",
                      isDisabled: Activity.guards.Working(model.activity),
                    },
                    "Cancel",
                    h,
                  )
                : h.empty,
              button(
                {
                  onClick: Message.ClickedStart(),
                  isDisabled: Activity.guards.Working(model.activity),
                  className: "shadow-card",
                  attributes: [h.Id("start")],
                },
                [
                  icon(h, Play, "size-3.5", "inline-start"),
                  Option.isSome(model.maybeEventInput) ? "Start run" : "Run saved version",
                ],
                h,
              ),
            ],
          ),
        ],
      ),
    ],
  );

const draftView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("draft"), h.Class("flex flex-col gap-10")],
    [
      Option.match(model.maybeDraft, {
        onNone: () => emptyWorkflowView(model.automationId, h),
        onSome: (workflow) =>
          model.workflowDisplay === "Json"
            ? workflowJsonView(workflow, h)
            : workflowView(
                workflow,
                {
                  scope: "draft",
                  expandedStepIds: model.expandedStepIds,
                  liveConnections: model.liveConnections,
                  maybeChanges: replyChanges(model),
                },
                h,
              ),
      }),
      Option.match(model.maybeDraft, {
        onNone: () => h.empty,
        onSome: (workflow) => permissionsView(workflow, model, h),
      }),
      recentRunsView(model, h),
    ],
  );

const subjectPickerView = (model: Model, h: HtmlBuilder<Message>) =>
  SubjectChoices.match(model.subjectChoices, {
    NotNeeded: () => h.empty,
    Loading: ({ entityType }) =>
      h.span(
        [componentName("subject-picker"), h.Class("text-xs text-muted-foreground")],
        [`Loading ${entityType.replaceAll("_", " ")} records…`],
      ),
    Unavailable: ({ entityType, error }) =>
      h.span(
        [componentName("subject-picker"), h.Class("text-xs text-destructive"), h.Title(error)],
        [`Couldn't load ${entityType.replaceAll("_", " ")} records`],
      ),
    Ready: ({ entityType, label, subjects }) =>
      h.div(
        [componentName("subject-picker"), h.Class("flex items-center")],
        [
          h.label([h.For("subject"), h.Class("sr-only")], [label]),
          select(
            {
              wrapperClass: "w-48",
              className: "md:text-[13px]",
              attributes: [
                h.Id("subject"),
                h.Value(Option.getOrElse(model.maybeSubjectId, () => "")),
                h.OnChange((subjectId) => Message.SelectedSubject({ subjectId })),
              ],
            },
            [
              h.option(
                [h.Value(""), h.Selected(Option.isNone(model.maybeSubjectId))],
                [`Choose ${withArticle(entityType)}…`],
              ),
              ...Array.map(subjects, (subject) =>
                subjectOptionView(
                  subject,
                  Option.exists(model.maybeSubjectId, (subjectId) => subjectId === subject.id),
                  h,
                ),
              ),
            ],
            h,
          ),
        ],
      ),
  });

const subjectOptionView = (subject: SubjectOption, isSelected: boolean, h: HtmlBuilder<Message>) =>
  h.keyed("option")(
    subject.id,
    [componentName("subject-option"), h.Value(subject.id), h.Selected(isSelected)],
    [subject.title],
  );

const workflowDisplayToggleView = (display: WorkflowDisplay, h: HtmlBuilder<Message>) =>
  button(
    {
      onClick: Message.SelectedWorkflowDisplay({ display: display === "Json" ? "Steps" : "Json" }),
      variant: display === "Json" ? "secondary" : "ghost",
      size: "xs",
      attributes: [
        componentName("workflow-display-toggle"),
        h.AriaPressed(String(display === "Json")),
        h.Title("Show the draft's raw JSON"),
      ],
    },
    [icon(h, Braces, "size-3", "inline-start"), "JSON"],
    h,
  );

const workflowJsonView = (workflow: Workflow, h: HtmlBuilder<Message>) =>
  h.pre(
    [
      componentName("workflow-json"),
      h.AriaLabel("Draft JSON"),
      h.Class(
        "max-w-3xl overflow-x-auto rounded-[10px] bg-card px-4 py-3 font-mono text-xs leading-relaxed shadow-card",
      ),
    ],
    [JSON.stringify(workflow, null, 2)],
  );

const emptyWorkflowView = (automationId: string, h: HtmlBuilder<Message>) =>
  Empty(
    {
      className: "max-w-xl rounded-[10px] bg-card shadow-card",
      attributes: [componentName("empty-workflow")],
    },
    [
      Empty.header(
        {},
        [
          Empty.media({ className: "icon-tile" }, [icon(h, WorkflowIcon, "size-3.5")], h),
          Empty.title({}, ["No draft yet"], h),
          Empty.description(
            {},
            [
              "Ask the assistant to draft this automation. Steps show up here as it works. They run top to bottom, started by hand or when a record such as an employee changes.",
            ],
            h,
          ),
        ],
        h,
      ),
      Empty.content(
        {},
        [
          button(
            {
              onClick: Message.ClickedAskAssistant({ prompt: AssistantPrompt.draft(automationId) }),
              size: "sm",
            },
            "Ask the assistant",
            h,
          ),
        ],
        h,
      ),
    ],
    h,
  );

const recentRunsView = (model: Model, h: HtmlBuilder<Message>) =>
  Array.match(model.runs, {
    onEmpty: () => h.empty,
    onNonEmpty: (runs) =>
      h.section(
        [
          componentName("recent-runs"),
          h.AriaLabelledBy("recent-runs"),
          h.Class("flex max-w-2xl flex-col gap-2"),
        ],
        [
          h.h3([h.Id("recent-runs"), h.Class(eyebrowClass)], ["Recent runs"]),
          h.ul(
            [h.AriaLabelledBy("recent-runs"), h.Class("-mx-2 flex flex-col")],
            Array.map(runs, (run) =>
              runRowView(
                model.automationId,
                run,
                Option.exists(model.maybeRunPanel, (panel) => panel.runId === run.id),
                h,
              ),
            ),
          ),
        ],
      ),
  });

const runRowView = (
  automationId: string,
  run: RunSummary,
  isOpen: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.keyed("li")(
    run.id,
    [componentName("run-row")],
    [
      h.a(
        [
          h.Href(withAppBase(runHref(automationId, run.id))),
          ...(isOpen ? [h.AriaCurrent("true")] : []),
          h.Class(
            cn(
              "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left text-[13px] transition-colors outline-none hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50",
              isOpen && "bg-hover",
            ),
          ),
        ],
        [
          h.span([
            h.Class(cn("size-1.5 shrink-0 rounded-full", runDotClass[run.status])),
            h.AriaHidden(true),
          ]),
          h.span([h.Class("min-w-0 flex-1 truncate font-medium")], [run.subject ?? "Manual run"]),
          h.span(
            [h.Class(cn("text-xs", runStatusClass[run.status]))],
            [runStatusLabel[run.status]],
          ),
          run.openTasks > 0
            ? badge({ variant: "secondary" }, [openTasksText(run.openTasks)], h)
            : h.empty,
          h.span(
            [h.Class("shrink-0 text-xs text-sand-10 tabular-nums")],
            [formatTime(run.startedAt)],
          ),
        ],
      ),
    ],
  );

const statusView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [
      componentName("status"),
      h.Id("status"),
      h.Role("status"),
      h.Class(
        cn(
          "flex min-w-0 items-center gap-2 text-xs text-muted-foreground",
          Activity.guards.Failed(model.activity) && "text-destructive",
        ),
      ),
    ],
    Activity.match(model.activity, {
      Ready: ({ notice }) => [notice],
      Working: ({ notice }) => [icon(h, LoaderCircle, "size-3.5 animate-spin text-signal"), notice],
      Failed: ({ error }) => [icon(h, CircleAlert, "size-3.5"), error],
    }),
  );
