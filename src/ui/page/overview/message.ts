import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { SubjectOption } from "../../api.ts";
import { Automation } from "./model.ts";

export const Message = defineMessageUnion({
  ClickedRunNow: { automationId: Schema.String },
  SelectedSubject: { subjectId: Schema.String },
  ClickedStart: {},
  ClickedCancelStart: {},
  SucceededLoadOverview: {
    session: Schema.Int,
    poll: Schema.Int,
    automations: Schema.Array(Automation),
  },
  FailedLoadOverview: { session: Schema.Int, poll: Schema.Int, error: Schema.String },
  SucceededLoadSubjects: {
    automationId: Schema.String,
    entityType: Schema.String,
    label: Schema.String,
    subjects: Schema.Array(SubjectOption),
  },
  FailedLoadSubjects: {
    automationId: Schema.String,
    entityType: Schema.String,
    error: Schema.String,
  },
  SucceededStartRun: { automationId: Schema.String, runId: Schema.String },
  FailedStartRun: { automationId: Schema.String, error: Schema.String },
});
export type Message = typeof Message.Type;
