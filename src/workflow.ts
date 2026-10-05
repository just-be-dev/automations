import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { EntityName, Subject } from "./entities.ts";

export class InvalidWorkflow extends Schema.TaggedError<InvalidWorkflow>()("InvalidWorkflow", {
  message: Schema.String,
}) {}

const NonBlank = (message: string, maxLength: number) =>
  Schema.String.check(
    Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= maxLength, {
      message,
    }),
  );

const Identifier = (pattern: RegExp, message: string) =>
  Schema.String.check(Schema.isPattern(pattern, { message }));

const privateHost = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * The SSRF boundary for `http.post`: HTTPS, no credentials, and no private or loopback host. The
 * workflow checker applies it to the URL a step names, and the runner applies it again before
 * sending.
 */
export const isPublicHttpsUrl = (value: string) => {
  const url = URL.parse(value);
  return (
    url !== null &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !privateHost.test(url.hostname)
  );
};

const StepId = Identifier(/^[a-zA-Z0-9_-]{1,40}$/, "Step IDs must be unique identifiers");
const StepTitle = NonBlank("A step title is required", 120);

const durationMessage = 'Durations look like "30 minutes", "3 days", or "2 weeks"';
const durationSyntax = /^(-?\d{1,4}) (minute|hour|day|week)s?$/;
const unitMillis: Readonly<Record<string, number>> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/** Milliseconds in a `Duration` or `Offset` the schema already accepted. */
export const durationMillis = (text: string) => {
  const [, amount = "0", unit = "minute"] = durationSyntax.exec(text) ?? [];
  return Number(amount) * (unitMillis[unit] ?? 0);
};
export const isDuration = (text: string) => /^\d{1,4} (minute|hour|day|week)s?$/.test(text);
/** A wait or timeout, written in Effect's `Duration` syntax. */
const Duration = Identifier(/^\d{1,4} (minute|hour|day|week)s?$/, durationMessage);
/** An offset from a date, such as "-7 days" for a week before it. */
const Offset = Identifier(/^-?\d{1,4} (minute|hour|day|week)s?$/, durationMessage);

/**
 * A path into what a run knows. Its root is either the trigger's entity type, which reads the
 * run's subject (`employee.start_date`, or `employee.manager.email` through a `ref` field), or
 * `steps`, which reads what an earlier step recorded (`steps.approve.approved`).
 */
const refSource = "[a-z][a-z0-9_]{0,39}(?:\\.[a-zA-Z0-9_$-]{1,40}){0,5}";
const refSyntax = new RegExp(`^${refSource}$`);
const wrappedRef = /^\{\{\s*(.*?)\s*\}\}$/;

/** The designer sometimes writes a ref the way it writes templates (`{{employee.email}}`). */
const unwrapRef = (value: string) => {
  const trimmed = value.trim();
  return wrappedRef.exec(trimmed)?.[1] ?? trimmed;
};

export const Ref = Schema.String.pipe(
  Schema.decodeTo(
    Identifier(
      refSyntax,
      "References are dotted paths that start with the trigger's entity type or steps., such as employee.start_date or steps.approve.approved",
    ),
    SchemaTransformation.transform({ decode: unwrapRef, encode: (ref: string) => ref }),
  ),
);

/** `{{ref}}` placeholders in text. Splitting on it puts every ref at an odd index. */
const templateSyntax = new RegExp(`\\{\\{\\s*(${refSource})\\s*\\}\\}`);

export type TemplatePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ref"; readonly ref: string };

export const templateParts = (text: string): ReadonlyArray<TemplatePart> =>
  text
    .split(templateSyntax)
    .flatMap((part, index): ReadonlyArray<TemplatePart> =>
      index % 2 === 1 ? [{ kind: "ref", ref: part }] : part ? [{ kind: "text", text: part }] : [],
    );

export const templateRefs = (text: string) =>
  templateParts(text).flatMap((part) => (part.kind === "ref" ? [part.ref] : []));

