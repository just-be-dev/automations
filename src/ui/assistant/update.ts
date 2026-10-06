import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import type { PageContext } from "../../assistant/model.ts";
import { Questionnaire } from "../domain/index.ts";
import { PersistCollapsed, RequestAssistant, RestoreAssistant } from "./command.ts";
import { Message } from "./message.ts";
import { type Model, Request } from "./model.ts";

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
export const update =
  (context: PageContext, dirty: boolean) =>
  (model: Model, message: Message): Return =>
    Message.match<Return>(message, {
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
        model: modifyFields(model, { collapsed: (value) => !value }),
        commands: [PersistCollapsed({ collapsed: !model.collapsed })],
      }),
      CompletedPersistCollapsed: () => ({ model }),
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
      UpdatedInput: ({ value }) => ({ model: modifyFields(model, { input: () => value }) }),
      SubmittedChat: () =>
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
            activity.status === "completed" &&
            !Option.exists(model.maybeState, (previous) =>
              previous.activities.some(
                (old) => old.id === activity.id && old.status === "completed",
              ),
            ),
        );
        const follow = Array.findLast(
          state.activities,
          (activity) =>
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
            model.follow
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
