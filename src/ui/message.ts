/** Describes user interactions and asynchronous results for the studio, runs, and shared app shell. */
import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";
import * as Dialog from "@/components/ui/dialog";
import { Role } from "../entities.ts";
import { PendingChat, Permission, Run, RunSummary, Workflow } from "../workflow.ts";
import { SubjectOption } from "./api.ts";
import { AutomationSummary, Exchange, WorkflowDisplay } from "./model.ts";
import { Entities, Overview, Templates, Traces } from "./page/index.ts";
import * as Assistant from "./assistant/index.ts";
import * as Dictation from "./dictation/index.ts";

export const Message = defineMessageUnion({
  GotDictationMessage: { message: Dictation.Message },
  GotAssistantMessage: { message: Assistant.Message },
  ToggledPlannerHistory: { isOpen: Schema.Boolean },
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  ClickedNewAutomation: {},
  GotNewAutomationDialogMessage: { message: Dialog.Message },
  UpdatedNewAutomationDescription: { value: Schema.String },
  SubmittedNewAutomation: {},
  SucceededCreateAutomation: { automation: AutomationSummary, wasDescriptionSent: Schema.Boolean },
  FailedCreateAutomation: { error: Schema.String },
  UpdatedMessageInput: { value: Schema.String },
  ToggledStepDetails: { stepId: Schema.String, isOpen: Schema.Boolean },
  SelectedWorkflowDisplay: { display: WorkflowDisplay },
  ClickedThemeToggle: {},
  CompletedApplyTheme: {},
  SubmittedMessage: {},
  ClickedQuestionStep: { chatId: Schema.String, step: Schema.Int },
  ClickedQuestionOption: { chatId: Schema.String, question: Schema.Int, label: Schema.String },
  ClickedWriteOwnAnswer: { chatId: Schema.String, question: Schema.Int },
  UpdatedOwnAnswer: { chatId: Schema.String, question: Schema.Int, text: Schema.String },
  ClickedNextQuestion: { chatId: Schema.String, question: Schema.Int },
  ClickedSendAnswers: { chatId: Schema.String },
  ClickedSkipQuestions: { chatId: Schema.String },
  CompletedFocusOwnAnswer: {},
  ClickedSave: {},
  SelectedPermission: { operation: Schema.String, permission: Permission },
  SelectedSubject: { subjectId: Schema.String },
  ClickedStart: {},
  ClickedCloseRunPanel: {},
  ClickedExpandRunPanel: {},
  ClickedApproveTask: { step: Schema.String },
  ClickedRejectTask: { step: Schema.String },
  UpdatedTaskField: { step: Schema.String, field: Schema.String, value: Schema.String },
  SubmittedTaskForm: { step: Schema.String },
  SucceededLoadAutomation: {
    revision: Schema.Int,
    maybeDraft: Schema.Option(Workflow),
    maybeSaved: Schema.Option(Workflow),
    conversation: Schema.Array(Exchange),
    maybePendingChat: Schema.Option(PendingChat),
    runs: Schema.Array(RunSummary),
    maybeProgress: Schema.Option(Schema.String),
  },
  SucceededLoadAutomations: { automations: Schema.Array(AutomationSummary) },
  FailedLoadAutomations: { error: Schema.String },
  SucceededLoadRoles: { roles: Schema.Array(Role) },
  FailedLoadRoles: { error: Schema.String },
  SucceededLoadSubjects: {
    revision: Schema.Int,
    entityType: Schema.String,
    label: Schema.String,
    subjects: Schema.Array(SubjectOption),
  },
  FailedLoadSubjects: { revision: Schema.Int, entityType: Schema.String, error: Schema.String },
  SucceededSendMessage: {
    revision: Schema.Int,
    sentMessage: Schema.String,
    pendingChat: PendingChat,
  },
  SucceededSendAnswers: { revision: Schema.Int, pendingChat: PendingChat },
  SucceededSaveDraft: { revision: Schema.Int, saved: Workflow },
  SucceededSetPermission: { revision: Schema.Int, draft: Workflow },
  SucceededStartRun: { revision: Schema.Int, runId: Schema.String },
  SucceededLoadRun: {
    revision: Schema.Int,
    poll: Schema.Int,
    run: Run,
    maybeSubjectTitle: Schema.Option(Schema.String),
  },
  FailedLoadRun: { revision: Schema.Int, poll: Schema.Int, error: Schema.String },
  SucceededLoadRuns: { revision: Schema.Int, runs: Schema.Array(RunSummary) },
  SucceededAnswerTask: { revision: Schema.Int, runId: Schema.String, step: Schema.String },
  FailedAnswerTask: { revision: Schema.Int, runId: Schema.String, error: Schema.String },
  FailedRequest: { revision: Schema.Int, error: Schema.String },
  GotOverviewMessage: { message: Overview.Message },
  GotTemplatesMessage: { message: Templates.Message },
  GotEntitiesMessage: { message: Entities.Message },
  GotTracesMessage: { message: Traces.Message },
});
export type Message = typeof Message.Type;

export const toAssistantMessage = (message: Assistant.Message) =>
  Message.GotAssistantMessage({ message });

export const toNewAutomationDialogMessage = (message: Dialog.Message) =>
  Message.GotNewAutomationDialogMessage({ message });

export const toOverviewMessage = (message: Overview.Message) =>
  Message.GotOverviewMessage({ message });

export const toTemplatesMessage = (message: Templates.Message) =>
  Message.GotTemplatesMessage({ message });

export const toEntitiesMessage = (message: Entities.Message) =>
  Message.GotEntitiesMessage({ message });

export const toTracesMessage = (message: Traces.Message) => Message.GotTracesMessage({ message });
