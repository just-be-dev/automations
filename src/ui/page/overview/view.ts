import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  Play,
  Plus,
  Workflow as WorkflowIcon,
} from "lucide";
import { badge } from "@/components/ui/badge";
import { button, buttonClass } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { inputClass } from "@/components/ui/input";
import { componentName } from "@/lib/component";
import {
  formatTime,
  openTasksText,
  runDotClass,
  runStatusClass,
  runStatusLabel,
  withArticle,
} from "@/lib/format";
import { icon, triggerIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import {
  checkTimePhrase,
  describeSchedule,
  offsetPhrase,
  type RunSummary,
  type Trigger,
} from "../../../workflow.ts";
import { automationHref, runHref } from "../../route.ts";
import { Message } from "./message.ts";
import { type Automation, isRunning, Launch, Listing, type Model, Subjects } from "./model.ts";

const eyebrowClass = "text-xs font-medium text-sand-10";
const noteClass = "text-sm text-muted-foreground";

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [componentName("overview"), h.Class("flex-1 px-6 py-6 lg:min-h-0 lg:overflow-y-auto")],
    [
      h.div(
        [h.Class("flex max-w-3xl flex-col gap-10")],
        [
          h.div(
            [h.Class("flex flex-col gap-1")],
            [
              h.div([h.Class(eyebrowClass)], ["Overview"]),
              h.h1([h.Class("text-xl font-semibold")], ["Runs and automations"]),
            ],
          ),
          ...Listing.match(model.listing, {
            Loading: () => [h.p([h.Class(noteClass)], ["Loading…"])],
            Unavailable: ({ error }) => [
              h.p(
                [h.Role("alert"), h.Class("flex items-center gap-2 text-sm text-destructive")],
                [icon(h, CircleAlert, "size-3.5"), `Couldn't load the overview: ${error}`],
              ),
            ],
            Ready: ({ automations }) =>
              Array.match(automations, {
                onEmpty: () => [noAutomationsView(h)],
                onNonEmpty: (listed) => [
                  activeRunsView(listed, h),
                  automationsView(listed, model.launch, h),
                ],
              }),
          }),
        ],
      ),
    ],
  ),
);

interface ActiveRun {
  readonly automation: Automation;
  readonly run: RunSummary;
}

const activeRunsView = (automations: ReadonlyArray<Automation>, h: HtmlBuilder<Message>) =>
  h.section(
    [componentName("active-runs"), h.AriaLabelledBy("active-runs"), h.Class("flex flex-col gap-2")],
    [
      h.h2([h.Id("active-runs"), h.Class(eyebrowClass)], ["Running now"]),
      Array.match(
        Array.sort(
          Array.flatMap(automations, (automation) =>
            Array.map(automation.activeRuns, (run): ActiveRun => ({ automation, run })),
          ),
          newestFirst,
        ),
        {
          onEmpty: () => h.p([h.Class(noteClass)], ["Nothing is running right now."]),
          onNonEmpty: (activeRuns) =>
            h.ul(
              [h.AriaLabelledBy("active-runs"), h.Class("-mx-2 flex flex-col")],
              Array.map(activeRuns, (activeRun) => activeRunView(activeRun, h)),
            ),
        },
      ),
    ],
  );

const newestFirst = Order.mapInput(
  Order.flip(Order.Number),
  (activeRun: ActiveRun) => activeRun.run.startedAt,
);

