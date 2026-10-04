import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

export const Step = Schema.Union([AgentStep, WebhookStep]);
export type Step = typeof Step.Type;

const hasUniqueIds = (steps: ReadonlyArray<Step>) =>
  new Set(steps.map((step) => step.id)).size === steps.length;

export const Workflow = Schema.Struct({
  name: NonBlank("A name is required (maximum 120 characters)", 120),
  event: Schema.NullOr(Identifier(/^[a-zA-Z0-9_.-]{1,80}$/, "Event must be null or an identifier")),
  steps: Schema.Array(Step).check(
    Schema.makeFilter((steps: ReadonlyArray<Step>) => steps.length >= 1 && steps.length <= 20, {
      message: "A workflow needs 1–20 steps",
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
