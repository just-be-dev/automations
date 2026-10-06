import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Disclosure } from "@foldkit/ui";
import {
  Bot,
  Check,
  ChevronDown,
  GitBranch,
  Hourglass,
  LoaderCircle,
  OctagonX,
  Scale,
  SkipForward,
  Split,
  UserRound,
  X,
} from "lucide";
import { recordView } from "@/components/record";
import { withArticle } from "@/lib/format";
import { icon, triggerIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Role } from "../../entities.ts";
import {
  type ActionInput,
  type ActionMatch,
  type ActionStep,
  type Comparison,
  checkTimePhrase,
  type Condition,
  describeSchedule,
  offsetPhrase,
  type HumanField,
  type InputSource,
  patternCondition,
  type Permission,
  type Permissions,
  type RunStep,
  type Step,
  type TemplateUse,
  templateParts,
  type Trigger,
  type Workflow,
  workflowRefs,
} from "../../workflow.ts";
import { Message } from "../message.ts";
import {
  type IconNode,
  isSimulated,
  operationIcon,
  operationTitle,
  simulatedTagView,
  tagView,
} from "./operation.ts";
import { chipClass, notifyLabel, stepMetaView } from "./shared.ts";

const subjectRefView = (ref: string, h: HtmlBuilder<Message>) =>
  h.span(
    [h.Class(cn(chipClass, "text-foreground")), h.Title(`Read from the subject: ${ref}`)],
    [ref],
  );

const stepRefClass = cn(chipClass, "text-sand-11");

const refView = (ref: string, h: HtmlBuilder<Message>) => {
  const [root, ...path] = ref.split(".");
  return root === "steps"
    ? h.span(
        [h.Class(stepRefClass), h.Title(`Recorded by step ${path[0] ?? ""}`)],
        [path.join(".")],
      )
    : subjectRefView(ref, h);
};

const templateView = (text: string, h: HtmlBuilder<Message>) =>
  Array.map(templateParts(text), (part) =>
    part.kind === "ref" ? refView(part.ref, h) : part.text,
  );

const joinedViews = (
  items: ReadonlyArray<ReadonlyArray<Html | string>>,
  separator: string,
): ReadonlyArray<Html | string> =>
  Array.flatMap(items, (item, index) => [...(index === 0 ? [] : [separator]), ...item]);

const readsView = (workflow: Workflow, h: HtmlBuilder<Message>) =>
  Array.match(
    Array.filter(workflowRefs(workflow), (ref) => !ref.startsWith("steps.")),
    {
      onEmpty: () => h.empty,
      onNonEmpty: (refs) =>
        h.div(
          [h.Class("flex flex-wrap items-baseline gap-x-2 gap-y-1.5")],
          [
            h.h3([h.Id("trigger-reads"), h.Class("text-muted-foreground")], ["Reads"]),
            h.ul(
              [h.AriaLabelledBy("trigger-reads"), h.Class("flex flex-wrap gap-1.5")],
              Array.map(refs, (ref) => h.keyed("li")(ref, [], [subjectRefView(ref, h)])),
            ),
          ],
        ),
    },
  );

const changedFieldsView = (
  fields: ReadonlyArray<string> | undefined,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> =>
  fields === undefined || Array.isReadonlyArrayEmpty(fields)
    ? ["changes"]
    : [
        "its ",
        ...joinedViews(
          Array.map(fields, (field) => [
            h.span([h.Class(cn(chipClass, "text-foreground"))], [field]),
          ]),
          " or ",
        ),
        " changes",
      ];

const triggerTextView = (trigger: Trigger, h: HtmlBuilder<Message>): ReadonlyArray<Html | string> =>
  Match.value(trigger).pipe(
    Match.discriminatorsExhaustive("kind")({
      manual: (manual) =>
        manual.subject === undefined
          ? ["Manual start"]
          : [`Manual start for ${withArticle(manual.subject)}`],
      entity: (entity) => [
        `When ${withArticle(entity.entity)} is created or `,
        ...changedFieldsView(entity.fields, h),
        ...(entity.when === undefined ? [] : [", and ", ...conditionView(entity.when, h)]),
      ],
      date: (date) => [
        offsetPhrase(date.offset),
        subjectRefView(date.on, h),
        ` ${checkTimePhrase(date.time, date.timezone)}`,
        ...(date.when === undefined ? [] : [", if ", ...conditionView(date.when, h)]),
      ],
      schedule: (schedule) => [
        describeSchedule(schedule),
        ...(schedule.entity === undefined
          ? []
          : [
              `, for each ${schedule.entity.replaceAll("_", " ")}`,
              ...(schedule.when === undefined
                ? []
                : [" where ", ...conditionView(schedule.when, h)]),
            ]),
      ],
    }),
  );

const triggerView = (workflow: Workflow, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("flex gap-3")],
    [
      h.div(
        [h.Class("flex w-[18px] shrink-0 flex-col items-center"), h.AriaHidden(true)],
        [
          icon(h, triggerIcon(workflow.trigger), "mt-[3px] size-[18px] text-muted-foreground"),
          h.div([h.Class("mt-1.5 w-[1.5px] flex-1 bg-rail")]),
        ],
      ),
      h.div(
        [h.Class("flex min-w-0 flex-1 flex-col gap-2 text-sm")],
        [
          h.p([h.Class("leading-6 text-muted-foreground")], triggerTextView(workflow.trigger, h)),
          readsView(workflow, h),
        ],
      ),
    ],
  );

