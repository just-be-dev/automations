import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import type { PageContext } from "../../assistant/model.ts";
import { Questionnaire } from "../domain/index.ts";
import {
  ArchiveThread,
  CreateThread,
  FocusInput,
  LoadThreads,
  PersistCollapsed,
  PersistSession,
  RequestAssistant,
  RestoreAssistant,
} from "./command.ts";
import { Message } from "./message.ts";
import { Clearing, type Model, Panel, Request, ThreadList, turnInProgress } from "./model.ts";
import * as Dictation from "../dictation/index.ts";

export const OutMessage = defineMessageUnion({
  UpdatedResources: {},
  RequestedFollow: { href: Schema.String, completed: Schema.Boolean },
});
export type OutMessage = typeof OutMessage.Type;
type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>;
export const trustedHref = (href: string) =>
  /^\/(?:\?(?:[^#]*))?$|^\/(?:entities|templates|traces)(?:\?[^#]*)?$/.test(href) &&
  !href.includes("\\");
const activityKey = (id: string, href: string) => `${id}:${href}`;
const request = (model: Model, path: string, body: Schema.Json, sentInput = ""): Return => {
  if (model.sessionId === "" || Request.guards.Sending(model.request)) {
    return { model };
  }
  const sequence = model.sequence + 1;
  return {
    model: modifyFields(model, { sequence: () => sequence, request: () => Request.Sending() }),
    commands: [
      RequestAssistant({
        sessionId: model.sessionId,
        sequence,
        path,
        body: Option.some(body),
        delay: 0,
        sentInput,
      }),
    ],
  };
};
/**
 * Opens `sessionId` in the chat: the previous thread's state, answers and pending request are
 * dropped, and a fresh request sequence reads the thread. A late reply for the previous thread
 * carries its session ID or an older sequence, so it's ignored.
 */
const openThread = (model: Model, sessionId: string, input: string): Return => {
  const sequence = model.sequence + 1;
  return {
    model: modifyFields(model, {
      sessionId: () => sessionId,
      sequence: () => sequence,
      request: () => Request.Ready(),
      maybeState: () => Option.none(),
      maybeQuestionnaire: () => Option.none(),
      input: () => input,
      dictation: Dictation.cancel,
      panel: () => Panel.Chat(),
      clearing: () => Clearing.Idle(),
    }),
    commands: [
      RequestAssistant({
        sessionId,
        sequence,
        path: "",
        body: Option.none(),
        delay: 0,
        sentInput: "",
      }),
    ],
  };
};
/** Starts a new thread with `input` in the composer, opening the panel if it was collapsed. */
export const startThread =
  (input: string) =>
  (model: Model): Return => ({
    model: modifyFields(model, { collapsed: () => false }),
    commands: [
      CreateThread({ input }),
      ...(model.collapsed ? [PersistCollapsed({ collapsed: false })] : []),
    ],
  });
const historyOf = (model: Model) =>
  Panel.guards.History(model.panel) ? Option.some(model.panel) : Option.none();
export const update =
  (context: PageContext, dirty: boolean) =>
  (model: Model, message: Message): Return =>
    Message.match<Return>(message, {
      GotDictationMessage: ({ message }) =>
        Update.foldChild({
          update: Dictation.update,
          read: (model: Model) => Option.some(model.dictation),
          write: (model: Model, dictation: Dictation.Model) =>
            modifyFields(model, { dictation: () => dictation }),
          toParentMessage: (message) => Message.GotDictationMessage({ message }),
          foldOutMessage: (outMessage) => (model: Model) =>
            Dictation.OutMessage.match(outMessage, {
              DraftedText: ({ previous, text }) => ({
                model: modifyFields(model, {
                  input: (input) => Dictation.draft(input, previous, text),
                }),
              }),
            }),
        })(model, message),
      CompletedRestoreAssistant: ({ sessionId, collapsed }) => ({
        model: modifyFields(model, { sessionId: () => sessionId, collapsed: () => collapsed }),
        commands: [
          RequestAssistant({
            sessionId,
            sequence: model.sequence,
            path: "",
            body: Option.none(),
            delay: 0,
            sentInput: "",
          }),
        ],
      }),
      FailedRestoreAssistant: ({ error }) => ({
        model: modifyFields(model, { request: () => Request.Failed({ error }) }),
      }),
      ClickedCollapse: () => ({
        model: modifyFields(model, { collapsed: (value) => !value, dictation: Dictation.cancel }),
        commands: [PersistCollapsed({ collapsed: !model.collapsed })],
      }),
      CompletedPersistCollapsed: () => ({ model }),
      ClickedNewThread: () => startThread("")(model),
      CompletedCreateThread: ({ sessionId, input }) => {
        const opened = openThread(model, sessionId, input);
        return { model: opened.model, commands: [...(opened.commands ?? []), FocusInput()] };
      },
      FailedCreateThread: ({ error }) => ({
        model: modifyFields(model, { request: () => Request.Failed({ error }) }),
      }),
      CompletedFocusInput: () => ({ model }),
      ClickedHistory: () =>
        Panel.guards.History(model.panel)
          ? { model: modifyFields(model, { panel: () => Panel.Chat() }) }
          : {
              model: modifyFields(model, {
                panel: () => Panel.History({ threads: ThreadList.Loading(), showArchived: false }),
                clearing: () => Clearing.Idle(),
              }),
              commands: [LoadThreads()],
            },
      SucceededLoadThreads: ({ threads }) => ({
        model: modifyFields(model, {
          panel: (panel) =>
            Panel.guards.History(panel)
              ? Panel.History({ ...panel, threads: ThreadList.Ready({ threads }) })
              : panel,
        }),
      }),
      FailedLoadThreads: ({ error }) => ({
        model: modifyFields(model, {
          panel: (panel) =>
            Panel.guards.History(panel)
              ? Panel.History({ ...panel, threads: ThreadList.Failed({ error }) })
              : panel,
        }),
      }),
      ClickedShowArchived: () => ({
        model: modifyFields(model, {
          panel: (panel) =>
            Panel.guards.History(panel)
              ? Panel.History({ ...panel, showArchived: !panel.showArchived })
              : panel,
        }),
      }),
      ClickedThread: ({ sessionId }) => {
        if (sessionId === model.sessionId) {
          return { model: modifyFields(model, { panel: () => Panel.Chat() }) };
        }
        const opened = openThread(model, sessionId, "");
        return {
          model: opened.model,
          commands: [...(opened.commands ?? []), PersistSession({ sessionId })],
        };
      },
      CompletedPersistSession: () => ({ model }),
      ClickedArchiveThread: ({ sessionId, archived }) => ({
        model,
        commands: [ArchiveThread({ sessionId, archived })],
      }),
      SucceededArchiveThread: ({ sessionId, archived, threads }) => {
        const listed = modifyFields(model, {
          panel: (panel) =>
            Panel.guards.History(panel)
              ? Panel.History({ ...panel, threads: ThreadList.Ready({ threads }) })
              : panel,
        });
        // Archiving the open thread puts it away, so the panel moves on to a fresh one.
        return archived && sessionId === model.sessionId
          ? { model: listed, commands: [CreateThread({ input: "" })] }
          : { model: listed };
      },
      FailedArchiveThread: ({ error }) =>
        Option.match(historyOf(model), {
          onNone: () => ({ model }),
          onSome: (history) => ({
            model: modifyFields(model, {
              panel: () => Panel.History({ ...history, threads: ThreadList.Failed({ error }) }),
            }),
          }),
        }),
      ClickedClearThread: () => ({
        model: modifyFields(model, { clearing: () => Clearing.Confirming() }),
      }),
      ClickedCancelClear: () => ({
        model: modifyFields(model, { clearing: () => Clearing.Idle() }),
      }),
      ClickedConfirmClear: () => {
        const cleared = request(
          modifyFields(model, { clearing: () => Clearing.Idle() }),
          "/clear",
          {},
        );
        return {
          ...cleared,
          model: modifyFields(cleared.model, { maybeQuestionnaire: () => Option.none() }),
        };
      },
      ClickedStop: () => (turnInProgress(model) ? request(model, "/stop", {}) : { model }),
      ClickedFollow: () => {
        const nextModel = modifyFields(model, { follow: (value) => !value });
        if (model.follow || model.sessionId === "" || Request.guards.Sending(model.request)) {
          return { model: nextModel };
        }
        const sequence = model.sequence + 1;
        return {
          model: modifyFields(nextModel, { sequence: () => sequence }),
          commands: [
            RequestAssistant({
              sessionId: model.sessionId,
              sequence,
              path: "",
              body: Option.none(),
              delay: 0,
              sentInput: "",
            }),
          ],
        };
      },
      ClickedRetry: () => {
        if (model.sessionId === "") {
          return { model, commands: [RestoreAssistant()] };
        }
        const sequence = model.sequence + 1;
        return {
          model: modifyFields(model, { sequence: () => sequence, request: () => Request.Ready() }),
          commands: [
            RequestAssistant({
              sessionId: model.sessionId,
              sequence,
              path: "",
              body: Option.none(),
              delay: 0,
              sentInput: "",
            }),
          ],
        };
      },
      UpdatedInput: ({ value }) => ({
        model: modifyFields(model, { input: () => value, dictation: Dictation.edited }),
      }),
      SubmittedChat: () =>
        Dictation.active(model.dictation) ||
        model.input.trim() === "" ||
        Option.exists(
          model.maybeState,
          (state) => state.status !== "idle" && state.status !== "failed",
        )
          ? { model }
          : request(model, "/chat", { message: model.input, context }, model.input),
      ClickedConfirmation: ({ approved }) =>
        Option.match(model.maybeState, {
          onNone: () => ({ model }),
          onSome: (state) =>
            state.confirmation === undefined
              ? { model }
              : request(model, "/confirmation", { proposalId: state.confirmation.id, approved }),
        }),
      ClickedOption: ({ question, label }) =>
        Option.match(model.maybeQuestionnaire, {
          onNone: () => ({ model }),
          onSome: (questionnaire) => {
            const questions = Option.isSome(model.maybeState)
              ? model.maybeState.value.questions
              : undefined;
            const current = questions?.questions[question];
            return current === undefined
              ? { model }
              : {
                  model: modifyFields(model, {
                    maybeQuestionnaire: () =>
                      Option.some(Questionnaire.choose(questionnaire, current, question, label)),
                  }),
                };
          },
        }),
      UpdatedAnswer: ({ question, value }) => ({
        model: modifyFields(model, {
          maybeQuestionnaire: (maybe) =>
            Option.map(maybe, (questionnaire) =>
              Questionnaire.write(questionnaire, question, value),
            ),
        }),
      }),
      ClickedAnswers: ({ skipped }) =>
        Option.match(model.maybeQuestionnaire, {
          onNone: () => ({ model }),
          onSome: (questionnaire) =>
            request(model, "/answers", {
              callId: questionnaire.chatId,
              answer: skipped
                ? Questionnaire.skipped(questionnaire)
                : Questionnaire.answerOf(questionnaire),
            }),
        }),
      FailedRequest: ({ sessionId, sequence, error }) =>
        sessionId !== model.sessionId || sequence !== model.sequence
          ? { model }
          : { model: modifyFields(model, { request: () => Request.Failed({ error }) }) },
      SucceededRequest: ({ sessionId, sequence, state, sentInput }) => {
        if (
          sessionId !== model.sessionId ||
          sequence !== model.sequence ||
          state.sessionId !== sessionId
        ) {
          return { model };
        }
        const completed = state.activities.some(
          (activity) =>
            Option.isSome(model.maybeState) &&
            activity.status === "completed" &&
            !Option.exists(model.maybeState, (previous) =>
              previous.activities.some(
                (old) => old.id === activity.id && old.status === "completed",
              ),
            ),
        );
        // A thread just opened shows what it did before; following starts from what it does next.
        const isFirstRead = Option.isNone(model.maybeState);
        const follow = Array.findLast(
          state.activities,
          (activity) =>
            !isFirstRead &&
            activity.href !== undefined &&
            trustedHref(activity.href) &&
            !model.seenActivities.includes(activityKey(activity.id, activity.href)),
        );
        const nextSequence = sequence + 1;
        const nextModel = modifyFields(model, {
          maybeState: () => Option.some(state),
          request: () => Request.Ready(),
          sequence: () => nextSequence,
          input: (input) => (sentInput !== "" && input === sentInput ? "" : input),
          maybeQuestionnaire: (maybe) => {
            const questions = state.questions;
            return questions === undefined
              ? Option.none()
              : Option.some(
                  Option.getOrElse(
                    Option.filter(
                      maybe,
                      (questionnaire) => questionnaire.chatId === questions.callId,
                    ),
                    () => Questionnaire.start(questions.callId, questions.questions),
                  ),
                );
          },
          seenActivities: (seen) =>
            model.follow || isFirstRead
              ? Array.dedupe([
                  ...seen,
                  ...state.activities.flatMap((activity) =>
                    activity.href === undefined ? [] : [activityKey(activity.id, activity.href)],
                  ),
                ])
              : seen,
        });
        const commands =
          state.status === "working"
            ? [
                RequestAssistant({
                  sessionId,
                  sequence: nextSequence,
                  path: "",
                  body: Option.none(),
                  delay: 1000,
                  sentInput: "",
                }),
              ]
            : [];
        if (model.follow && !dirty && Option.isSome(follow) && follow.value.href !== undefined) {
          return {
            model: nextModel,
            commands,
            outMessage: OutMessage.RequestedFollow({ href: follow.value.href, completed }),
          };
        }
        return completed
          ? { model: nextModel, commands, outMessage: OutMessage.UpdatedResources() }
          : { model: nextModel, commands };
      },
    });