/** The ref a value consists of, when it is exactly one `{{ref}}`. */
export const loneRef = (text: string): string | undefined => {
  const parts = templateParts(text.trim());
  return parts.length === 1 && parts[0]?.kind === "ref" ? parts[0].ref : undefined;
};

/** How a resolved value reads inside text: entities by their `$title`, other JSON as JSON. */
export const displayValue = (value: Schema.Json): string => {
  if (typeof value === "string") {
    return value;
  }
  const title =
    typeof value === "object" && value !== null
      ? Object.getOwnPropertyDescriptor(value, "$title")?.value
      : undefined;
  if (typeof title === "string") {
    return title;
  }
  if (Array.isArray(value)) {
    return value.map(displayValue).join(", ");
  }
  return JSON.stringify(value);
};

/** Fills each `{{ref}}` from resolved values, leaving refs without a value as written. */
export const renderTemplate = (text: string, values: Readonly<Record<string, Schema.Json>>) =>
  templateParts(text)
    .map((part) => {
      if (part.kind === "text") {
        return part.text;
      }
      const value = values[part.ref];
      return value === undefined || value === null ? `{{${part.ref}}}` : displayValue(value);
    })
    .join("");

export type Comparison =
  | "equals"
  | "notEquals"
  | "greaterThan"
  | "lessThan"
  | "contains"
  | "before"
  | "after";

/**
 * A deterministic check against what the run knows. `before` and `after` compare dates; their
 * value is a date or `"now"`.
 */
export type Condition =
  | { readonly ref: string; readonly op: Comparison; readonly value: Schema.Json }
  | { readonly ref: string; readonly op: "exists" }
  | { readonly all: ReadonlyArray<Condition> }
  | { readonly any: ReadonlyArray<Condition> }
  | { readonly not: Condition };

const Conditions = Schema.Array(Schema.suspend((): Schema.Codec<Condition> => Condition));

export const Condition: Schema.Codec<Condition> = Schema.Union([
  Schema.Struct({
    ref: Ref,
    op: Schema.Literals([
      "equals",
      "notEquals",
      "greaterThan",
      "lessThan",
      "contains",
      "before",
      "after",
    ]),
    value: Schema.Json,
  }),
  Schema.Struct({ ref: Ref, op: Schema.Literal("exists") }),
  Schema.Struct({ all: Conditions }),
  Schema.Struct({ any: Conditions }),
  Schema.Struct({ not: Schema.suspend((): Schema.Codec<Condition> => Condition) }),
]);

export const conditionRefs = (condition: Condition): ReadonlyArray<string> =>
  "ref" in condition
    ? [condition.ref]
    : "all" in condition
      ? condition.all.flatMap(conditionRefs)
      : "any" in condition
        ? condition.any.flatMap(conditionRefs)
        : conditionRefs(condition.not);

/** Whether evaluating the condition needs the current time. */
export const usesNow = (condition: Condition): boolean =>
  "ref" in condition
    ? condition.op !== "exists" && condition.value === "now"
    : "all" in condition
      ? condition.all.some(usesNow)
      : "any" in condition
        ? condition.any.some(usesNow)
        : usesNow(condition.not);

/** Starts a run by hand, optionally about one entity of `subject` type that the starter picks. */
export const ManualTrigger = Schema.Struct({
  kind: Schema.Literal("manual"),
  subject: Schema.optionalKey(EntityName),
});

/**
 * Starts a run when an entity of type `entity` is created, or when one of `fields` changes (any
 * field when omitted), and `when` holds for the new version. The entity becomes the run's subject.
 */
export const EntityTrigger = Schema.Struct({
  kind: Schema.Literal("entity"),
  entity: EntityName,
  fields: Schema.optionalKey(Schema.Array(EntityName)),
  when: Schema.optionalKey(Condition),
});

export const Trigger = Schema.Union([ManualTrigger, EntityTrigger]);
export type Trigger = typeof Trigger.Type;

/** The entity type a run is about, which is also the root of refs to it. */
export const subjectType = (trigger: Trigger) =>
  trigger.kind === "entity" ? trigger.entity : trigger.subject;

export const ValueType = Schema.Literals(["text", "number", "boolean", "date", "datetime"]);
export type ValueType = typeof ValueType.Type;

