import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { Trace } from "../../../ai/trace.ts";
import { RunSummary } from "../../../workflow.ts";
import { ListedAutomation } from "./model.ts";

export const Message = defineMessageUnion({
  ClickedRefresh: {},
  SucceededLoadAutomations: { automations: Schema.Array(ListedAutomation) },
  FailedLoadAutomations: { error: Schema.String },
  SucceededLoadRuns: { automationId: Schema.String, runs: Schema.Array(RunSummary) },
  FailedLoadRuns: { automationId: Schema.String, error: Schema.String },
  SucceededLoadTrace: { load: Schema.Int, trace: Trace },
  FailedLoadTrace: { load: Schema.Int, error: Schema.String },
});
export type Message = typeof Message.Type;
