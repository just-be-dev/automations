/** Carries out studio and run interactions with the server, including polling and task answers.
 * Also handles the root app's navigation and theme changes. */
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Http } from "foldkit";
import { load, pushUrl } from "foldkit/navigation";
import { SuppliedEvent } from "../events/model.ts";
import {
  PendingChat,
  Permission,
  RunSummary,
  TitledRun,
  Workflow,
  WorkflowChanges,
} from "../workflow.ts";
import { errorText, loadEventInput, loadSubjectOptions, requestJson } from "./api.ts";
import { TaskAnswer } from "./domain/index.ts";
import { LoadedAutomation, Message } from "./message.ts";
import { AutomationSummary } from "./model.ts";
import { applyTheme, Theme } from "./theme.ts";

const requestArgs = { automationId: Schema.String, revision: Schema.Int };

const request = <T, E>(
  automationId: string,
  path: string,
  schema: Schema.Codec<T, E>,
  body?: unknown,
) => requestJson(`/api/automations/${automationId}${path}`, schema, body);

const recoverRequest = (revision: number) =>
  Effect.catch((error: unknown) =>
    Effect.succeed(Message.FailedRequest({ revision, error: errorText(error) })),
  );

const AutomationState = Schema.Struct({
  draft: Schema.OptionFromOptional(Workflow),
  saved: Schema.OptionFromOptional(Workflow),
  conversation: Schema.Array(
    Schema.Struct({ changes: Schema.OptionFromOptional(WorkflowChanges) }),
  ),
  pendingChat: Schema.OptionFromOptional(PendingChat),
  runs: Schema.Array(RunSummary),
  progress: Schema.OptionFromOptional(Schema.String),
});

const fetchAutomation = (automationId: string, revision: number) =>
  request(automationId, "", AutomationState).pipe(
    Effect.map((state) =>
      LoadedAutomation.make({
        revision,
        maybeDraft: state.draft,
        maybeSaved: state.saved,
        maybeLatestChanges: Option.flatMap(
          Array.last(state.conversation),
          (exchange) => exchange.changes,
        ),
        maybePendingChat: state.pendingChat,
        runs: state.runs,
        maybeProgress: state.progress,
      }),
    ),
    Effect.provide(Http.layer),
  );

const loadAutomation = (automationId: string, revision: number) =>
  fetchAutomation(automationId, revision).pipe(
    Effect.map((loaded) => Message.SucceededLoadAutomation(loaded)),
    recoverRequest(revision),
  );

export const LoadAutomation = Command.define("LoadAutomation", {
  args: requestArgs,
  messages: [Message.SucceededLoadAutomation, Message.FailedRequest],
  execute: ({ automationId, revision }) => loadAutomation(automationId, revision),
});

/** Reloads the automation after a pause, while the agent is still answering a message. */
export const PollAutomation = Command.define("PollAutomation", {
  args: requestArgs,
  messages: [Message.SucceededLoadAutomation, Message.FailedRequest],
  execute: ({ automationId, revision }) =>
    Effect.sleep("1500 millis").pipe(Effect.andThen(loadAutomation(automationId, revision))),
});

/**
 * Reloads the automation after a longer pause while nothing is in progress, so a message the hub's
 * assistant sends its planner from the drawer shows up on the open studio page.
 */
export const WatchAutomation = Command.define("WatchAutomation", {
  args: { ...requestArgs, watch: Schema.Int },
  messages: [Message.WatchedAutomation, Message.FailedWatchAutomation],
  execute: ({ automationId, revision, watch }) =>
    Effect.sleep("5 seconds").pipe(
      Effect.andThen(fetchAutomation(automationId, revision)),
      Effect.map((loaded) => Message.WatchedAutomation({ watch, loaded })),
      Effect.catch(() => Effect.succeed(Message.FailedWatchAutomation({ revision, watch }))),
    ),
});

export const LoadAutomations = Command.define("LoadAutomations", {
  messages: [Message.SucceededLoadAutomations, Message.FailedLoadAutomations],
  execute: requestJson("/api/automations", Schema.Array(AutomationSummary)).pipe(
    Effect.map((automations) => Message.SucceededLoadAutomations({ automations })),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedLoadAutomations({ error: errorText(error) })),
    ),
    Effect.provide(Http.layer),
  ),
});

