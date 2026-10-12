/** Presents workflow triggers and nested steps in readable terms, with references, conditions, and template usage.
 * Adds step outcomes and recorded results when showing an executed snapshot. */
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
  LayoutTemplate,
  LoaderCircle,
  OctagonX,
  Scale,
  SkipForward,
  Split,
  UserRound,
  X,
} from "lucide";
import { formatText, recordView } from "@/components/record";
import { componentName } from "@/lib/component";
import { labelFromName, withArticle } from "@/lib/format";
import { icon, triggerIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { findOperation, type InputType } from "../../connections.ts";
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
import { templatesHref } from "../route.ts";
import {
  type IconNode,
  isSimulated,
  recordIsSimulated,
  operationIcon,
  operationTitle,
  simulatedTagView,
  tagView,
} from "./operation.ts";
import { chipClass, notifyLabel, stepMetaView } from "./shared.ts";

const subjectRefView = (ref: string, h: HtmlBuilder<Message>) =>
  h.span(
    [
      componentName("subject-ref"),
      h.Class(cn(chipClass, "text-foreground")),
      h.Title(`Read from the subject: ${ref}`),
    ],
    [ref],
  );

const refView = (ref: string, h: HtmlBuilder<Message>) => {
  const source = ref
    .split(".")
    .slice(0, ref.startsWith("steps.") ? 2 : 1)
    .join(".");
  const tone =
    Array.reduce(source.split(""), 0, (sum, character) => sum + character.charCodeAt(0)) % 4;
  return h.span(
    [
      componentName("ref"),
      h.Class("reference-token"),
      h.DataAttribute("tone", String(tone)),
      h.Title(ref),
    ],
    [ref],
  );
};

const templateView = (text: string, h: HtmlBuilder<Message>) =>
  Array.map(templateParts(text), (part) =>
    part.kind === "ref" ? refView(part.ref, h) : part.text,
  );

const readableRefView = (ref: string, h: HtmlBuilder<Message>) =>
  h.span(
    [
      componentName("readable-ref"),
      h.Class("text-foreground underline decoration-sand-8 decoration-dotted underline-offset-4"),
      h.Title(ref),
    ],
    [(ref.startsWith("steps.") ? ref.slice(6) : ref).split(".").map(labelFromName).join(" → ")],
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
          [componentName("reads"), h.Class("flex flex-wrap items-baseline gap-x-2 gap-y-1.5")],
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
      event: (event) => [
        `When ${event.event} occurs`,
        ...(event.subject === undefined ? [] : [` for ${withArticle(event.subject)}`]),
        ...(event.when === undefined ? [] : [", if ", ...conditionView(event.when, h)]),
      ],
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
    [componentName("trigger"), h.Class("flex gap-3")],
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
  /** Connections simulated by default that this deployment really connects. */
  readonly liveConnections: ReadonlyArray<string>;
}

export const workflowView = (
  workflow: Workflow,
  context: Omit<StepContext, "permissions">,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [componentName("workflow"), h.Class("flex max-w-2xl flex-col")],
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

/**
 * A condition as people read it. `not` is pushed down into the comparisons (De Morgan), so it reads
 * "doesn't contain" instead of wrapping a group, and nested groups that join the same way merge.
 */
type ConditionTerm =
  | {
      readonly kind: "test";
      readonly ref: string;
      readonly op: Comparison | "exists";
      readonly isNegated: boolean;
      readonly value: Schema.Json;
    }
  | {
      readonly kind: "group";
      readonly join: "all" | "any";
      readonly terms: ReadonlyArray<ConditionTerm>;
    };

const groupTerm = (
  join: "all" | "any",
  conditions: ReadonlyArray<Condition>,
  isNegated: boolean,
): ConditionTerm => {
  const effectiveJoin = isNegated ? (join === "all" ? "any" : "all") : join;
  const terms = Array.flatMap(conditions, (condition) => {
    const term = conditionTerm(condition, isNegated);
    return term.kind === "group" && term.join === effectiveJoin ? term.terms : [term];
  });
  const [only] = terms;
  return only !== undefined && terms.length === 1
    ? only
    : { kind: "group", join: effectiveJoin, terms };
};

const conditionTerm = (condition: Condition, isNegated = false): ConditionTerm => {
  if ("all" in condition) {
    return groupTerm("all", condition.all, isNegated);
  }
  if ("any" in condition) {
    return groupTerm("any", condition.any, isNegated);
  }
  if ("not" in condition) {
    return conditionTerm(condition.not, !isNegated);
  }
  if (condition.op === "exists") {
    return { kind: "test", ref: condition.ref, op: "exists", isNegated, value: null };
  }
  const swapsOp = isNegated && (condition.op === "equals" || condition.op === "notEquals");
  return {
    kind: "test",
    ref: condition.ref,
    op: swapsOp ? (condition.op === "equals" ? "notEquals" : "equals") : condition.op,
    isNegated: isNegated && !swapsOp,
    value: condition.value,
  };
};

const comparisonLabel: Record<Comparison | "exists", readonly [holds: string, fails: string]> = {
  equals: ["is", "is not"],
  notEquals: ["is not", "is"],
  greaterThan: ["is more than", "is not more than"],
  lessThan: ["is less than", "is not less than"],
  contains: ["contains", "doesn't contain"],
  before: ["is before", "is not before"],
  after: ["is after", "is not after"],
  exists: ["is set", "is not set"],
};

const joinLabel = { all: "and", any: "or" } as const;

/** A value as people read it: text in quotes, dates formatted, and "empty" for null. */
const conditionValueView = (
  op: Comparison | "exists",
  value: Schema.Json,
  h: HtmlBuilder<Message>,
) =>
  Match.value(value).pipe(
    Match.when(Predicate.isString, (text) =>
      (op === "before" || op === "after") && text === "now"
        ? "now"
        : h.span(
            [componentName("condition-value"), h.Class("text-foreground")],
            [op === "before" || op === "after" ? formatText("", text) : `“${text}”`],
          ),
    ),
    Match.when(Predicate.isBoolean, (flag) => (flag ? "true" : "false")),
    Match.when(Predicate.isNull, () => "empty"),
    Match.when(Predicate.isNumber, (number) =>
      h.span([componentName("condition-value"), h.Class("text-foreground")], [String(number)]),
    ),
    Match.orElse((json) =>
      h.span(
        [componentName("condition-value"), h.Class("font-mono text-[0.92em] text-foreground")],
        [JSON.stringify(json)],
      ),
    ),
  );

const testParts = (
  term: Extract<ConditionTerm, { readonly kind: "test" }>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> => [
  comparisonLabel[term.op][term.isNegated ? 1 : 0],
  ...(term.op === "exists" ? [] : [" ", conditionValueView(term.op, term.value, h)]),
];

const joinWordView = (join: "all" | "any", h: HtmlBuilder<Message>) =>
  h.span([h.Class("font-medium text-foreground")], [` ${joinLabel[join]} `]);

const joinedTerms = (
  join: "all" | "any",
  parts: ReadonlyArray<ReadonlyArray<Html | string>>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> =>
  Array.flatMap(parts, (part, index) => [...(index === 0 ? [] : [joinWordView(join, h)]), ...part]);

/** The tests of a group that all read the same ref, which the group can then name once. */
const sharedRefTests = (terms: ReadonlyArray<ConditionTerm>) => {
  const tests = Array.flatMap(terms, (term) => (term.kind === "test" ? [term] : []));
  const [first] = tests;
  return first !== undefined &&
    tests.length === terms.length &&
    Array.every(tests, (test) => test.ref === first.ref)
    ? Option.some({ ref: first.ref, tests })
    : Option.none();
};

const termView = (
  term: ConditionTerm,
  isNested: boolean,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> => {
  if (term.kind === "test") {
    return [readableRefView(term.ref, h), " ", ...testParts(term, h)];
  }
  if (Array.isReadonlyArrayEmpty(term.terms)) {
    return [term.join === "all" ? "always" : "never"];
  }
  const parts = Option.match(sharedRefTests(term.terms), {
    onNone: () =>
      joinedTerms(
        term.join,
        Array.map(term.terms, (inner) => termView(inner, true, h)),
        h,
      ),
    onSome: ({ ref, tests }) => {
      const [first] = tests;
      const isOneComparison =
        first !== undefined &&
        first.op !== "exists" &&
        !first.isNegated &&
        Array.every(tests, (test) => test.op === first.op && !test.isNegated);
      return [
        readableRefView(ref, h),
        " ",
        ...(isOneComparison
          ? [
              comparisonLabel[first.op][0],
              " ",
              ...joinedTerms(
                term.join,
                Array.map(tests, (test) => [conditionValueView(test.op, test.value, h)]),
                h,
              ),
            ]
          : joinedTerms(
              term.join,
              Array.map(tests, (test) => testParts(test, h)),
              h,
            )),
      ];
    },
  });
  return isNested && term.terms.length > 1 ? ["(", ...parts, ")"] : parts;
};

/** A condition on one line, for triggers and short headings. */
const conditionView = (condition: Condition, h: HtmlBuilder<Message>) =>
  termView(conditionTerm(condition), false, h);

const conditionListClass = "mt-1 flex list-disc flex-col gap-1 pl-4 marker:text-sand-9";

/**
 * "If" and a condition. A group of several different tests is listed one per line, so a long
 * condition stays readable.
 */
const ifConditionView = (condition: Condition, h: HtmlBuilder<Message>) => {
  const term = conditionTerm(condition);
  const isListed =
    term.kind === "group" &&
    Option.isNone(sharedRefTests(term.terms)) &&
    (term.terms.length > 2 || Array.some(term.terms, (inner) => inner.kind === "group"));
  return term.kind === "group" && isListed
    ? h.div(
        [componentName("if-condition")],
        [
          term.join === "all" ? "If all of these are true:" : "If at least one of these is true:",
          h.ul(
            [h.Class(conditionListClass)],
            Array.map(term.terms, (inner) => h.li([], termView(inner, false, h))),
          ),
        ],
      )
    : h.div([componentName("if-condition")], ["If ", ...termView(term, false, h)]);
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

const inputTextView = (
  value: string,
  inputType: InputType | undefined,
  h: HtmlBuilder<Message>,
) => {
  const parts = templateParts(value);
  const [date, suffix] = parts;
  const time =
    inputType === "datetime" &&
    parts.length === 2 &&
    date?.kind === "ref" &&
    suffix?.kind === "text"
      ? /^T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
          suffix.text,
        )
      : null;
  if (time !== null && date?.kind === "ref") {
    const hour = Number(time[1]);
    const seconds = time[3] === undefined || time[3] === "00" ? "" : `:${time[3]}`;
    const zone = time[4] === "Z" ? "UTC" : `UTC${time[4]?.replace("-", "−")}`;
    return [
      refView(date.ref, h),
      h.span(
        [h.Title(value)],
        [` at ${hour % 12 || 12}:${time[2]}${seconds} ${hour < 12 ? "AM" : "PM"} (${zone})`],
      ),
    ];
  }
  return templateView(value, h);
};

const actionInputView = (
  value: ActionInput,
  inputType: InputType | undefined,
  h: HtmlBuilder<Message>,
) =>
  Predicate.isString(value)
    ? inputTextView(value, inputType, h)
    : joinedViews(
        Array.map(value, (item) => inputTextView(item, inputType, h)),
        ", ",
      );

const messageCardView = (
  inputs: Readonly<Record<string, ActionInput>>,
  messageField: "text" | "body",
  isExpanded: boolean,
  operationId: string,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [
      componentName("message-card"),
      h.Class("min-w-0 overflow-hidden rounded-lg bg-card shadow-card"),
    ],
    [
      h.div(
        [h.Class("flex flex-col gap-2 px-3.5 py-3")],
        Array.map(
          Object.entries(inputs).filter(([name]) => name !== messageField),
          ([name, value]) =>
            h.keyed("div")(
              name,
              [h.Class("flex flex-wrap items-baseline gap-x-2 gap-y-1")],
              [
                h.span(
                  [h.Class("text-xs text-muted-foreground"), h.Title(name)],
                  [labelFromName(name)],
                ),
                h.span(
                  [h.Class("min-w-0 break-words")],
                  actionInputView(
                    value,
                    findOperation(operationId)?.inputs.find((input) => input.name === name)?.type,
                    h,
                  ),
                ),
              ],
            ),
        ),
      ),
      h.div(
        [h.Class("border-t border-border bg-sand-2 px-3.5 pt-3 pb-3.5")],
        [
          h.div([h.Class("mb-1.5 text-[11px] text-muted-foreground")], ["Message"]),
          h.p(
            [
              h.Class(
                cn("leading-6 break-words whitespace-pre-wrap", !isExpanded && "line-clamp-3"),
              ),
            ],
            actionInputView(inputs[messageField] ?? "", "text", h),
          ),
        ],
      ),
    ],
  );

const inputListView = (
  label: string,
  inputs: Readonly<Record<string, ActionInput>>,
  isExpanded: boolean,
  operationId: string | undefined,
  h: HtmlBuilder<Message>,
) => {
  const messageField =
    operationId === "slack.sendMessage"
      ? "text"
      : operationId === "email.send"
        ? "body"
        : undefined;
  return h.ul(
    [
      componentName("input-list"),
      h.AriaLabel(label),
      h.Class(
        operationId === undefined
          ? "flex flex-col gap-1.5 text-xs"
          : "mt-1 flex flex-col gap-2 text-[13px] leading-[22px]",
      ),
    ],
    messageField !== undefined && inputs[messageField] !== undefined && operationId !== undefined
      ? [h.li([], [messageCardView(inputs, messageField, isExpanded, operationId, h)])]
      : Array.map(Object.entries(inputs), ([name, value]) => {
          const inputType = findOperation(operationId ?? "")?.inputs.find(
            (input) => input.name === name,
          )?.type;
          return h.keyed("li")(
            name,
            [h.Class("grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-2.5")],
            [
              h.span(
                [h.Class("break-words text-xs text-muted-foreground"), h.Title(name)],
                [labelFromName(name)],
              ),
              h.span(
                [
                  h.Class(
                    cn(
                      "min-w-0 text-foreground whitespace-pre-wrap",
                      isExpanded || inputType === "datetime" || Array.isArray(value)
                        ? "break-words"
                        : "line-clamp-1",
                    ),
                  ),
                ],
                actionInputView(value, inputType, h),
              ),
            ],
          );
        }),
  );
};

const templateUseView = (use: TemplateUse, h: HtmlBuilder<Message>) =>
  h.div(
    [
      componentName("template-use"),
      h.Class("min-w-0 overflow-hidden rounded-lg bg-card shadow-card"),
    ],
    [
      h.div(
        [
          h.Class(
            cn(
              "flex flex-wrap items-center gap-x-3 gap-y-2 bg-sand-2 px-3.5 py-3",
              Array.isReadonlyArrayNonEmpty(Object.keys(use.with)) && "border-b border-border",
            ),
          ),
        ],
        [
          h.span([h.Class("text-xs text-muted-foreground")], ["Use template"]),
          h.a(
            [
              h.Href(templatesHref(Option.some(use.use))),
              h.Title(`Open template: ${use.use}`),
              h.AriaLabel(`Open template: ${labelFromName(use.use)}`),
              h.Class(
                "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 text-[13px] leading-5 font-medium text-foreground outline-none hover:bg-sand-4 focus-visible:ring-3 focus-visible:ring-ring/50",
              ),
            ],
            [
              icon(h, LayoutTemplate, "size-3.5 shrink-0"),
              h.span([h.Class("min-w-0 break-words")], [labelFromName(use.use)]),
            ],
          ),
        ],
      ),
      Array.match(Object.entries(use.with), {
        onEmpty: () => h.empty,
        onNonEmpty: () =>
          h.div(
            [h.Class("flex flex-col gap-2 px-3.5 pt-3 pb-3.5")],
            [
              h.div([h.Class("text-[11px] font-normal text-sand-11/90")], ["Inputs"]),
              inputListView(
                `${labelFromName(use.use)} template inputs`,
                use.with,
                true,
                undefined,
                h,
              ),
            ],
          ),
      }),
    ],
  );

const inputSourceView = (
  label: string,
  source: InputSource,
  isExpanded: boolean,
  operationId: string,
  h: HtmlBuilder<Message>,
) => [
  source.template === undefined ? h.empty : templateUseView(source.template, h),
  source.with === undefined
    ? h.empty
    : inputListView(label, source.with, isExpanded, operationId, h),
];

const matchCaseClass = "decision-branch flex min-w-0 flex-col gap-2 pl-6";

const matchView = (
  action: ActionStep,
  match: ActionMatch,
  isExpanded: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.ol(
    [
      componentName("match"),
      h.AriaLabel(`${action.title} cases`),
      h.Class("mt-2 flex flex-col gap-5 text-[13px] leading-[22px] text-foreground"),
    ],
    [
      ...Array.map(match.cases, (branch, index) =>
        h.li(
          [h.Class(matchCaseClass)],
          [
            h.div(
              [h.Class("break-words")],
              [ifConditionView(patternCondition(match.on, branch.when), h)],
            ),
            ...inputSourceView(`Case ${index + 1} inputs`, branch, isExpanded, action.use, h),
          ],
        ),
      ),
      h.li(
        [h.Class(matchCaseClass)],
        [
          h.div([], ["Otherwise"]),
          ...inputSourceView("Otherwise inputs", match.otherwise, isExpanded, action.use, h),
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
    [componentName("human-field")],
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
          [componentName("step-detail"), h.Class("flex flex-col gap-1.5")],
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
          [componentName("step-detail"), h.Class("flex flex-col gap-1.5")],
          [
            h.div(
              [h.Class("flex items-center gap-2 text-xs text-muted-foreground")],
              [
                operationTitle(action.use),
                isSimulated(action.use, context.liveConnections) ? simulatedTagView(h) : h.empty,
                permissionTagView(context.permissions[action.use], context.roles, h),
              ],
            ),
            inputListView(`${action.title} inputs`, action.with, isExpanded, action.use, h),
            action.template === undefined ? h.empty : templateUseView(action.template, h),
            action.match === undefined ? h.empty : matchView(action, action.match, isExpanded, h),
          ],
        ),
      wait: (wait) =>
        h.p(
          [componentName("step-detail"), h.Class("text-xs text-muted-foreground")],
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
          [componentName("step-detail"), h.Class("text-xs text-muted-foreground")],
          [`${parallel.branches.length} branches run at the same time, then the run continues.`],
        ),
      if: () =>
        h.p(
          [componentName("step-detail"), h.Class("text-xs text-muted-foreground")],
          ["Runs the first case that matches."],
        ),
      decide: (decide) =>
        h.div(
          [componentName("step-detail"), h.Class("flex flex-col gap-1.5")],
          [
            h.p([h.Class(detailClass(isExpanded))], templateView(decide.question, h)),
            stepMetaView([`Model: ${decide.model}`], h),
          ],
        ),
      stop: (stop) =>
        h.p(
          [componentName("step-detail"), h.Class(detailClass(isExpanded))],
          ["Ends the run: ", ...templateView(stop.reason, h)],
        ),
      human: (human) =>
        h.div(
          [componentName("step-detail"), h.Class("flex flex-col gap-1.5")],
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
          heading: [ifConditionView(branchCase.when, h)],
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
    [componentName("lane"), h.Class("flex flex-col gap-2")],
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
      componentName("step-status"),
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
    [componentName("step-result"), h.Class("flex flex-col gap-1.5")],
    [
      h.div(
        [h.Class("text-[11px] text-muted-foreground")],
        [
          step.kind === "action" && recordIsSimulated(record)
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
      componentName("step"),
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
