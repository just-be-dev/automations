/** Holds the shared app state for designing automations and following runs across pages and panels.
 * Keeps request freshness tied to the current page. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import {
  isUnchanged,
  PendingChat,
  Run,
  RunSummary,
  subjectType,
  unsavedChanges,
  Workflow,
  WorkflowChanges,
} from "../workflow.ts";
import { Role } from "../entities.ts";
import { SubjectOption } from "./api.ts";
import { EventInput, TaskAnswer } from "./domain/index.ts";
import { Entities, Overview, Templates, Traces } from "./page/index.ts";
import { ShortcutModifier } from "./platform.ts";
import { Theme } from "./theme.ts";
import * as Assistant from "./assistant/index.ts";

export const Activity = defineTaggedUnion({
  Ready: { notice: Schema.String },
  Working: { notice: Schema.String },
  Failed: { error: Schema.String },
});

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
  /** `resumesAt` says when each wait step waiting on a clock resumes, by step ID. */
  Loaded: {
    run: Run,
    maybeSubjectTitle: Schema.Option(Schema.String),
    resumesAt: Schema.Record(Schema.String, Schema.Number),
  },
  Unavailable: { error: Schema.String },
});

/**
 * How the last answer to one of the run's tasks, the last early resume of one of its waits, or the
 * last reload of the run, went.
 */
export const RunNotice = defineTaggedUnion({
  Idle: {},
  Sending: {},
  Sent: {},
  Resuming: {},
  /** The step whose wait was resumed; the run polls quickly until the step moves on. */
  Resumed: { step: Schema.String },
  Failed: { error: Schema.String },
});
export type RunNotice = typeof RunNotice.Type;

/**
 * Who another run of the saved version is for: the run's subject type, or nothing for a run that
 * needs no subject. Event runs start from the studio, which supplies the event.
 */
export const runSubjectType = (run: Run) =>
  run.workflow.trigger.kind === "event"
    ? Option.none<string>()
    : Option.fromNullishOr(subjectType(run.workflow.trigger));

/** How starting another run of the saved version from a run's footer went. */
export const RunStart = defineTaggedUnion({
  Idle: {},
  Starting: {},
  Failed: { error: Schema.String },
});
export type RunStart = typeof RunStart.Type;

/** A run being followed, on its own page or in the panel beside the overview or the studio. */
export const OpenRun = Schema.Struct({
  automationId: Schema.String,
  runId: Schema.String,
  detail: RunDetail,
  taskEdits: Schema.Array(TaskAnswer.TaskFieldEdit),
  notice: RunNotice,
  /** Who the footer runs the saved version for, picked from the run's subject type. */
  subjectChoices: SubjectChoices,
  maybeSubjectId: Schema.Option(Schema.String),
  start: RunStart,
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
  maybeNavigationNotice: Schema.Option(Schema.String),
  page: Page,
  automationId: Schema.String,
  directory: Directory,
  roles: RoleChoices,
  /** Connections the registry simulates but this deployment really connects, such as `"email"` or `"slack"`. */
  liveConnections: Schema.Array(Schema.String),
  /** Local development (`GET /api/dev`), where waits can be resumed early. False until it says so. */
  isLocalDevelopment: Schema.Boolean,
  revision: Schema.Int,
  /** What the planner's latest reply changed in the draft, as its exchange recorded it. */
  maybeLatestChanges: Schema.Option(WorkflowChanges),
  maybeDraft: Schema.Option(Workflow),
  maybeSaved: Schema.Option(Workflow),
  /** The planner's reply in progress, which the studio agent started and relays questions for. */
  maybePendingChat: Schema.Option(PendingChat),
  runs: Schema.Array(RunSummary),
  /** The run open beside the overview or the studio. Changing pages closes it. */
  maybeRunPanel: Schema.Option(OpenRun),
  /** Each load of the open run starts a new chain of polls and drops the replies of older ones. */
  runPoll: Schema.Int,
  subjectChoices: SubjectChoices,
  maybeSubjectId: Schema.Option(Schema.String),
  maybeEventInput: Schema.Option(EventInput.Model),
  /** What the agent is doing while it answers, as the server last described it. */
  maybeProgress: Schema.Option(Schema.String),
  expandedStepIds: Schema.Array(Schema.String),
  workflowDisplay: WorkflowDisplay,
  theme: Theme,
  shortcutModifier: ShortcutModifier,
  activity: Activity,
});
export type Model = typeof Model.Type;

/**
 * What the agent's latest reply changed in the draft that isn't saved yet. Saving clears it, and so
 * does a reply that changes nothing, since only the latest reply counts.
 */
export const replyChanges = (model: Model): Option.Option<WorkflowChanges> =>
  Option.filter(
    Option.flatMap(model.maybeLatestChanges, (changes) =>
      Option.map(model.maybeDraft, (draft) =>
        unsavedChanges(changes, Option.getOrUndefined(model.maybeSaved), draft),
      ),
    ),
    (changes) => !isUnchanged(changes),
  );