interface StepContext {
  /** Tells apart the same step shown in the draft and in a run beside it. */
  readonly scope: "draft" | "run";
  readonly expandedStepIds: ReadonlyArray<string>;
  readonly maybeRunSteps: Option.Option<Readonly<Record<string, RunStep>>>;
  readonly permissions: Permissions;
  /** The roles permissions can ask, for their labels. */
  readonly roles: ReadonlyArray<Role>;
}

export const workflowView = (
  workflow: Workflow,
  context: Omit<StepContext, "permissions">,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [h.Class("flex max-w-2xl flex-col")],
    [
      triggerView(workflow, h),
      h.ol(
        [h.AriaLabel("Steps"), h.Class("mt-3 flex flex-col gap-3")],
        Array.map(workflow.steps, (step) =>
          stepView(step, { ...context, permissions: workflow.permissions ?? {} }, h),
        ),
      ),
    ],
  );

const stepIcon = (step: Step): IconNode =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      agent: () => Bot,
      action: (action) => operationIcon(action.use),
      wait: () => Hourglass,
      parallel: () => Split,
      if: () => GitBranch,
      decide: () => Scale,
      human: () => UserRound,
      stop: () => OctagonX,
    }),
  );

const stepLabel = (step: Step): string =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      agent: () => "Agent",
      action: (action) => operationTitle(action.use),
      wait: () => "Wait",
      parallel: () => "Parallel",
      if: () => "Condition",
      decide: () => "Decision",
      human: () => "Human",
      stop: () => "Stop",
    }),
  );

const comparisonLabel: Record<Comparison, string> = {
  equals: "is",
  notEquals: "is not",
  greaterThan: "is greater than",
  lessThan: "is less than",
  contains: "contains",
  before: "is before",
  after: "is after",
};

const valueView = (value: unknown, h: HtmlBuilder<Message>) =>
  h.span([h.Class("font-mono text-[0.92em] text-foreground")], [JSON.stringify(value)]);

const comparedValueView = (op: Comparison, value: unknown, h: HtmlBuilder<Message>) =>
  (op === "before" || op === "after") && Predicate.isString(value)
    ? h.span([h.Class("font-mono text-[0.92em] text-foreground")], [value])
    : valueView(value, h);

