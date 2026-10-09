/** Describes overview refreshes and manual run launches, including the request to create a new automation. */
import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { SubjectOption } from "../../api.ts";
import { EventInput } from "../../domain/index.ts";
import { Automation } from "./model.ts";

export const Message = defineMessageUnion({
  ClickedNewAutomation: {},
  ClickedRunNow: { automationId: Schema.String },
  SelectedSubject: { subjectId: Schema.String },
  GotEventInputMessage: { message: EventInput.Message },
  SucceededLoadEventInput: { automationId: Schema.String, editor: EventInput.Model },
  FailedLoadEventInput: { automationId: Schema.String, error: Schema.String },
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

export const OutMessage = defineMessageUnion({
  RequestedNewAutomation: {},
});
export type OutMessage = typeof OutMessage.Type;
