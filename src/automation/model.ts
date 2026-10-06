import * as Schema from "effect/Schema";
import { Trigger } from "../workflow/model.ts";
import { RunSummary } from "../workflow/run.ts";

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String,
}) {}

/** One chat turn, stored so the studio can show the conversation again after a reload. */
export const Exchange = Schema.Struct({ prompt: Schema.String, reply: Schema.String });
export interface Exchange extends Schema.Schema.Type<typeof Exchange> {}

/** A design message waiting for a reply, or the last one the planner couldn't answer. */
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

/** The overview lists failed reads alongside automations whose Durable Objects answered. */
export const AutomationOverview = Schema.Struct({
  ...AutomationSummary.fields,
  saved: Schema.optionalKey(
    Schema.Struct({
      trigger: Trigger,
      /** When a schedule trigger next starts runs, in epoch milliseconds. */
      nextRunAt: Schema.optionalKey(Schema.Finite),
    }),
  ),
  /** Runs still running or waiting, however old, newest first. */
  activeRuns: Schema.Array(RunSummary),
  lastRun: Schema.optionalKey(RunSummary),
  error: Schema.optionalKey(Schema.String),
});
export interface AutomationOverview extends Schema.Schema.Type<typeof AutomationOverview> {}
