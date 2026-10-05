import * as Schema from "effect/Schema";
import { Subject } from "../entities/model.ts";
import { HumanResponseSpec, Workflow } from "./model.ts";

/** `declined` and `skipped` steps record nothing; `waiting` parks on a clock or a person. */
export const RunStep = Schema.Struct({
  status: Schema.Literals(["running", "waiting", "done", "declined", "skipped"]),
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
  /** The operation and inputs a permission request will perform once approved. */
  action: Schema.optionalKey(
    Schema.Struct({ use: Schema.String, inputs: Schema.Record(Schema.String, Schema.Json) }),
  ),
  /** The role and its members when the request opened. Only these members may answer for it. */
  approvers: Schema.optionalKey(
    Schema.Struct({
      role: Schema.String,
      label: Schema.String,
      members: Schema.Array(Schema.Struct({ name: Schema.String, email: Schema.String })),
    }),
  ),
  status: Schema.Literals(["open", "closed"]),
});
export interface HumanTask extends Schema.Schema.Type<typeof HumanTask> {}

/** `stopped` is a run a stop step ended. */
export const RunStatus = Schema.Literals(["running", "waiting", "completed", "failed", "stopped"]);
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
  /** The reason of the stop step that ended the run. */
  stopReason: Schema.optionalKey(Schema.String),
  startedAt: Schema.Finite,
  /** The pi conversation the run's agent steps share. */
  conversation: Schema.optionalKey(Schema.Int),
});
export interface Run extends Schema.Schema.Type<typeof Run> {}

/** A run as `GET /api/automations/:id/runs/:runId` returns it, labelled with its subject's title. */
export const TitledRun = Schema.Struct({
  ...Run.fields,
  subjectTitle: Schema.NullOr(Schema.String),
});
export interface TitledRun extends Schema.Schema.Type<typeof TitledRun> {}

/** A run as the studio lists it. */
export const RunSummary = Schema.Struct({
  id: Schema.String,
  status: RunStatus,
  startedAt: Schema.Finite,
  subject: Schema.NullOr(Schema.String),
  openTasks: Schema.Int,
});
export interface RunSummary extends Schema.Schema.Type<typeof RunSummary> {}

/** What a run knows so far: its subject, and what each finished step recorded under its ID. */
export const RunState = Schema.Struct({
  runId: Schema.String,
  subject: Schema.NullOr(Subject),
  steps: Schema.Record(Schema.String, Schema.Json),
});
export interface RunState extends Schema.Schema.Type<typeof RunState> {}
