/** Holds the shared app state for designing automations and following runs across pages and panels.
 * Keeps unsent messages, pending questions, and request freshness tied to their current context. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import * as Dialog from "@/components/ui/dialog";
import { AskedQuestions, PendingChat, Run, RunSummary, Workflow } from "../workflow.ts";
import { Role } from "../entities.ts";
import { SubjectOption } from "./api.ts";
import { Questionnaire, TaskAnswer } from "./domain/index.ts";
import { Entities, Overview, Templates, Traces } from "./page/index.ts";
import { ShortcutModifier } from "./platform.ts";
import { Theme } from "./theme.ts";
import * as Assistant from "./assistant/index.ts";

export const Activity = defineTaggedUnion({
  Ready: { notice: Schema.String },
  Working: { notice: Schema.String },
  Failed: { error: Schema.String },
});

/** One chat turn: the message, the questions the agent asked on the way, and its Markdown reply. */
export const Exchange = Schema.Struct({
  id: Schema.Int,
  prompt: Schema.String,
  asked: Schema.Array(AskedQuestions),
  reply: Schema.String,
});
export type Exchange = typeof Exchange.Type;

export const WorkflowDisplay = Schema.Literals(["Steps", "Json"]);
export type WorkflowDisplay = typeof WorkflowDisplay.Type;

export const AutomationSummary = Schema.Struct({ id: Schema.String, name: Schema.String });
export type AutomationSummary = typeof AutomationSummary.Type;

export const Directory = defineTaggedUnion({
  Loading: {},
  Ready: { automations: Schema.Array(AutomationSummary) },
  Unavailable: { error: Schema.String },
});
export type Directory = typeof Directory.Type;

export const listedAutomations = (directory: Directory): ReadonlyArray<AutomationSummary> =>
  Directory.guards.Ready(directory) ? directory.automations : [];

export const listedName = (directory: Directory, automationId: string) =>
  Option.map(
    Array.findFirst(listedAutomations(directory), (automation) => automation.id === automationId),
    (automation) => automation.name,
  );

/** What the new automation dialog says the automation should do, and whether it's being created. */
export const NewAutomation = defineTaggedUnion({
  Editing: { description: Schema.String, maybeError: Schema.Option(Schema.String) },
  Creating: { description: Schema.String },
});
export type NewAutomation = typeof NewAutomation.Type;

export const blankNewAutomation = NewAutomation.Editing({
  description: "",
  maybeError: Option.none(),
});

export const RoleChoices = defineTaggedUnion({
  Loading: {},
  Ready: { roles: Schema.Array(Role) },
  Unavailable: { error: Schema.String },
});
export type RoleChoices = typeof RoleChoices.Type;

export const readyRoles = (choices: RoleChoices): ReadonlyArray<Role> =>
  RoleChoices.guards.Ready(choices) ? choices.roles : [];

export const SubjectChoices = defineTaggedUnion({
  NotNeeded: {},
  Loading: { entityType: Schema.String },
  Ready: { entityType: Schema.String, label: Schema.String, subjects: Schema.Array(SubjectOption) },
  Unavailable: { entityType: Schema.String, error: Schema.String },
});
export type SubjectChoices = typeof SubjectChoices.Type;

export const RunDetail = defineTaggedUnion({
  Loading: {},
  Loaded: { run: Run, maybeSubjectTitle: Schema.Option(Schema.String) },
  Unavailable: { error: Schema.String },
});

/** How the last answer to one of the run's tasks, or the last reload of the run, went. */
export const RunNotice = defineTaggedUnion({
  Idle: {},
  Sending: {},
  Sent: {},
  Failed: { error: Schema.String },
});
export type RunNotice = typeof RunNotice.Type;

/** A run being followed, on its own page or in the panel beside the overview or the studio. */
export const OpenRun = Schema.Struct({
  automationId: Schema.String,
  runId: Schema.String,
  detail: RunDetail,
  taskEdits: Schema.Array(TaskAnswer.TaskFieldEdit),
  notice: RunNotice,
});
export type OpenRun = typeof OpenRun.Type;

/**
 * The overview of every automation, the studio that edits the one in `automationId`, or one of its
 * runs. A run page shows what the run did without the planner: it ran a saved snapshot, not the
 * draft.
 */
export const Page = defineTaggedUnion({
  Overview: { overview: Overview.Model },
  Templates: { templates: Templates.Model },
  Entities: { entities: Entities.Model },
  Traces: { traces: Traces.Model },
  Studio: {},
  Run: { openRun: OpenRun },
});
export type Page = typeof Page.Type;

export const Model = Schema.Struct({
  assistant: Assistant.Model,
  maybeFollowHref: Schema.Option(Schema.String),
  plannerHistoryOpen: Schema.Boolean,
  maybeNavigationNotice: Schema.Option(Schema.String),
  page: Page,
  automationId: Schema.String,
  directory: Directory,
  newAutomationDialog: Dialog.Model,
  newAutomation: NewAutomation,
  roles: RoleChoices,
  revision: Schema.Int,
  /** Each automation's unsent message, so the composer never carries one into another automation. */
  messageInputs: Schema.Record(Schema.String, Schema.String),
  conversation: Schema.Array(Exchange),
  maybeDraft: Schema.Option(Workflow),
  maybeSaved: Schema.Option(Workflow),
  maybePendingChat: Schema.Option(PendingChat),
  /** The answers given so far to the questions the agent is waiting on. */
  maybeQuestionnaire: Schema.Option(Questionnaire.Questionnaire),
  runs: Schema.Array(RunSummary),
  /** The run open beside the overview or the studio. Changing pages closes it. */
  maybeRunPanel: Schema.Option(OpenRun),
  /** Each load of the open run starts a new chain of polls and drops the replies of older ones. */
  runPoll: Schema.Int,
  subjectChoices: SubjectChoices,
  maybeSubjectId: Schema.Option(Schema.String),
  /** What the agent is doing while it answers, as the server last described it. */
  maybeProgress: Schema.Option(Schema.String),
  expandedStepIds: Schema.Array(Schema.String),
  workflowDisplay: WorkflowDisplay,
  theme: Theme,
  shortcutModifier: ShortcutModifier,
  activity: Activity,
});
export type Model = typeof Model.Type;

/** The questions the agent is waiting on, with the answers given so far. */
export const openQuestionnaire = (model: Model) =>
  Option.flatMap(model.maybePendingChat, (pending) =>
    pending.status !== "asking"
      ? Option.none()
      : Array.match(pending.questions, {
          onEmpty: () => Option.none(),
          onNonEmpty: (questions) =>
            Option.some({
              questions,
              questionnaire: Option.getOrElse(
                Option.filter(
                  model.maybeQuestionnaire,
                  (questionnaire) => questionnaire.chatId === pending.id,
                ),
                () => Questionnaire.start(pending.id, questions),
              ),
            }),
        }),
  );

/** The open automation's unsent message. */
export const messageInputOf = (model: Model) => model.messageInputs[model.automationId] ?? "";

/** Changes the open automation's unsent message, dropping it once empty. */
export const modifyMessageInput = (model: Model, f: (value: string) => string): Model => {
  const { [model.automationId]: current = "", ...others } = model.messageInputs;
  const next = f(current);
  return {
    ...model,
    messageInputs: next === "" ? others : { ...others, [model.automationId]: next },
  };
};
