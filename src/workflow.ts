import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

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

const isPublicHttpsUrl = (value: string) => {
  const url = URL.parse(value);
  return (
    url !== null &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !privateHost.test(url.hostname)
  );
};

const PublicHttpsUrl = Schema.String.check(
  Schema.makeFilter(isPublicHttpsUrl, {
    message: "Step must be an agent instruction or a public HTTPS webhook",
  }),
);

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
/** A wait or timeout, written in Effect's `Duration` syntax. */
const Duration = Identifier(/^\d{1,4} (minute|hour|day|week)s?$/, durationMessage);
/** An offset from a date, such as "-7 days" for a week before it. */
const Offset = Identifier(/^-?\d{1,4} (minute|hour|day|week)s?$/, durationMessage);

const inputFieldShorthand = /^(?:\{\{\s*([a-zA-Z0-9_-]{1,40})\s*\}\}|([a-zA-Z0-9_-]{1,40}))$/;

/**
 * The designer agent sometimes names an input field the way it writes variables in text
 * (`start_date` or `{{start_date}}`). A bare name can only mean a run input field, because step
 * references always need `steps.<id>.<field>`, so decoding qualifies it as `input.<field>`.
 */
const qualifyInputField = (value: string) => {
  const match = inputFieldShorthand.exec(value.trim());
  return match === null ? value : `input.${match[1] ?? match[2]}`;
};

/**
 * A path into the run's state: `input.<field>` reads the run input, and `steps.<id>.<field>` reads
 * what an earlier step recorded.
 */
const Ref = Schema.String.pipe(
  Schema.decodeTo(
    Identifier(
      /^(input|steps)(\.[a-zA-Z0-9_-]{1,40}){1,4}$/,
      "References start with input. or steps. followed by a field path",
    ),
    SchemaTransformation.transform({ decode: qualifyInputField, encode: (ref: string) => ref }),
  ),
);

export const AgentStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("agent"),
  instruction: NonBlank("Step must be an agent instruction or a public HTTPS webhook", 4000),
});
export interface AgentStep extends Schema.Schema.Type<typeof AgentStep> {}

export const WebhookStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("webhook"),
  url: PublicHttpsUrl,
});
export interface WebhookStep extends Schema.Schema.Type<typeof WebhookStep> {}

export const WaitForStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("wait"),
  duration: Duration,
});
export interface WaitForStep extends Schema.Schema.Type<typeof WaitForStep> {}

/** Waits until a date read from the run state, shifted by `offset`. */
export const WaitUntilStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("wait"),
  until: Ref,
  offset: Schema.optionalKey(Offset),
});
export interface WaitUntilStep extends Schema.Schema.Type<typeof WaitUntilStep> {}

export type Comparison = "equals" | "notEquals" | "greaterThan" | "lessThan" | "contains";

/** A deterministic check against the run state. */
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
    op: Schema.Literals(["equals", "notEquals", "greaterThan", "lessThan", "contains"]),
    value: Schema.Json,
  }),
  Schema.Struct({ ref: Ref, op: Schema.Literal("exists") }),
  Schema.Struct({ all: Conditions }),
  Schema.Struct({ any: Conditions }),
  Schema.Struct({ not: Schema.suspend((): Schema.Codec<Condition> => Condition) }),
]);

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

/** Asks a decision model to pick one option given the run state, then runs that option's steps. */
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
  name: Identifier(/^[a-z][a-z0-9_]{0,39}$/, "Field names are snake_case identifiers"),
  label: NonBlank("A field label is required", 120),
  type: Schema.Literals(["text", "number", "boolean", "date"]),
});
export interface HumanField extends Schema.Schema.Type<typeof HumanField> {}

/** Pauses the run until a person approves, rejects, or fills in a form, or `timeout` passes. */
export const HumanStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("human"),
  prompt: NonBlank("A human step needs a prompt", 4000),
  assignee: Schema.optionalKey(NonBlank("An assignee can't be blank", 200)),
  response: Schema.Union([
    Schema.Literal("approval"),
    Schema.Struct({ fields: Schema.Array(HumanField).check(Schema.isMinLength(1)) }),
  ]),
  timeout: Schema.optionalKey(Duration),
});
export interface HumanStep extends Schema.Schema.Type<typeof HumanStep> {}

export type Step =
  | AgentStep
  | WebhookStep
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
  WebhookStep,
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

const conditionRefs = (condition: Condition): ReadonlyArray<string> =>
  "ref" in condition
    ? [condition.ref]
    : "all" in condition
      ? condition.all.flatMap(conditionRefs)
      : "any" in condition
        ? condition.any.flatMap(conditionRefs)
        : conditionRefs(condition.not);

/** The state paths a step reads. */
export const stepRefs = (step: Step): ReadonlyArray<string> =>
  step.kind === "wait" && "until" in step
    ? [step.until]
    : step.kind === "if"
      ? step.cases.flatMap((branch) => conditionRefs(branch.when))
      : [];

const MAX_STEPS = 60;
const MAX_DEPTH = 4;

const hasUniqueIds = (steps: ReadonlyArray<Step>) => {
  const all = flattenSteps(steps);
  return new Set(all.map((step) => step.id)).size === all.length;
};

const refersToKnownSteps = (steps: ReadonlyArray<Step>) => {
  const all = flattenSteps(steps);
  const ids = new Set(all.map((step) => step.id));
  return all
    .flatMap(stepRefs)
    .every((ref) => !ref.startsWith("steps.") || ids.has(ref.split(".")[1] ?? ""));
};

