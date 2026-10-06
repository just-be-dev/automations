import * as Equivalence from "effect/Equivalence";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import { Trace } from "../../../ai/trace.ts";
import { RunSummary } from "../../../workflow.ts";

export const ListedAutomation = Schema.Struct({ id: Schema.String, name: Schema.String });
export type ListedAutomation = typeof ListedAutomation.Type;

export const Automations = defineTaggedUnion({
  Loading: {},
  Ready: { automations: Schema.Array(ListedAutomation) },
  Unavailable: { error: Schema.String },
});

/** The selected automation's recent runs, each with its own trace. */
export const Runs = defineTaggedUnion({
  NotSelected: {},
  Loading: { automationId: Schema.String },
  Ready: { automationId: Schema.String, runs: Schema.Array(RunSummary) },
  Unavailable: { automationId: Schema.String, error: Schema.String },
});
export type Runs = typeof Runs.Type;

/** Whose conversation is open: the automation's planner, or the agent steps of one of its runs. */
export const Source = Schema.Struct({
  automationId: Schema.String,
  maybeRunId: Schema.Option(Schema.String),
});
export type Source = typeof Source.Type;

export const isSameId = Option.makeEquivalence(Equivalence.strictEqual<string>());

export const isSameSource = Option.makeEquivalence<Source>(
  (a, b) => a.automationId === b.automationId && isSameId(a.maybeRunId, b.maybeRunId),
);

/** A refresh keeps the trace on screen until the new one arrives. */
export const TraceState = defineTaggedUnion({
  NotSelected: {},
  Loading: {},
  Ready: { trace: Trace },
  Refreshing: { trace: Trace },
  Unavailable: { error: Schema.String },
});
export type TraceState = typeof TraceState.Type;

export const Model = Schema.Struct({
  maybeSource: Schema.Option(Source),
  automations: Automations,
  runs: Runs,
  trace: TraceState,
  /** Each selection or refresh loads anew and drops the replies of older loads. */
  load: Schema.Int,
});
export type Model = typeof Model.Type;
