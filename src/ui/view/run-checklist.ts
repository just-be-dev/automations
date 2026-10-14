/** Lists a run's saved plan as a live checklist: a mark and a short summary per step, with each
 * step's details, record, and open task a click or a glance away. */
import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Disclosure } from "@foldkit/ui";
import { Check, ChevronDown, Minus, Play, X } from "lucide";
import { button } from "@/components/ui/button";
import { componentName } from "@/lib/component";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Role } from "../../entities.ts";
import type { Run, Step } from "../../workflow.ts";
import { Message } from "../message.ts";
import type { OpenRun } from "../model.ts";
import { recordIsSimulated, simulatedTagView } from "./operation.ts";
import { type StepMark, shownLaneIndexes, stepMarkLabel, stepProgress } from "./step-summary.ts";
import { openTaskView, taskMetaView } from "./task.ts";
import {
  type Lane,
  type StepContext,
  stepDetailView,
  stepLabel,
  stepLanes,
  stepResultView,
  templateView,
} from "./workflow.ts";

/** A run's wait steps that wait on a clock, and whether one can be resumed now. */
export interface RunWaits {
  /** When each wait step waiting on a clock resumes, by step ID, as the engine scheduled it. */
  readonly resumesAt: Readonly<Record<string, number>>;
  /** Local development, where a wait can be resumed now. */
  readonly canResumeNow: boolean;
  /** A resume or an answer is on its way, so the control waits for it. */
  readonly isBusy: boolean;
}

interface ChecklistContext {
  readonly run: Run;
  readonly openRun: OpenRun;
  readonly step: StepContext;
  readonly waits: RunWaits;
}

const markRingClass = "mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full";

const stepMarkView = (mark: StepMark, h: HtmlBuilder<Message>) =>
  h.span(
    [
      componentName("step-mark"),
      h.AriaHidden(true),
      h.Class(
        cn(
          markRingClass,
          Match.value(mark).pipe(
            Match.when("done", () => "bg-success text-white dark:text-background"),
            Match.when("waiting", () => "ring-[1.5px] ring-attention ring-inset"),
            Match.when(
              "running",
              () => "animate-spin border-[1.5px] border-signal border-t-transparent",
            ),
            Match.when("pending", () => "ring-[1.5px] ring-sand-8 ring-inset"),
            Match.when("skipped", () => "border-[1.5px] border-dashed border-sand-8"),
            Match.when(
              "declined",
              () => "text-destructive ring-[1.5px] ring-destructive ring-inset",
            ),
            Match.when("failed", () => "bg-destructive text-white"),
            Match.when("interrupted", () => "bg-sand-4 text-sand-11"),
            Match.exhaustive,
          ),
        ),
      ),
    ],
    Match.value(mark).pipe(
      Match.when("done", () => [icon(h, Check, "size-3 stroke-[3]")]),
      Match.when("waiting", () => [h.span([h.Class("size-1.5 rounded-full bg-attention")])]),
      Match.when("declined", () => [icon(h, X, "size-3 stroke-[2.5]")]),
      Match.when("failed", () => [icon(h, X, "size-3 stroke-[3]")]),
      Match.when("interrupted", () => [icon(h, Minus, "size-3 stroke-[2.5]")]),
      Match.orElse(() => []),
    ),
  );

const summaryClass: Record<StepMark, string> = {
  done: "text-muted-foreground",
  running: "text-signal",
  waiting: "text-attention",
  declined: "text-destructive",
  skipped: "text-muted-foreground",
  failed: "text-destructive",
  interrupted: "text-muted-foreground",
  pending: "text-muted-foreground",
};

const expansionKey = (step: Step) => `run:${step.id}`;

const openTaskOf = (run: Run, step: Step) =>
  Array.findFirst(run.tasks, (task) => task.step === step.id && task.status === "open");

const closedTaskOf = (run: Run, step: Step) =>
  Array.findLast(run.tasks, (task) => task.step === step.id && task.status === "closed");

/** Local development only: under a row waiting on a clock, a control that resumes it now. */
const waitResumeView = (step: Step, waits: RunWaits, h: HtmlBuilder<Message>) =>
  h.div(
    [
      componentName("wait-resume"),
      h.Class("flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 pb-3 pl-[30px]"),
    ],
    [
      h.span([h.Class("text-[11px] text-muted-foreground")], ["Local dev only"]),
      button(
        {
          onClick: Message.ClickedResumeNow({ step: step.id }),
          isDisabled: waits.isBusy,
          size: "xs",
          className: "bg-dev text-dev-foreground hover:bg-dev/85",
          attributes: [h.AriaLabel(`Resume ${step.title} now`)],
        },
        [icon(h, Play, "size-3", "inline-start"), "Resume now"],
        h,
      ),
    ],
  );

const canResumeNow = (step: Step, context: ChecklistContext) =>
  context.waits.canResumeNow &&
  context.run.steps[step.id]?.status === "waiting" &&
  context.waits.resumesAt[step.id] !== undefined;

const stepRowDetailView = (step: Step, context: ChecklistContext, h: HtmlBuilder<Message>) => {
  const runStep = context.run.steps[step.id];
  return h.div(
    [componentName("step-row-detail"), h.Class("flex flex-col gap-2.5 pb-3 pl-[30px]")],
    [
      stepDetailView(step, context.step, true, h),
      Option.match(closedTaskOf(context.run, step), {
        onNone: () => h.empty,
        onSome: (task) => taskMetaView(task, context.step.liveConnections, h),
      }),
      Option.match(Option.fromNullishOr(runStep?.record), {
        onNone: () => h.empty,
        onSome: (record) => stepResultView(step, record, true, h),
      }),
    ],
  );
};