export const Workflow = Schema.Struct({
  name: NonBlank("A name is required (maximum 120 characters)", 120),
  event: Schema.NullOr(Identifier(/^[a-zA-Z0-9_.-]{1,80}$/, "Event must be null or an identifier")),
  steps: Steps.check(
    between(1, 20, "A workflow needs 1–20 steps"),
    Schema.makeFilter((steps: ReadonlyArray<Step>) => flattenSteps(steps).length <= MAX_STEPS, {
      message: `A workflow can have at most ${MAX_STEPS} steps in total`,
    }),
    Schema.makeFilter((steps: ReadonlyArray<Step>) => depth(steps) <= MAX_DEPTH, {
      message: `Steps can nest at most ${MAX_DEPTH} levels deep`,
    }),
    Schema.makeFilter(hasUniqueIds, { message: "Step IDs must be unique identifiers" }),
    Schema.makeFilter(refersToKnownSteps, {
      message: "Every steps.<id> reference must name a step in the workflow",
    }),
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

export const RunResult = Schema.Struct({ step: Schema.String, output: Schema.String });
export interface RunResult extends Schema.Schema.Type<typeof RunResult> {}

export const RunStatus = Schema.Literals(["running", "completed", "failed"]);
export type RunStatus = typeof RunStatus.Type;

/** A run as persisted in the automation's Durable Object storage. */
export const Run = Schema.Struct({
  id: Schema.String,
  workflow: Workflow,
  input: Schema.Unknown,
  index: Schema.Int,
  results: Schema.Array(RunResult),
  status: RunStatus,
  error: Schema.optionalKey(Schema.String),
  /** The pi conversation running the current agent step. */
  conversation: Schema.optionalKey(Schema.Int),
});
export interface Run extends Schema.Schema.Type<typeof Run> {}

const invalid = (error: Schema.SchemaError) => new InvalidWorkflow({ message: error.message });

export const decodeWorkflow = (value: unknown) =>
  Schema.decodeUnknownEffect(Workflow)(value).pipe(Effect.mapError(invalid));

const DraftFromJson = Schema.fromJsonString(Draft);

/** Parses the designer agent's reply, tolerating a Markdown code fence around the JSON. */
export const decodeDraft = (text: string) =>
  Schema.decodeEffect(DraftFromJson)(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")).pipe(
    Effect.mapError(invalid),
  );

export interface GraphNode {
  readonly id: string;
  readonly title: string;
  readonly kind: "trigger" | Step["kind"];
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
}

export interface Graph {
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<GraphEdge>;
}

export const graph = (workflow: Workflow): Graph => ({
  nodes: [
    {
      id: "trigger",
      title: workflow.event === null ? "Manual start" : `Event: ${workflow.event}`,
      kind: "trigger",
    },
    ...workflow.steps.map(({ id, title, kind }) => ({ id, title, kind })),
  ],
  edges: workflow.steps.map((step, index) => ({
    from: workflow.steps[index - 1]?.id ?? "trigger",
    to: step.id,
  })),
});

/**
 * Steps refer to values from the run input as `{{snake_case}}` variables. Splitting on a pattern
 * with one capture group puts every variable name at an odd index.
 */
const variableSyntax = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/;

export type TemplatePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "variable"; readonly name: string };

export const templateParts = (text: string): ReadonlyArray<TemplatePart> =>
  text
    .split(variableSyntax)
    .flatMap((part, index): ReadonlyArray<TemplatePart> =>
      index % 2 === 1
        ? [{ kind: "variable", name: part }]
        : part
          ? [{ kind: "text", text: part }]
          : [],
    );

const stepText = (step: Step): ReadonlyArray<string> => {
  switch (step.kind) {
    case "agent":
      return [step.title, step.instruction];
    case "decide":
      return [step.title, step.question];
    case "human":
      return [step.title, step.prompt, step.assignee ?? ""];
    default:
      return [step.title];
  }
};

const inputField = (ref: string) => (ref.startsWith("input.") ? [ref.split(".")[1] ?? ""] : []);

/** Every variable the workflow's steps use, in order of first use. */
export const workflowVariables = (workflow: Pick<Workflow, "steps">): ReadonlyArray<string> => [
  ...new Set(
    flattenSteps(workflow.steps).flatMap((step) => [
      ...stepText(step)
        .flatMap(templateParts)
        .flatMap((part) => (part.kind === "variable" ? [part.name] : [])),
      ...stepRefs(step).flatMap(inputField),
    ]),
  ),
];

/** Fills each `{{variable}}` from the run input, leaving variables the input lacks as written. */
export const renderTemplate = (text: string, input: unknown): string =>
  templateParts(text)
    .map((part) => {
      if (part.kind === "text") {
        return part.text;
      }
      const value = readPath(input, [part.name]);
      return value === undefined || value === null
        ? `{{${part.name}}}`
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
    })
    .join("");

const readPath = (value: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      typeof current === "object" && current !== null
        ? Object.getOwnPropertyDescriptor(current, key)?.value
        : undefined,
    value,
  );

/** What a run knows so far: its input, and what each finished step recorded under its ID. */
export const RunState = Schema.Struct({
  input: Schema.Json,
  steps: Schema.Record(Schema.String, Schema.Json),
});
export interface RunState extends Schema.Schema.Type<typeof RunState> {}

/** Reads a `Ref` such as `input.start_date` or `steps.check-dates.choice`. */
export const lookup = (state: RunState, ref: string): unknown => {
  const [root, ...path] = ref.split(".");
  return readPath(root === "input" ? state.input : state.steps, path);
};

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

/** Evaluates a condition. Comparisons between mismatched types are false. */
export const holds = (condition: Condition, state: RunState): boolean => {
  if ("all" in condition) {
    return condition.all.every((inner) => holds(inner, state));
  }
  if ("any" in condition) {
    return condition.any.some((inner) => holds(inner, state));
  }
  if ("not" in condition) {
    return !holds(condition.not, state);
  }
  const actual = lookup(state, condition.ref);
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
  }
};