const joinedConditions = (
  conditions: ReadonlyArray<Condition>,
  separator: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> =>
  joinedViews(
    Array.map(conditions, (condition) => conditionView(condition, h)),
    separator,
  );

const conditionView = (
  condition: Condition,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> => {
  if ("all" in condition) {
    return ["(", ...joinedConditions(condition.all, " and ", h), ")"];
  }
  if ("any" in condition) {
    return ["(", ...joinedConditions(condition.any, " or ", h), ")"];
  }
  if ("not" in condition) {
    return ["not ", ...conditionView(condition.not, h)];
  }
  if (condition.op === "exists") {
    return [refView(condition.ref, h), " is set"];
  }
  return [
    refView(condition.ref, h),
    ` ${comparisonLabel[condition.op]} `,
    comparedValueView(condition.op, condition.value, h),
  ];
};

const offsetText = (offset: string) =>
  offset.startsWith("-") ? `${offset.slice(1)} before ` : `${offset} after `;

const detailClass = (isExpanded: boolean) =>
  cn(
    "text-xs text-muted-foreground",
    isExpanded ? "whitespace-pre-wrap break-words" : "line-clamp-2",
  );

const fieldChipsView = (names: ReadonlyArray<string>, h: HtmlBuilder<Message>) =>
  joinedViews(
    Array.map(names, (name) => [h.span([h.Class(cn(chipClass, "text-foreground"))], [name])]),
    " ",
  );

const actionInputView = (value: ActionInput, h: HtmlBuilder<Message>) =>
  Predicate.isString(value)
    ? templateView(value, h)
    : joinedViews(
        Array.map(value, (item) => templateView(item, h)),
        ", ",
      );

const inputListView = (
  label: string,
  inputs: Readonly<Record<string, ActionInput>>,
  isExpanded: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.ul(
    [h.AriaLabel(label), h.Class("flex flex-col gap-0.5 text-xs")],
    Array.map(Object.entries(inputs), ([name, value]) =>
      h.keyed("li")(
        name,
        [h.Class(cn("text-muted-foreground", isExpanded ? "break-words" : "line-clamp-1"))],
        [h.span([h.Class("font-mono text-sand-11")], [`${name}: `]), ...actionInputView(value, h)],
      ),
    ),
  );

const templateUseView = (use: TemplateUse, h: HtmlBuilder<Message>) =>
  h.p(
    [h.Class("text-xs text-muted-foreground")],
    [
      "Template ",
      h.span([h.Class(cn(chipClass, "text-foreground")), h.Title("A stored template")], [use.use]),
      ...Array.flatMap(Object.entries(use.with), ([slot, value]) => [
        ` · ${slot}: `,
        ...templateView(value, h),
      ]),
    ],
  );

const inputSourceView = (
  label: string,
  source: InputSource,
  isExpanded: boolean,
  h: HtmlBuilder<Message>,
) => [
  source.template === undefined ? h.empty : templateUseView(source.template, h),
  source.with === undefined ? h.empty : inputListView(label, source.with, isExpanded, h),
];

const matchCaseClass = "flex flex-col gap-1 border-l border-border pl-2.5";

const matchView = (
  action: ActionStep,
  match: ActionMatch,
  isExpanded: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.ol(
    [h.AriaLabel(`${action.title} cases`), h.Class("flex flex-col gap-1.5")],
    [
      ...Array.map(match.cases, (branch, index) =>
        h.li(
          [h.Class(matchCaseClass)],
          [
            h.div(
              [h.Class("text-xs text-muted-foreground")],
              ["If ", ...conditionView(patternCondition(match.on, branch.when), h)],
            ),
            ...inputSourceView(`Case ${index + 1} inputs`, branch, isExpanded, h),
          ],
        ),
      ),
      h.li(
        [h.Class(matchCaseClass)],
        [
          h.div([h.Class("text-xs text-muted-foreground")], ["Otherwise"]),
          ...inputSourceView("Otherwise inputs", match.otherwise, isExpanded, h),
        ],
      ),
    ],
  );

const permissionTagView = (
  permission: Permission | undefined,
  roles: ReadonlyArray<Role>,
  h: HtmlBuilder<Message>,
) =>
  permission === undefined || permission === "auto"
    ? h.empty
    : tagView(
        `Asks ${Option.match(
          Array.findFirst(roles, (role) => role.name === permission.ask),
          { onNone: () => permission.ask, onSome: (role) => role.label },
        )}`,
        h,
      );

const humanFieldView = (field: HumanField, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    field.name,
    [],
    [
      h.span([h.Class("text-foreground")], [field.label]),
      ` · ${field.type}`,
      ...(field.default === undefined ? [] : [" · default ", ...templateView(field.default, h)]),
    ],
  );

const stepDetailView = (
  step: Step,
  context: StepContext,
  isExpanded: boolean,
  h: HtmlBuilder<Message>,
) =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      agent: (agent) =>
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            h.p([h.Class(detailClass(isExpanded))], templateView(agent.instruction, h)),
            agent.output === undefined
              ? h.empty
              : stepMetaView(
                  [
                    h.span(
                      [],
                      [
                        "Records ",
                        ...fieldChipsView(
                          Array.map(agent.output.fields, (field) => field.name),
                          h,
                        ),
                      ],
                    ),
                  ],
                  h,
                ),
          ],
        ),
      action: (action) =>
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            h.div(
              [h.Class("flex items-center gap-2 text-xs text-muted-foreground")],
              [
                operationTitle(action.use),
                isSimulated(action.use) ? simulatedTagView(h) : h.empty,
                permissionTagView(context.permissions[action.use], context.roles, h),
              ],
            ),
            inputListView(`${action.title} inputs`, action.with, isExpanded, h),
            action.template === undefined ? h.empty : templateUseView(action.template, h),
            action.match === undefined ? h.empty : matchView(action, action.match, isExpanded, h),
          ],
        ),
      wait: (wait) =>
        h.p(
          [h.Class("text-xs text-muted-foreground")],
          "until" in wait
            ? [
                "Until ",
                wait.offset === undefined ? "" : offsetText(wait.offset),
                refView(wait.until, h),
              ]
            : [`Pauses for ${wait.duration}`],
        ),
      parallel: (parallel) =>
        h.p(
          [h.Class("text-xs text-muted-foreground")],
          [`${parallel.branches.length} branches run at the same time, then the run continues.`],
        ),
      if: () =>
        h.p([h.Class("text-xs text-muted-foreground")], ["Runs the first case that matches."]),
      decide: (decide) =>
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            h.p([h.Class(detailClass(isExpanded))], templateView(decide.question, h)),
            stepMetaView([`Model: ${decide.model}`], h),
          ],
        ),
      stop: (stop) =>
        h.p(
          [h.Class(detailClass(isExpanded))],
          ["Ends the run: ", ...templateView(stop.reason, h)],
        ),
      human: (human) =>
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            h.p([h.Class(detailClass(isExpanded))], templateView(human.prompt, h)),
            stepMetaView(
              [
                ...(human.assignee === undefined
                  ? []
                  : [h.span([], ["Assignee: ", refView(human.assignee, h)])]),
                ...(human.notify === undefined
                  ? []
                  : [`Notifies via ${notifyLabel[human.notify]}`]),
                human.response === "approval" ? "Approve or reject" : "Fills in a form",
                ...(human.timeout === undefined ? [] : [`Times out after ${human.timeout}`]),
              ],
              h,
            ),
            human.response === "approval"
              ? h.empty
              : h.ul(
                  [
                    h.AriaLabel(`${human.title} form`),
                    h.Class("flex flex-col gap-0.5 text-[11px] text-muted-foreground"),
                  ],
                  Array.map(human.response.fields, (field) => humanFieldView(field, h)),
                ),
          ],
        ),
    }),
  );