const activeRunView = ({ automation, run }: ActiveRun, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    `${automation.id}/${run.id}`,
    [componentName("active-run")],
    [
      h.a(
        [
          h.Href(runHref(automation.id, run.id)),
          h.Class(
            "flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-[13px] transition-colors outline-none hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50",
          ),
        ],
        [
          h.span([
            h.Class(cn("size-1.5 shrink-0 rounded-full", runDotClass[run.status])),
            h.AriaHidden(true),
          ]),
          h.span(
            [h.Class("flex min-w-0 flex-1 items-baseline gap-2")],
            [
              h.span([h.Class("truncate font-medium")], [run.subject ?? "Manual run"]),
              h.span([h.Class("truncate text-xs text-muted-foreground")], [automation.name]),
            ],
          ),
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

const noAutomationsView = (h: HtmlBuilder<Message>) =>
  Empty(
    { className: "items-start rounded-[10px] bg-card p-6 text-left shadow-card" },
    [
      Empty.header(
        { className: "items-start" },
        [
          Empty.media({ className: "icon-tile" }, [icon(h, WorkflowIcon, "size-3.5")], h),
          Empty.title({}, ["No automations yet"], h),
        ],
        h,
      ),
      button(
        { onClick: Message.ClickedNewAutomation(), size: "sm" },
        [icon(h, Plus, "size-3.5", "inline-start"), "New automation"],
        h,
      ),
    ],
    h,
  );

const automationsView = (
  automations: ReadonlyArray<Automation>,
  launch: Launch,
  h: HtmlBuilder<Message>,
) =>
  h.section(
    [componentName("automations"), h.AriaLabelledBy("automations"), h.Class("flex flex-col gap-2")],
    [
      h.h2([h.Id("automations"), h.Class(eyebrowClass)], ["Automations"]),
      h.ul(
        [
          h.AriaLabelledBy("automations"),
          h.Class("flex flex-col divide-y rounded-[10px] bg-card shadow-card"),
        ],
        Array.map(automations, (automation) => automationView(automation, launch, h)),
      ),
    ],
  );

/** The trigger in a phrase, e.g. "When an employee is created or its start_date changes". */
export const triggerSummary = (trigger: Trigger) =>
  Match.value(trigger).pipe(
    Match.discriminatorsExhaustive("kind")({
      manual: (manual) =>
        manual.subject === undefined
          ? "Started by hand"
          : `Started by hand for ${withArticle(manual.subject)}`,
      entity: (entity) => {
        const changes =
          entity.fields === undefined || Array.isReadonlyArrayEmpty(entity.fields)
            ? "changes"
            : `its ${entity.fields.join(" or ")} changes`;
        const condition = entity.when === undefined ? "" : ", if its condition holds";
        return `When ${withArticle(entity.entity)} is created or ${changes}${condition}`;
      },
      date: (date) => {
        const [type = "", ...path] = date.on.split(".");
        const condition = date.when === undefined ? "" : ", if its condition holds";
        return `${offsetPhrase(date.offset)}each ${type.replaceAll("_", " ")}'s ${path.join(".")} ${checkTimePhrase(date.time, date.timezone)}${condition}`;
      },
      schedule: (schedule) => {
        const condition = schedule.when === undefined ? "" : " that meets its condition";
        const each =
          schedule.entity === undefined
            ? ""
            : `, for each ${schedule.entity.replaceAll("_", " ")}${condition}`;
        return `${describeSchedule(schedule)}${each}`;
      },
    }),
  );

const launchFor = (launch: Launch, automationId: string) =>
  Launch.guards.Idle(launch) || launch.automationId !== automationId
    ? Option.none<Launch>()
    : Option.some(launch);

const automationView = (automation: Automation, launch: Launch, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    automation.id,
    [componentName("automation"), h.Class("flex flex-col gap-3 px-4 py-3.5")],
    [
      h.div(
        [h.Class("flex items-start gap-3")],
        [
          h.span(
            [h.Class("icon-tile mt-0.5"), h.AriaHidden(true)],
            [
              icon(
                h,
                Option.match(automation.maybeTrigger, {
                  onNone: () => WorkflowIcon,
                  onSome: triggerIcon,
                }),
                "size-3.5",
              ),
            ],
          ),
          h.div(
            [h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
            [
              h.a(
                [
                  h.Href(automationHref(automation.id)),
                  h.Class(
                    "w-fit truncate rounded-sm text-sm font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50",
                  ),
                ],
                [automation.name],
              ),
              h.p(
                [h.Class("text-xs text-muted-foreground")],
                [
                  Option.match(automation.maybeTrigger, {
                    onNone: () => "Not saved yet. Save it in the studio to run it.",
                    onSome: triggerSummary,
                  }),
                ],
              ),
              nextRunView(automation, h),
              lastRunView(automation, h),
              Option.match(automation.maybeError, {
                onNone: () => h.empty,
                onSome: (error) =>
                  h.p(
                    [h.Class("text-xs text-destructive")],
                    [`Couldn't read this automation: ${error}`],
                  ),
              }),
            ],
          ),
          Option.match(automation.maybeTrigger, {
            onNone: () => h.empty,
            onSome: () =>
              button(
                {
                  onClick: Message.ClickedRunNow({ automationId: automation.id }),
                  isDisabled: Launch.guards.Starting(launch),
                  variant: "outline",
                  size: "sm",
                  attributes: [h.AriaLabel(`Run ${automation.name}`)],
                },
                [icon(h, Play, "size-3.5", "inline-start"), "Run"],
                h,
              ),
          }),
        ],
      ),
      Option.match(launchFor(launch, automation.id), {
        onNone: () => h.empty,
        onSome: (current) => launchView(automation, current, h),
      }),
    ],
  );

const nextRunView = (automation: Automation, h: HtmlBuilder<Message>) =>
  Option.match(automation.maybeNextRunAt, {
    onNone: () => h.empty,
    onSome: (at) =>
      h.p(
        [componentName("next-run"), h.Class("text-xs text-sand-10")],
        [`Next run ${formatTime(at)}`],
      ),
  });

const lastRunView = (automation: Automation, h: HtmlBuilder<Message>) =>
  Option.match(automation.maybeLastRun, {
    onNone: () =>
      Option.isSome(automation.maybeTrigger)
        ? h.p([componentName("last-run"), h.Class("text-xs text-sand-10")], ["No runs yet"])
        : h.empty,
    onSome: (run) =>
      h.p(
        [componentName("last-run"), h.Class("text-xs text-sand-10")],
        [
          `Last run ${formatTime(run.startedAt)} · `,
          h.a(
            [
              h.Href(runHref(automation.id, run.id)),
              h.Class(cn("hover:underline", runStatusClass[run.status])),
            ],
            [runStatusLabel[run.status]],
          ),
          ...(isRunning(automation) ? [` · ${automation.activeRuns.length} in flight`] : []),
        ],
      ),
  });

const launchRowClass = "flex flex-wrap items-center gap-2 pl-[34px] text-xs";

const launchView = (automation: Automation, launch: Launch, h: HtmlBuilder<Message>): Html =>
  Launch.match(launch, {
    Idle: () => h.empty,
    Choosing: ({ entityType, subjects, maybeSubjectId }) =>
      Subjects.match(subjects, {
        Loading: () =>
          h.p(
            [componentName("launch"), h.Class(cn(launchRowClass, "text-muted-foreground"))],
            [`Loading ${entityType.replaceAll("_", " ")} records…`],
          ),
        Unavailable: ({ error }) =>
          h.div(
            [componentName("launch"), h.Class(launchRowClass)],
            [
              h.span(
                [h.Class("text-destructive"), h.Title(error)],
                [`Couldn't load ${entityType.replaceAll("_", " ")} records`],
              ),
              cancelView(h),
            ],
          ),
        Ready: ({ label, subjects: options }) =>
          h.div(
            [componentName("launch"), h.Class(launchRowClass)],
            [
              h.label([h.For(`subject-${automation.id}`), h.Class("sr-only")], [label]),
              h.select(
                [
                  h.Id(`subject-${automation.id}`),
                  h.Value(Option.getOrElse(maybeSubjectId, () => "")),
                  h.OnChange((subjectId) => Message.SelectedSubject({ subjectId })),
                  h.Class(cn(inputClass, "h-7 w-56 bg-background md:text-[13px]")),
                ],
                [
                  h.option(
                    [h.Value(""), h.Selected(Option.isNone(maybeSubjectId))],
                    [`Choose ${withArticle(entityType)}…`],
                  ),
                  ...Array.map(options, (subject) =>
                    h.keyed("option")(
                      subject.id,
                      [
                        h.Value(subject.id),
                        h.Selected(Option.exists(maybeSubjectId, (id) => id === subject.id)),
                      ],
                      [subject.title],
                    ),
                  ),
                ],
              ),
              button(
                {
                  onClick: Message.ClickedStart(),
                  isDisabled: Option.isNone(maybeSubjectId),
                  size: "sm",
                },
                "Start run",
                h,
              ),
              cancelView(h),
            ],
          ),
      }),
    Starting: () =>
      h.p(
        [
          componentName("launch"),
          h.Role("status"),
          h.Class(cn(launchRowClass, "text-muted-foreground")),
        ],
        [icon(h, LoaderCircle, "size-3.5 animate-spin text-signal"), "Starting a run…"],
      ),
    Started: ({ runId }) =>
      h.p(
        [componentName("launch"), h.Role("status"), h.Class(launchRowClass)],
        [
          icon(h, CircleCheck, "size-3.5 text-success"),
          "Run started.",
          h.a(
            [
              h.Href(runHref(automation.id, runId)),
              h.Class(buttonClass({ variant: "link", size: "xs", className: "px-0" })),
            ],
            ["Open run"],
          ),
        ],
      ),
    Failed: ({ error }) =>
      h.p(
        [componentName("launch"), h.Role("alert"), h.Class(cn(launchRowClass, "text-destructive"))],
        [icon(h, CircleAlert, "size-3.5"), error],
      ),
  });

const cancelView = (h: HtmlBuilder<Message>) =>
  button(
    {
      onClick: Message.ClickedCancelStart(),
      variant: "ghost",
      size: "sm",
      attributes: [componentName("cancel")],
    },
    "Cancel",
    h,
  );
