/** Describes user interactions and asynchronous results for the studio, runs, and shared app shell. */
import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";
import {
  PendingChat,
  Permission,
  Run,
  RunSummary,
  Workflow,
  WorkflowChanges,
} from "../workflow.ts";
import { SubjectOption } from "./api.ts";
import { EventInput } from "./domain/index.ts";
import { AutomationSummary, WorkflowDisplay } from "./model.ts";
import { Entities, Overview, Templates, Traces } from "./page/index.ts";
import * as Assistant from "./assistant/index.ts";

export const Message = defineMessageUnion({
  GotAssistantMessage: { message: Assistant.Message },
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  ClickedNewAutomation: {},
  ToggledStepDetails: { stepId: Schema.String, isOpen: Schema.Boolean },
  SelectedWorkflowDisplay: { display: WorkflowDisplay },
  ClickedThemeToggle: {},
  CompletedApplyTheme: {},
  ClickedSave: {},
  SelectedPermission: { operation: Schema.String, permission: Permission },
  SelectedSubject: { subjectId: Schema.String },
  GotEventInputMessage: { message: EventInput.Message },
  SucceededLoadEventInput: { revision: Schema.Int, editor: EventInput.Model },
  FailedLoadEventInput: { revision: Schema.Int, error: Schema.String },
  ClickedCancelStart: {},
  ClickedStart: {},
  ClickedCloseRunPanel: {},
  ClickedExpandRunPanel: {},
  ClickedApproveTask: { step: Schema.String },
  ClickedRejectTask: { step: Schema.String },
  UpdatedTaskField: { step: Schema.String, field: Schema.String, value: Schema.String },
  SubmittedTaskForm: { step: Schema.String },
  ClickedResumeNow: { step: Schema.String },
  SelectedRunSubject: { subjectId: Schema.String },
  ClickedRunSavedVersion: {},
  SucceededLoadAutomation: {
    revision: Schema.Int,
    maybeDraft: Schema.Option(Workflow),
    maybeSaved: Schema.Option(Workflow),
    maybeLatestChanges: Schema.Option(WorkflowChanges),
    maybePendingChat: Schema.Option(PendingChat),
    runs: Schema.Array(RunSummary),
    maybeProgress: Schema.Option(Schema.String),
  },
  SucceededLoadAutomations: { automations: Schema.Array(AutomationSummary) },
  FailedLoadAutomations: { error: Schema.String },
  SucceededLoadConnections: { live: Schema.Array(Schema.String) },
  FailedLoadConnections: { error: Schema.String },
  SucceededLoadDevelopment: { isLocal: Schema.Boolean },
  FailedLoadDevelopment: { error: Schema.String },
  SucceededLoadSubjects: {
    revision: Schema.Int,
    entityType: Schema.String,
    label: Schema.String,
    subjects: Schema.Array(SubjectOption),
  },
  FailedLoadSubjects: { revision: Schema.Int, entityType: Schema.String, error: Schema.String },
  SucceededLoadRunSubjects: {
    revision: Schema.Int,
    runId: Schema.String,
    entityType: Schema.String,
    label: Schema.String,
    subjects: Schema.Array(SubjectOption),
  },
  FailedLoadRunSubjects: {
    revision: Schema.Int,
    runId: Schema.String,
    entityType: Schema.String,
    error: Schema.String,
  },
  SucceededSaveDraft: { revision: Schema.Int, saved: Workflow },
  SucceededSetPermission: { revision: Schema.Int, draft: Workflow },
  SucceededStartRun: { revision: Schema.Int, runId: Schema.String },
  SucceededStartSavedRun: { revision: Schema.Int, fromRunId: Schema.String, runId: Schema.String },
  FailedStartSavedRun: { revision: Schema.Int, fromRunId: Schema.String, error: Schema.String },
  SucceededLoadRun: {
    revision: Schema.Int,
    poll: Schema.Int,
    run: Run,
    maybeSubjectTitle: Schema.Option(Schema.String),
    resumesAt: Schema.Record(Schema.String, Schema.Number),
  },
  FailedLoadRun: { revision: Schema.Int, poll: Schema.Int, error: Schema.String },
  SucceededLoadRuns: { revision: Schema.Int, runs: Schema.Array(RunSummary) },
  SucceededAnswerTask: { revision: Schema.Int, runId: Schema.String, step: Schema.String },
  FailedAnswerTask: { revision: Schema.Int, runId: Schema.String, error: Schema.String },
  SucceededResumeNow: { revision: Schema.Int, runId: Schema.String, step: Schema.String },
  FailedResumeNow: { revision: Schema.Int, runId: Schema.String, error: Schema.String },
  FailedRequest: { revision: Schema.Int, error: Schema.String },
  GotOverviewMessage: { message: Overview.Message },
  GotTemplatesMessage: { message: Templates.Message },
  GotEntitiesMessage: { message: Entities.Message },
  GotTracesMessage: { message: Traces.Message },
});
export type Message = typeof Message.Type;

export const toAssistantMessage = (message: Assistant.Message) =>
  Message.GotAssistantMessage({ message });

export const toOverviewMessage = (message: Overview.Message) =>
  Message.GotOverviewMessage({ message });

export const toTemplatesMessage = (message: Templates.Message) =>
  Message.GotTemplatesMessage({ message });

export const toEntitiesMessage = (message: Entities.Message) =>
  Message.GotEntitiesMessage({ message });

export const toTracesMessage = (message: Traces.Message) => Message.GotTracesMessage({ message });
