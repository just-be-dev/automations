/** Defines execution identity and interpreter values rebuilt from the journal on each replay. */
import * as Schema from "effect/Schema";
import { Subject } from "../entities/model.ts";
import { Event } from "../events/model.ts";
import { RunId } from "./run.ts";

/** Identifies an engine journal, derived by Effect Workflow from the run's payload. Never empty. */
export const ExecutionId = Schema.NonEmptyString.pipe(Schema.brand("ExecutionId"));
export type ExecutionId = typeof ExecutionId.Type;

/**
 * Values available to the interpreter at this point in its walk. Rebuilt on each replay from
 * journaled Activities and deferred completions, not loaded from the application run record.
 * `steps` holds only values, with no statuses or tasks. The final values are the workflow result.
 */
export const ExecutionValues = Schema.Struct({
  runId: RunId,
  subject: Schema.NullOr(Subject),
  event: Schema.optionalKey(Event),
  steps: Schema.Record(Schema.String, Schema.Json),
});
export interface ExecutionValues extends Schema.Schema.Type<typeof ExecutionValues> {}