/** Whether a value fits a field type. Dates are `YYYY-MM-DD`; datetimes are anything `Date.parse` reads. */
export const valueMatches = (type: ValueType, value: unknown) => {
  switch (type) {
    case "text":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(value))
      );
    case "datetime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
  }
};

const FieldName = Identifier(/^[a-z][a-z0-9_]{0,39}$/, "Field names are snake_case identifiers");

/** A field an agent fills in when its step asks for structured output. */
export const OutputField = Schema.Struct({
  name: FieldName,
  type: ValueType,
  description: Schema.optionalKey(NonBlank("A field description can't be blank", 300)),
});
export interface OutputField extends Schema.Schema.Type<typeof OutputField> {}

/**
 * An AI agent carries out the instruction. With `output`, it answers with those fields and the
 * step records `{ output: { field: value } }`; otherwise it records `{ output: text }`.
 */
export const AgentStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("agent"),
  instruction: NonBlank("An agent step needs an instruction", 4000),
  output: Schema.optionalKey(
    Schema.Struct({ fields: Schema.Array(OutputField).check(Schema.isMinLength(1)) }),
  ),
});
export interface AgentStep extends Schema.Schema.Type<typeof AgentStep> {}

const ActionInput = Schema.Union([
  Schema.String.check(Schema.isMaxLength(4000)),
  Schema.Array(Schema.String.check(Schema.isMaxLength(400))).check(Schema.isMaxLength(20)),
]);
export type ActionInput = typeof ActionInput.Type;

/** Performs one operation of a connection, such as `slack.sendMessage`. */
export const ActionStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("action"),
  use: Identifier(/^[a-z]+\.[a-zA-Z]+$/, 'An action uses an operation such as "email.send"'),
  with: Schema.Record(Identifier(/^[a-zA-Z]{1,40}$/, "Input names are identifiers"), ActionInput),
});
export interface ActionStep extends Schema.Schema.Type<typeof ActionStep> {}

export const WaitForStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("wait"),
  duration: Duration,
});
export interface WaitForStep extends Schema.Schema.Type<typeof WaitForStep> {}

/** Waits until a date the run knows, shifted by `offset`. */
export const WaitUntilStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("wait"),
  until: Ref,
  offset: Schema.optionalKey(Offset),
});
export interface WaitUntilStep extends Schema.Schema.Type<typeof WaitUntilStep> {}

/** Runs every branch at the same time and continues once all of them finish. */
export interface ParallelStep {
  readonly id: string;
  readonly title: string;
  readonly kind: "parallel";
  readonly branches: ReadonlyArray<ReadonlyArray<Step>>;
}

/** Runs the steps of the first case whose condition holds, or `otherwise`. */
export interface IfStep {
  readonly id: string;
  readonly title: string;
  readonly kind: "if";
  readonly cases: ReadonlyArray<{ readonly when: Condition; readonly steps: ReadonlyArray<Step> }>;
  readonly otherwise?: ReadonlyArray<Step>;
}

export const DecisionModel = Schema.Literals(["clef", "clef-flash", "jev"]);
export type DecisionModel = typeof DecisionModel.Type;

/** Asks a decision model to pick one option given the run so far, then runs that option's steps. */
export interface DecideStep {
  readonly id: string;
  readonly title: string;
  readonly kind: "decide";
  readonly model: DecisionModel;
  readonly question: string;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly description: string;
    readonly steps: ReadonlyArray<Step>;
  }>;
}

export const HumanField = Schema.Struct({
  name: FieldName,
  label: NonBlank("A field label is required", 120),
  type: ValueType,
  /** A prefilled answer the person can keep or change, often a `{{ref}}` an agent proposed. */
  default: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
});
export interface HumanField extends Schema.Schema.Type<typeof HumanField> {}

export const HumanResponseSpec = Schema.Union([
  Schema.Literal("approval"),
  Schema.Struct({ fields: Schema.Array(HumanField).check(Schema.isMinLength(1)) }),
]);
export type HumanResponseSpec = typeof HumanResponseSpec.Type;

