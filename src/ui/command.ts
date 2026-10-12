/** Carries out studio and run interactions with the server, including polling and task answers.
 * Also handles the root app's navigation, focus, and theme changes. */
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Dom, Http } from "foldkit";
import { load, pushUrl } from "foldkit/navigation";
import { Role } from "../entities.ts";
import { SuppliedEvent } from "../events/model.ts";
import {
  AskedQuestions,
  PendingChat,
  Permission,
  QuestionsAnswer,
  RunSummary,
  TitledRun,
  Workflow,
} from "../workflow.ts";
import { errorText, loadEventInput, loadSubjectOptions, requestJson } from "./api.ts";
import { ownAnswerId } from "./constant.ts";
import { TaskAnswer } from "./domain/index.ts";
import { Message } from "./message.ts";
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
    Schema.Struct({
      prompt: Schema.String,
      reply: Schema.String,
      asked: Schema.optionalKey(Schema.Array(AskedQuestions)),
    }),
  ),
  pendingChat: Schema.OptionFromOptional(PendingChat),
  runs: Schema.Array(RunSummary),
  progress: Schema.OptionFromOptional(Schema.String),
});

const loadAutomation = (automationId: string, revision: number) =>
  request(automationId, "", AutomationState).pipe(
    Effect.map((state) =>
      Message.SucceededLoadAutomation({
        revision,
        maybeDraft: state.draft,
        maybeSaved: state.saved,
        conversation: Array.map(state.conversation, ({ prompt, asked = [], reply }, id) => ({
          id,
          prompt,
          asked,
          reply,
        })),
        maybePendingChat: state.pendingChat,
        runs: state.runs,
        maybeProgress: state.progress,
      }),
    ),
    recoverRequest(revision),
    Effect.provide(Http.layer),
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

export const LoadRoles = Command.define("LoadRoles", {
  messages: [Message.SucceededLoadRoles, Message.FailedLoadRoles],
  execute: requestJson("/api/roles", Schema.Array(Role)).pipe(
    Effect.map((roles) => Message.SucceededLoadRoles({ roles })),
    Effect.catch((error) => Effect.succeed(Message.FailedLoadRoles({ error: errorText(error) }))),
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

export const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

export const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});

export const FocusOwnAnswer = Command.define("FocusOwnAnswer", {
  messages: [Message.CompletedFocusOwnAnswer],
  execute: Dom.focus(`#${ownAnswerId}`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusOwnAnswer()),
  ),
});

export const ApplyTheme = Command.define("ApplyTheme", {
  args: { theme: Theme },
  messages: [Message.CompletedApplyTheme],
  execute: ({ theme }) => applyTheme(theme).pipe(Effect.as(Message.CompletedApplyTheme())),
});

const CreatedAutomation = Schema.Struct({
  ...AutomationSummary.fields,
  pendingChat: Schema.optionalKey(PendingChat),
});

/** Names and lists an automation from its description, then sends that as its first message. */
export const CreateAutomation = Command.define("CreateAutomation", {
  args: { description: Schema.String },
  messages: [Message.SucceededCreateAutomation, Message.FailedCreateAutomation],
  execute: ({ description }) =>
    requestJson("/api/automations", CreatedAutomation, { description }).pipe(
      Effect.map(({ id, name, pendingChat }) =>
        Message.SucceededCreateAutomation({
          automation: { id, name },
          wasDescriptionSent: pendingChat !== undefined,
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedCreateAutomation({ error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});

export const SendMessage = Command.define("SendMessage", {
  args: { ...requestArgs, message: Schema.String },
  messages: [Message.SucceededSendMessage, Message.FailedRequest],
  execute: ({ automationId, revision, message }) =>
    request(automationId, "/chat", Schema.Struct({ pendingChat: PendingChat }), { message }).pipe(
      Effect.map((data) =>
        Message.SucceededSendMessage({
          revision,
          sentMessage: message,
          pendingChat: data.pendingChat,
        }),
      ),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

/** Answers the questions the agent is waiting on, which resumes its reply. */
export const SendAnswers = Command.define("SendAnswers", {
  args: { ...requestArgs, chatId: Schema.String, answer: QuestionsAnswer },
  messages: [Message.SucceededSendAnswers, Message.FailedRequest],
  execute: ({ automationId, revision, chatId, answer }) =>
    request(automationId, "/answers", Schema.Struct({ pendingChat: PendingChat }), {
      chatId,
      answer,
    }).pipe(
      Effect.map(({ pendingChat }) => Message.SucceededSendAnswers({ revision, pendingChat })),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
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
    Effect.map(({ subjectTitle, ...run }) =>
      Message.SucceededLoadRun({
        revision,
        poll,
        run,
        maybeSubjectTitle: Option.fromNullishOr(subjectTitle),
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