/** Which simulated connections are live here; on failure the studio keeps calling them simulated. */
export const LoadConnections = Command.define("LoadConnections", {
  messages: [Message.SucceededLoadConnections, Message.FailedLoadConnections],
  execute: requestJson(
    "/api/connections",
    Schema.Struct({ live: Schema.Array(Schema.String) }),
  ).pipe(
    Effect.map(({ live }) => Message.SucceededLoadConnections({ live })),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedLoadConnections({ error: errorText(error) })),
    ),
    Effect.provide(Http.layer),
  ),
});

/** Whether this is local development; on failure the studio hides development-only controls. */
export const LoadDevelopment = Command.define("LoadDevelopment", {
  messages: [Message.SucceededLoadDevelopment, Message.FailedLoadDevelopment],
  execute: requestJson("/api/dev", Schema.Struct({ local: Schema.Boolean })).pipe(
    Effect.map(({ local }) => Message.SucceededLoadDevelopment({ isLocal: local })),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedLoadDevelopment({ error: errorText(error) })),
    ),
    Effect.provide(Http.layer),
  ),
});

export const LoadRuns = Command.define("LoadRuns", {
  args: requestArgs,
  messages: [Message.SucceededLoadRuns, Message.FailedRequest],
  execute: ({ automationId, revision }) =>
    request(automationId, "", Schema.Struct({ runs: Schema.Array(RunSummary) })).pipe(
      Effect.map(({ runs }) => Message.SucceededLoadRuns({ revision, runs })),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

export const LoadSubjects = Command.define("LoadSubjects", {
  args: { revision: Schema.Int, entityType: Schema.String },
  messages: [Message.SucceededLoadSubjects, Message.FailedLoadSubjects],
  execute: ({ revision, entityType }) =>
    loadSubjectOptions(entityType).pipe(
      Effect.map(({ label, subjects }) =>
        Message.SucceededLoadSubjects({ revision, entityType, label, subjects }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadSubjects({ revision, entityType, error: errorText(error) }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
});

/** Loads who a run's footer can run the saved version for. */
export const LoadRunSubjects = Command.define("LoadRunSubjects", {
  args: { revision: Schema.Int, runId: Schema.String, entityType: Schema.String },
  messages: [Message.SucceededLoadRunSubjects, Message.FailedLoadRunSubjects],
  execute: ({ revision, runId, entityType }) =>
    loadSubjectOptions(entityType).pipe(
      Effect.map(({ label, subjects }) =>
        Message.SucceededLoadRunSubjects({ revision, runId, entityType, label, subjects }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadRunSubjects({ revision, runId, entityType, error: errorText(error) }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
});

export const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

/**
 * Opens the platform's assistant, the hub shell's drawer, on a new chat with `prompt` in its
 * composer, unsent. The shell listens for `hub:open` on every app (agents' docs/hub-shell.md); a
 * page without the shell, such as `alchemy dev`, ignores it.
 */
export const OpenAssistant = Command.define("OpenAssistant", {
  args: { prompt: Schema.String },
  messages: [Message.CompletedOpenAssistant],
  execute: ({ prompt }) =>
    Effect.sync(() => {
      window.dispatchEvent(new CustomEvent("hub:open", { detail: { prompt } }));
    }).pipe(Effect.as(Message.CompletedOpenAssistant())),
});

export const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});

export const ApplyTheme = Command.define("ApplyTheme", {
  args: { theme: Theme },
  messages: [Message.CompletedApplyTheme],
  execute: ({ theme }) => applyTheme(theme).pipe(Effect.as(Message.CompletedApplyTheme())),
});

export const SaveDraft = Command.define("SaveDraft", {
  args: requestArgs,
  messages: [Message.SucceededSaveDraft, Message.FailedRequest],
  execute: ({ automationId, revision }) =>
    request(automationId, "/save", Schema.Struct({ saved: Workflow }), {}).pipe(
      Effect.map(({ saved }) => Message.SucceededSaveDraft({ revision, saved })),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

export const SetPermission = Command.define("SetPermission", {
  args: { ...requestArgs, operation: Schema.String, permission: Permission },
  messages: [Message.SucceededSetPermission, Message.FailedRequest],
  execute: ({ automationId, revision, operation, permission }) =>
    request(automationId, "/permissions", Schema.Struct({ draft: Workflow }), {
      permissions: { [operation]: permission },
    }).pipe(
      Effect.map(({ draft }) => Message.SucceededSetPermission({ revision, draft })),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

export const StartRun = Command.define("StartRun", {
  args: {
    ...requestArgs,
    maybeSubjectId: Schema.Option(Schema.String),
    event: Schema.optionalKey(SuppliedEvent),
  },
  messages: [Message.SucceededStartRun, Message.FailedRequest],
  execute: ({ automationId, revision, maybeSubjectId, event }) =>
    request(automationId, "/start", Schema.Struct({ id: Schema.String }), {
      ...Option.match(maybeSubjectId, { onNone: () => ({}), onSome: (subject) => ({ subject }) }),
      ...(event === undefined ? {} : { event }),
    }).pipe(
      Effect.map(({ id }) => Message.SucceededStartRun({ revision, runId: id })),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

/** Starts another run of the automation's saved version from an open run's footer. */
export const StartSavedRun = Command.define("StartSavedRun", {
  args: {
    ...requestArgs,
    fromRunId: Schema.String,
    maybeSubjectId: Schema.Option(Schema.String),
  },
  messages: [Message.SucceededStartSavedRun, Message.FailedStartSavedRun],
  execute: ({ automationId, revision, fromRunId, maybeSubjectId }) =>
    request(
      automationId,
      "/start",
      Schema.Struct({ id: Schema.String }),
      Option.match(maybeSubjectId, { onNone: () => ({}), onSome: (subject) => ({ subject }) }),
    ).pipe(
      Effect.map(({ id }) => Message.SucceededStartSavedRun({ revision, fromRunId, runId: id })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedStartSavedRun({ revision, fromRunId, error: errorText(error) }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
});

export const LoadEventInput = Command.define("LoadEventInput", {
  args: requestArgs,
  messages: [Message.SucceededLoadEventInput, Message.FailedLoadEventInput],
  execute: ({ automationId, revision }) =>
    loadEventInput(automationId).pipe(
      Effect.map((editor) => Message.SucceededLoadEventInput({ revision, editor })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedLoadEventInput({ revision, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});

const runArgs = { ...requestArgs, poll: Schema.Int, runId: Schema.String };

const fetchRun = (automationId: string, revision: number, poll: number, runId: string) =>
  request(automationId, `/runs/${runId}`, TitledRun).pipe(
    Effect.map(({ subjectTitle, resumesAt, ...run }) =>
      Message.SucceededLoadRun({
        revision,
        poll,
        run,
        maybeSubjectTitle: Option.fromNullishOr(subjectTitle),
        resumesAt,
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedLoadRun({ revision, poll, error: errorText(error) })),
    ),
    Effect.provide(Http.layer),
  );

export const LoadRun = Command.define("LoadRun", {
  args: runArgs,
  messages: [Message.SucceededLoadRun, Message.FailedLoadRun],
  execute: ({ automationId, revision, poll, runId }) =>
    fetchRun(automationId, revision, poll, runId),
});

/** Reloads the open run after a pause: 1.5 s while it runs, 5 s while it waits. */
export const PollRun = Command.define("PollRun", {
  args: { ...runArgs, delayMillis: Schema.Int },
  messages: [Message.SucceededLoadRun, Message.FailedLoadRun],
  execute: ({ automationId, revision, poll, runId, delayMillis }) =>
    Effect.sleep(delayMillis).pipe(Effect.andThen(fetchRun(automationId, revision, poll, runId))),
});

export const AnswerTask = Command.define("AnswerTask", {
  args: {
    ...requestArgs,
    runId: Schema.String,
    step: Schema.String,
    answer: TaskAnswer.TaskAnswer,
  },
  messages: [Message.SucceededAnswerTask, Message.FailedAnswerTask],
  execute: ({ automationId, revision, runId, step, answer }) =>
    request(automationId, `/runs/${runId}/tasks/${step}`, Schema.Unknown, answer).pipe(
      Effect.map(() => Message.SucceededAnswerTask({ revision, runId, step })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedAnswerTask({ revision, runId, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});

/** Local development only: fires the clock a run's wait step sleeps on now. */
export const ResumeNow = Command.define("ResumeNow", {
  args: { ...requestArgs, runId: Schema.String, step: Schema.String },
  messages: [Message.SucceededResumeNow, Message.FailedResumeNow],
  execute: ({ automationId, revision, runId, step }) =>
    request(automationId, `/runs/${runId}/waits/${step}/resume`, Schema.Unknown, {}).pipe(
      Effect.map(() => Message.SucceededResumeNow({ revision, runId, step })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedResumeNow({ revision, runId, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});