/**
 * Pauses the run until a person approves, rejects, or fills in a form, or `timeout` passes.
 * `assignee` is a ref to the person, such as `employee.manager`; `notify` also sends them the
 * request over a connection.
 */
export const HumanStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("human"),
  prompt: NonBlank("A human step needs a prompt", 4000),
  assignee: Schema.optionalKey(Ref),
  notify: Schema.optionalKey(Schema.Literals(["email", "slack"])),
  response: HumanResponseSpec,
  timeout: Schema.optionalKey(Duration),
});
export interface HumanStep extends Schema.Schema.Type<typeof HumanStep> {}

export type Step =
  | AgentStep
  | ActionStep
  | WaitForStep
  | WaitUntilStep
  | ParallelStep
  | IfStep
  | DecideStep
  | HumanStep;

const Steps = Schema.Array(Schema.suspend((): Schema.Codec<Step> => Step));

const between = (min: number, max: number, message: string) =>
  Schema.makeFilter(
    (values: ReadonlyArray<unknown>) => values.length >= min && values.length <= max,
    { message },
  );

export const ParallelStep: Schema.Codec<ParallelStep> = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("parallel"),
  branches: Schema.Array(Steps.check(between(1, 20, "A branch needs 1–20 steps"))).check(
    between(2, 8, "A parallel step needs 2–8 branches"),
  ),
});

export const IfStep: Schema.Codec<IfStep> = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("if"),
  cases: Schema.Array(Schema.Struct({ when: Condition, steps: Steps })).check(
    between(1, 8, "An if step needs 1–8 cases"),
  ),
  otherwise: Schema.optionalKey(Steps),
});

export const DecideStep: Schema.Codec<DecideStep> = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("decide"),
  model: DecisionModel,
  question: NonBlank("A decide step needs a question", 2000),
  options: Schema.Array(
    Schema.Struct({
      id: StepId,
      description: NonBlank("Each option needs a description", 500),
      steps: Steps,
    }),
  ).check(
    between(2, 8, "A decide step needs 2–8 options"),
    Schema.makeFilter(
      (options: ReadonlyArray<{ readonly id: string }>) =>
        new Set(options.map((option) => option.id)).size === options.length,
      { message: "Option IDs must be unique within a decide step" },
    ),
  ),
});

export const Step: Schema.Codec<Step> = Schema.Union([
  AgentStep,
  ActionStep,
  WaitForStep,
  WaitUntilStep,
  ParallelStep,
  IfStep,
  DecideStep,
  HumanStep,
]);

/** The step sequences nested directly inside a step. */
export const childSequences = (step: Step): ReadonlyArray<ReadonlyArray<Step>> => {
  switch (step.kind) {
    case "parallel":
      return step.branches;
    case "if":
      return [...step.cases.map((branch) => branch.steps), step.otherwise ?? []];
    case "decide":
      return step.options.map((option) => option.steps);
    default:
      return [];
  }
};

/** Every step in the tree, parents before their children. */
export const flattenSteps = (steps: ReadonlyArray<Step>): ReadonlyArray<Step> =>
  steps.flatMap((step) => [step, ...childSequences(step).flatMap(flattenSteps)]);

const depth = (steps: ReadonlyArray<Step>): number =>
  Math.max(0, ...steps.map((step) => 1 + Math.max(0, ...childSequences(step).map(depth))));

const actionInputText = (value: ActionInput): ReadonlyArray<string> =>
  typeof value === "string" ? [value] : value;

const humanFieldDefaults = (step: HumanStep) =>
  step.response === "approval"
    ? []
    : step.response.fields.flatMap((field) => (field.default === undefined ? [] : [field.default]));

/** The text of a step that may hold `{{ref}}` templates, not counting nested steps. */
export const stepTemplates = (step: Step): ReadonlyArray<string> => {
  switch (step.kind) {
    case "agent":
      return [step.title, step.instruction];
    case "action":
      return [step.title, ...Object.values(step.with).flatMap(actionInputText)];
    case "decide":
      return [step.title, step.question];
    case "human":
      return [step.title, step.prompt, ...humanFieldDefaults(step)];
    default:
      return [step.title];
  }
};