interface Lane {
  readonly label: string;
  readonly heading: ReadonlyArray<Html | string>;
  readonly steps: ReadonlyArray<Step>;
}

const stepLanes = (step: Step, h: HtmlBuilder<Message>): ReadonlyArray<Lane> =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      agent: () => [],
      action: () => [],
      wait: () => [],
      human: () => [],
      stop: () => [],
      parallel: (parallel) =>
        Array.map(parallel.branches, (steps, index) => ({
          label: `Branch ${index + 1}`,
          heading: [`Branch ${index + 1}`],
          steps,
        })),
      if: (branch) => [
        ...Array.map(branch.cases, (branchCase, index) => ({
          label: `Case ${index + 1}`,
          heading: ["If ", ...conditionView(branchCase.when, h)],
          steps: branchCase.steps,
        })),
        ...(branch.otherwise === undefined || Array.isReadonlyArrayEmpty(branch.otherwise)
          ? []
          : [{ label: "Otherwise", heading: ["Otherwise"], steps: branch.otherwise }]),
      ],
      decide: (decide) =>
        Array.map(decide.options, (option) => ({
          label: `Option ${option.id}`,
          heading: [
            h.span([h.Class("font-mono text-foreground")], [option.id]),
            ` · ${option.description}`,
          ],
          steps: option.steps,
        })),
    }),
  );

const laneView = (lane: Lane, context: StepContext, h: HtmlBuilder<Message>) =>
  h.li(
    [h.Class("flex flex-col gap-2")],
    [
      h.div([h.Class("text-xs text-muted-foreground")], lane.heading),
      h.ol(
        [h.AriaLabel(lane.label), h.Class("rail-start flex flex-col gap-3")],
        Array.map(lane.steps, (step) => stepView(step, context, h)),
      ),
    ],
  );

const stepStatusLabel: Record<RunStep["status"], string> = {
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  declined: "Declined",
  skipped: "Skipped",
};

