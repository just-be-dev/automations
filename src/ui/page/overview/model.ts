/** Tracks each automation's saved trigger and run summaries alongside overview loading and manual launch state. */
import * as Array from "effect/Array";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import { RunSummary, Trigger } from "../../../workflow.ts";
import { SubjectOption } from "../../api.ts";

export const Automation = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The saved workflow's trigger. Only a saved automation can run. */
  maybeTrigger: Schema.Option(Trigger),
  /** When a schedule trigger next starts runs, in epoch milliseconds. */
  maybeNextRunAt: Schema.Option(Schema.Finite),
  activeRuns: Schema.Array(RunSummary),
  maybeLastRun: Schema.Option(RunSummary),
  maybeError: Schema.Option(Schema.String),
});
export type Automation = typeof Automation.Type;

export const isRunning = (automation: Automation) =>
  Array.isReadonlyArrayNonEmpty(automation.activeRuns);

export const Listing = defineTaggedUnion({
  Loading: {},
  Ready: { automations: Schema.Array(Automation) },
  Unavailable: { error: Schema.String },
});

export const Subjects = defineTaggedUnion({
  Loading: {},
  Ready: { label: Schema.String, subjects: Schema.Array(SubjectOption) },
  Unavailable: { error: Schema.String },
});

/** Starting a run by hand. One automation at a time: choosing its subject, then starting it. */
export const Launch = defineTaggedUnion({
  Idle: {},
  Choosing: {
    automationId: Schema.String,
    entityType: Schema.String,
    subjects: Subjects,
    maybeSubjectId: Schema.Option(Schema.String),
  },
  Starting: { automationId: Schema.String },
  Started: { automationId: Schema.String, runId: Schema.String },
  Failed: { automationId: Schema.String, error: Schema.String },
});
export type Launch = typeof Launch.Type;

export const Model = Schema.Struct({
  /** Tells this overview's replies from those of an overview opened earlier. */
  session: Schema.Int,
  /** Each reload starts a new chain of polls and drops the replies of older ones. */
  poll: Schema.Int,
  listing: Listing,
  launch: Launch,
});
export type Model = typeof Model.Type;