/** Every ref a step reads itself, in templates and fields, not counting nested steps. */
export const stepRefs = (step: Step): ReadonlyArray<string> => [
  ...new Set([
    ...stepTemplates(step).flatMap(templateRefs),
    ...(step.kind === "wait" && "until" in step ? [step.until] : []),
    ...(step.kind === "if" ? step.cases.flatMap((branch) => conditionRefs(branch.when)) : []),
    ...(step.kind === "human" && step.assignee !== undefined ? [step.assignee] : []),
  ]),
];

/** Every ref the workflow reads, in order of first use, the trigger's condition included. */
export const workflowRefs = (workflow: Pick<Workflow, "trigger" | "steps">) => [
  ...new Set([
    ...(workflow.trigger.kind === "entity" && workflow.trigger.when !== undefined
      ? conditionRefs(workflow.trigger.when)
      : []),
    ...flattenSteps(workflow.steps).flatMap(stepRefs),
  ]),
];

const MAX_STEPS = 60;
const MAX_DEPTH = 4;

const hasUniqueIds = (steps: ReadonlyArray<Step>) => {
  const all = flattenSteps(steps);
  return new Set(all.map((step) => step.id)).size === all.length;
};

export const Workflow = Schema.Struct({
  name: NonBlank("A name is required (maximum 120 characters)", 120),
  trigger: Trigger,
  steps: Steps.check(
    between(1, 20, "A workflow needs 1–20 steps"),
    Schema.makeFilter((steps: ReadonlyArray<Step>) => flattenSteps(steps).length <= MAX_STEPS, {
      message: `A workflow can have at most ${MAX_STEPS} steps in total`,
    }),
    Schema.makeFilter((steps: ReadonlyArray<Step>) => depth(steps) <= MAX_DEPTH, {
      message: `Steps can nest at most ${MAX_DEPTH} levels deep`,
    }),
    Schema.makeFilter(hasUniqueIds, { message: "Step IDs must be unique identifiers" }),
  ),
});
export interface Workflow extends Schema.Schema.Type<typeof Workflow> {}

export const Draft = Schema.Struct({
  reply: NonBlank("Agent did not provide a reply", 8000),
  workflow: Workflow,
});
export interface Draft extends Schema.Schema.Type<typeof Draft> {}

/** One chat turn, stored so the studio can show the conversation again after a reload. */
export const Exchange = Schema.Struct({ prompt: Schema.String, reply: Schema.String });
export interface Exchange extends Schema.Schema.Type<typeof Exchange> {}

/**
 * A design message the agent is still answering, or the last one it couldn't answer. It lives in
 * storage until the reply is written, so a reload can show it and keep waiting.
 */
export const PendingChat = Schema.Union([
  Schema.Struct({ id: Schema.String, prompt: Schema.String, status: Schema.Literal("working") }),
  Schema.Struct({
    id: Schema.String,
    prompt: Schema.String,
    status: Schema.Literal("failed"),
    error: Schema.String,
  }),
]);
export type PendingChat = typeof PendingChat.Type;

/** An automation's entry in the index that backs `GET /api/automations`. */
export const AutomationSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  updatedAt: Schema.Finite,
});
export interface AutomationSummary extends Schema.Schema.Type<typeof AutomationSummary> {}

/** Where one step of a run stands. `waiting` is a step parked on a clock or a person. */
export const RunStep = Schema.Struct({
  status: Schema.Literals(["running", "waiting", "done"]),
  record: Schema.optionalKey(Schema.Json),
});
export interface RunStep extends Schema.Schema.Type<typeof RunStep> {}

/** A human step's request, as the studio shows it to the person who answers. */
export const HumanTask = Schema.Struct({
  step: Schema.String,
  token: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  assignee: Schema.NullOr(Schema.Json),
  response: HumanResponseSpec,
  /** Prefilled answers, by field name, with their templates already filled in. */
  defaults: Schema.Record(Schema.String, Schema.String),
  /** The connection that also delivered the request. */
  notify: Schema.optionalKey(Schema.Literals(["email", "slack"])),
  status: Schema.Literals(["open", "closed"]),
});
export interface HumanTask extends Schema.Schema.Type<typeof HumanTask> {}

