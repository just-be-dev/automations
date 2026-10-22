/** Defines public run records, step results, human tasks, and summaries separately from replay state. */
import * as Schema from "effect/Schema";
import { Subject } from "../entities/model.ts";
import { Event } from "../events/model.ts";
import { HumanResponseSpec, Workflow } from "./model.ts";

/** Identifies the application run record, never a replay execution. Encodes as a non-empty string. */
export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

/** `declined` and `skipped` steps record nothing; `waiting` parks on a clock or a person. */
export const RunStep = Schema.Struct({
  status: Schema.Literals(["running", "waiting", "done", "declined", "skipped"]),
  record: Schema.optionalKey(Schema.Json),
});
export interface RunStep extends Schema.Schema.Type<typeof RunStep> {}

/**
 * One person a task was sent to, and how that went. `sending` is written before posting, so a
 * delivery that finds it knows an earlier one may have posted and checks before posting again.
 */
export const TaskNotification = Schema.Struct({
  via: Schema.Literal("slack"),
  /** The email address the person was looked up by. */
  to: Schema.String,
  /** Their name, as the studio shows it. */
  name: Schema.String,
  status: Schema.Literals(["sending", "sent", "failed"]),
  /** Where Slack posted it: the DM's ID and the message's timestamp. */
  channel: Schema.optionalKey(Schema.String),
  ts: Schema.optionalKey(Schema.String),
  /** Why it failed. */
  error: Schema.optionalKey(Schema.String),
});
export interface TaskNotification extends Schema.Schema.Type<typeof TaskNotification> {}

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
  /** The connection the step asked to reach the assignee on. `notifications` says what was sent. */
  notify: Schema.optionalKey(Schema.Literals(["email", "slack"])),
  /** Each person the request was sent to, when the deployment sends it (Slack with a bot token). */
  notifications: Schema.optionalKey(Schema.Array(TaskNotification)),
  /**
   * The operation and inputs a permission request will perform once approved, and the label of
   * the template its inputs came from, if any.
   */
  action: Schema.optionalKey(
    Schema.Struct({
      use: Schema.String,
      inputs: Schema.Record(Schema.String, Schema.Json),
      template: Schema.optionalKey(Schema.String),
    }),
  ),
  /**
   * The role and its members when the request opened, on tasks opened while approvals named a
   * role. Kept so those runs still read; anyone in the studio may answer them now.
   */
  approvers: Schema.optionalKey(
    Schema.Struct({
      role: Schema.String,
      label: Schema.String,
      members: Schema.Array(Schema.Struct({ name: Schema.String, email: Schema.String })),
    }),
  ),
  /** Who answered and when, recorded as the task closes. The first answer is the one kept. */
  decision: Schema.optionalKey(
    Schema.Struct({
      /** Set for approvals: whether the action was approved. */
      approved: Schema.optionalKey(Schema.Boolean),
      /** The responder's email address, when the studio knew who answered. */
      by: Schema.optionalKey(Schema.String),
      at: Schema.Finite,
    }),
  ),
  status: Schema.Literals(["open", "closed"]),
});
export interface HumanTask extends Schema.Schema.Type<typeof HumanTask> {}

/** `stopped` is a run a stop step ended. */
export const RunStatus = Schema.Literals(["running", "waiting", "completed", "failed", "stopped"]);
export type RunStatus = typeof RunStatus.Type;

/**
 * The persisted application record and its public wire shape: snapshot, status, steps and tasks.
 * It is not interpreter working values or a replay checkpoint; the journal owns completed work.
 * Public IDs stay strings; the run store brands them when reading records into the application.
 */
export const Run = Schema.Struct({
  id: Schema.String,
  workflow: Workflow,
  subject: Schema.NullOr(Subject),
  event: Schema.optionalKey(Event),
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

/**
 * A run as `GET /api/automations/:id/runs/:runId` returns it, labelled with its subject's title.
 * `resumesAt` says when each wait step waiting on a clock resumes, by step ID, in epoch milliseconds.
 */
export const TitledRun = Schema.Struct({
  ...Run.fields,
  subjectTitle: Schema.NullOr(Schema.String),
  resumesAt: Schema.Record(Schema.String, Schema.Finite),
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