const stepStatusView = (runStep: RunStep, h: HtmlBuilder<Message>) =>
  h.span(
    [
      h.Class(
        cn(
          "mt-0.5 inline-flex shrink-0 items-center gap-1 text-[11px] font-medium",
          runStep.status === "done" && "text-success",
          runStep.status === "running" && "text-signal",
          runStep.status === "waiting" && "text-sand-11",
          runStep.status === "declined" && "text-destructive",
          runStep.status === "skipped" && "text-muted-foreground",
        ),
      ),
    ],
    [
      Match.value(runStep.status).pipe(
        Match.when("done", () => icon(h, Check, "size-3.5")),
        Match.when("running", () => icon(h, LoaderCircle, "size-3.5 animate-spin")),
        Match.when("waiting", () => icon(h, Hourglass, "size-3.5")),
        Match.when("declined", () => icon(h, X, "size-3.5")),
        Match.when("skipped", () => icon(h, SkipForward, "size-3.5")),
        Match.exhaustive,
      ),
      stepStatusLabel[runStep.status],
    ],
  );

const stepResultView = (
  step: Step,
  record: Schema.Json,
  isExpanded: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [h.Class("flex flex-col gap-1.5")],
    [
      h.div(
        [h.Class("text-[11px] text-muted-foreground")],
        [
          step.kind === "action" && isSimulated(step.use)
            ? "Simulated: nothing was sent. This is what it would have sent."
            : "Result",
        ],
      ),
      h.div(
        [
          h.AriaLabel(`${step.title} result`),
          h.Class("rounded-md bg-sidebar px-3 py-2.5 text-[13px] leading-relaxed"),
        ],
        [recordView(record, isExpanded, h)],
      ),
    ],
  );

const stepView = (step: Step, context: StepContext, h: HtmlBuilder<Message>): Html => {
  const expansionKey = `${context.scope}:${step.id}`;
  const isExpanded = Array.contains(context.expandedStepIds, expansionKey);
  const maybeRunStep = Option.flatMap(context.maybeRunSteps, (runSteps) =>
    Option.fromNullishOr(runSteps[step.id]),
  );
  const isUnreached =
    Option.isSome(context.maybeRunSteps) &&
    !Option.exists(maybeRunStep, (runStep) => runStep.status !== "skipped");
  return h.keyed("li")(
    step.id,
    [
      h.Class(
        cn(
          "rail-item animate-in fade-in slide-in-from-top-1 duration-300",
          isUnreached && "opacity-60",
        ),
      ),
    ],
    [
      Disclosure.view(
        {
          id: `${context.scope}-step-${step.id}`,
          isOpen: isExpanded,
          onToggle: (isOpen) => Message.ToggledStepDetails({ stepId: expansionKey, isOpen }),
          toView: ({ button, panel }) =>
            h.div(
              [h.Class("flex flex-col gap-1")],
              [
                h.button(
                  [
                    ...button,
                    h.Class(
                      "group/step flex w-full cursor-pointer items-start gap-2.5 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    ),
                  ],
                  [
                    h.span(
                      [h.Class("icon-tile"), h.Title(stepLabel(step)), h.AriaHidden(true)],
                      [icon(h, stepIcon(step), "size-3.5")],
                    ),
                    h.span(
                      [h.Class("min-w-0 flex-1 py-0.5 text-sm")],
                      [
                        h.span([h.Class("sr-only")], [`${stepLabel(step)}: `]),
                        ...templateView(step.title, h),
                      ],
                    ),
                    Option.match(maybeRunStep, {
                      onNone: () => h.empty,
                      onSome: (runStep) => stepStatusView(runStep, h),
                    }),
                    icon(
                      h,
                      ChevronDown,
                      "mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover/step:opacity-100 group-focus-visible/step:opacity-100 group-aria-expanded/step:rotate-180 group-aria-expanded/step:opacity-100",
                    ),
                  ],
                ),
                h.div(
                  [...panel, h.Class("flex flex-col gap-2 pl-[34px]")],
                  [
                    stepDetailView(step, context, isExpanded, h),
                    Option.match(
                      Option.flatMap(maybeRunStep, (runStep) =>
                        Option.fromNullishOr(runStep.record),
                      ),
                      {
                        onNone: () => h.empty,
                        onSome: (record) => stepResultView(step, record, isExpanded, h),
                      },
                    ),
                  ],
                ),
                Array.match(stepLanes(step, h), {
                  onEmpty: () => h.empty,
                  onNonEmpty: (lanes) =>
                    h.ul(
                      [h.Class("flex flex-col gap-3 pt-1.5 pl-[34px]")],
                      Array.map(lanes, (lane) => laneView(lane, context, h)),
                    ),
                }),
              ],
            ),
        },
        h,
      ),
    ],
  );
};