const laneView = (lane: Lane, context: ChecklistContext, h: HtmlBuilder<Message>) =>
  h.li(
    [componentName("run-lane"), h.Class("flex flex-col")],
    [
      h.div([h.Class("pt-1 text-xs text-muted-foreground")], lane.heading),
      h.ol(
        [h.AriaLabel(lane.label), h.Class("flex flex-col")],
        Array.map(lane.steps, (step) => stepRowView(step, context, h)),
      ),
    ],
  );

const lanesView = (step: Step, context: ChecklistContext, h: HtmlBuilder<Message>) => {
  const lanes = stepLanes(step, h);
  return Array.match(
    Array.flatMap(shownLaneIndexes(step, context.run, lanes.length), (index) => {
      const lane = lanes[index];
      return lane === undefined ? [] : [lane];
    }),
    {
      onEmpty: () => h.empty,
      onNonEmpty: (shown) =>
        h.ul(
          [h.Class("flex flex-col gap-1 pb-1 pl-[30px]")],
          Array.map(shown, (lane) => laneView(lane, context, h)),
        ),
    },
  );
};

const stepRowView = (step: Step, context: ChecklistContext, h: HtmlBuilder<Message>): Html => {
  const { mark, maybeSummary } = stepProgress(step, context.run, context.waits.resumesAt);
  const runStep = context.run.steps[step.id];
  const isSimulated =
    runStep?.status === "done" && step.kind === "action" && recordIsSimulated(runStep.record);
  const isExpanded = Array.contains(context.step.expandedStepIds, expansionKey(step));
  return h.keyed("li")(
    step.id,
    [componentName("step-row"), h.Class("border-b border-border last:border-b-0")],
    [
      Disclosure.view(
        {
          id: `run-step-${step.id}`,
          isOpen: isExpanded,
          onToggle: (isOpen) => Message.ToggledStepDetails({ stepId: expansionKey(step), isOpen }),
          toView: ({ button, panel, animatePanel }) =>
            h.div(
              [],
              [
                h.button(
                  [
                    ...button,
                    h.Class(
                      "group/row -mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-start gap-3 rounded-md px-2 py-2.5 text-left outline-none hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50",
                    ),
                  ],
                  [
                    stepMarkView(mark, h),
                    h.span(
                      [
                        h.Class(
                          cn(
                            "min-w-0 flex-1 text-sm leading-5 break-words",
                            mark === "pending" || mark === "skipped"
                              ? "text-muted-foreground"
                              : "text-foreground",
                          ),
                        ),
                      ],
                      [
                        h.span([h.Class("sr-only")], [`${stepLabel(step)}: `]),
                        ...templateView(step.title, h),
                        h.span([h.Class("sr-only")], [`, ${stepMarkLabel[mark]}`]),
                      ],
                    ),
                    isSimulated
                      ? h.span([h.Class("mt-0.5 flex shrink-0")], [simulatedTagView(h)])
                      : h.empty,
                    Option.match(maybeSummary, {
                      onNone: () => h.empty,
                      onSome: (summary) =>
                        h.span(
                          [
                            h.Class(
                              cn(
                                "max-w-[45%] shrink-0 text-right text-[13px] leading-5 text-balance",
                                summaryClass[mark],
                              ),
                            ),
                          ],
                          [h.span([h.Class("sr-only")], [", "]), summary],
                        ),
                    }),
                    icon(
                      h,
                      ChevronDown,
                      "mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover/row:opacity-100 group-focus-visible/row:opacity-100 group-aria-expanded/row:rotate-180 group-aria-expanded/row:opacity-100",
                    ),
                  ],
                ),
                h.div([...panel], [animatePanel(stepRowDetailView(step, context, h))]),
              ],
            ),
        },
        h,
      ),
      Option.match(openTaskOf(context.run, step), {
        onNone: () => h.empty,
        onSome: (task) =>
          h.div(
            [h.Class("pb-3 pl-[30px]")],
            [openTaskView(task, context.openRun, context.step.liveConnections, h)],
          ),
      }),
      canResumeNow(step, context) ? waitResumeView(step, context.waits, h) : h.empty,
      lanesView(step, context, h),
    ],
  );
};

/** Every step of the run's saved plan, in plan order, including those it hasn't reached. */
export const runChecklistView = (
  run: Run,
  openRun: OpenRun,
  options: {
    readonly expandedStepIds: ReadonlyArray<string>;
    readonly roles: ReadonlyArray<Role>;
    readonly liveConnections: ReadonlyArray<string>;
    readonly waits: RunWaits;
  },
  h: HtmlBuilder<Message>,
) => {
  const context: ChecklistContext = {
    run,
    openRun,
    step: {
      scope: "run",
      expandedStepIds: options.expandedStepIds,
      permissions: run.workflow.permissions ?? {},
      roles: options.roles,
      liveConnections: options.liveConnections,
    },
    waits: options.waits,
  };
  return h.ol(
    [componentName("run-checklist"), h.AriaLabel("Steps"), h.Class("flex flex-col")],
    Array.map(run.workflow.steps, (step) => stepRowView(step, context, h)),
  );
};