export const RunStatus = Schema.Literals(["running", "waiting", "completed", "failed"]);
export type RunStatus = typeof RunStatus.Type;

/** A run as persisted in the automation's Durable Object storage. */
export const Run = Schema.Struct({
  id: Schema.String,
  workflow: Workflow,
  subject: Schema.NullOr(Subject),
  status: RunStatus,
  steps: Schema.Record(Schema.String, RunStep),
  tasks: Schema.Array(HumanTask),
  error: Schema.optionalKey(Schema.String),
  startedAt: Schema.Finite,
  /** The pi conversation the run's agent steps share. */
  conversation: Schema.optionalKey(Schema.Int),
});
export interface Run extends Schema.Schema.Type<typeof Run> {}

/** A run as the studio lists it. */
export const RunSummary = Schema.Struct({
  id: Schema.String,
  status: RunStatus,
  startedAt: Schema.Finite,
  subject: Schema.NullOr(Schema.String),
  openTasks: Schema.Int,
});
export interface RunSummary extends Schema.Schema.Type<typeof RunSummary> {}

const invalid = (error: Schema.SchemaError) => new InvalidWorkflow({ message: error.message });

export const decodeWorkflow = (value: unknown) =>
  Schema.decodeUnknownEffect(Workflow)(value).pipe(Effect.mapError(invalid));

const DraftFromJson = Schema.fromJsonString(Draft);

/** Parses the designer agent's reply, tolerating a Markdown code fence around the JSON. */
export const decodeDraft = (text: string) =>
  Schema.decodeEffect(DraftFromJson)(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")).pipe(
    Effect.mapError(invalid),
  );

/** What a run knows so far: its subject, and what each finished step recorded under its ID. */
export const RunState = Schema.Struct({
  runId: Schema.String,
  subject: Schema.NullOr(Subject),
  steps: Schema.Record(Schema.String, Schema.Json),
});
export interface RunState extends Schema.Schema.Type<typeof RunState> {}

const sameValue = (left: unknown, right: unknown) =>
  left === right ||
  (typeof left === "object" && left !== null && JSON.stringify(left) === JSON.stringify(right));

const compare = (left: unknown, right: unknown) =>
  typeof left === "number" && typeof right === "number"
    ? left - right
    : typeof left === "string" && typeof right === "string"
      ? left.localeCompare(right)
      : Number.NaN;

const contains = (container: unknown, value: unknown) =>
  typeof container === "string"
    ? typeof value === "string" && container.includes(value)
    : Array.isArray(container) && container.some((item) => sameValue(item, value));

const dateMillis = (value: unknown, now: number) =>
  value === "now" ? now : typeof value === "string" ? Date.parse(value) : Number.NaN;

/** Evaluates a condition. Comparisons between mismatched types are false. */
export const holds = (
  condition: Condition,
  read: (ref: string) => unknown,
  now = Number.NaN,
): boolean => {
  if ("all" in condition) {
    return condition.all.every((inner) => holds(inner, read, now));
  }
  if ("any" in condition) {
    return condition.any.some((inner) => holds(inner, read, now));
  }
  if ("not" in condition) {
    return !holds(condition.not, read, now);
  }
  const actual = read(condition.ref);
  if (condition.op === "exists") {
    return actual !== undefined && actual !== null;
  }
  switch (condition.op) {
    case "equals":
      return sameValue(actual, condition.value);
    case "notEquals":
      return !sameValue(actual, condition.value);
    case "greaterThan":
      return compare(actual, condition.value) > 0;
    case "lessThan":
      return compare(actual, condition.value) < 0;
    case "contains":
      return contains(actual, condition.value);
    case "before":
      return dateMillis(actual, now) < dateMillis(condition.value, now);
    case "after":
      return dateMillis(actual, now) > dateMillis(condition.value, now);
  }
};
