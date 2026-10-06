import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { Question, QuestionsAnswer } from "../../workflow.ts";
import { FocusOwnAnswer, SendAnswers } from "../command.ts";
import { Questionnaire } from "../domain/index.ts";
import type { Message } from "../message.ts";
import { Activity, type Model, openQuestionnaire } from "../model.ts";

type UpdateReturn = Update.Return<Model, Message>;

// The person answers the questions the agent is waiting on one at a time. With one question, its
// answer is sent as soon as it's complete; with several, a review comes before sending them
// together. Sending resumes the agent's reply.

/** Runs `answer` on the open questionnaire, unless the message is about questions already answered. */
const answering = (
  model: Model,
  chatId: string,
  answer: (
    questionnaire: Questionnaire.Questionnaire,
    questions: Array.NonEmptyReadonlyArray<Question>,
  ) => UpdateReturn,
): UpdateReturn =>
  Option.match(
    Option.filter(openQuestionnaire(model), ({ questionnaire }) => questionnaire.chatId === chatId),
    {
      onNone: () => ({ model }),
      onSome: ({ questionnaire, questions }) => answer(questionnaire, questions),
    },
  );

const keep = (model: Model, questionnaire: Questionnaire.Questionnaire): Model =>
  modifyFields(model, { maybeQuestionnaire: () => Option.some(questionnaire) });

const isSingle = (questions: ReadonlyArray<Question>) => Array.length(questions) === 1;

const sendAnswer = (
  model: Model,
  questionnaire: Questionnaire.Questionnaire,
  answer: QuestionsAnswer,
): UpdateReturn =>
  Activity.guards.Working(model.activity)
    ? { model }
    : {
        model: modifyFields(keep(model, questionnaire), {
          activity: () => Activity.Working({ notice: "Sending your answers…" }),
        }),
        commands: [
          SendAnswers({
            automationId: model.automationId.trim(),
            revision: model.revision,
            chatId: questionnaire.chatId,
            answer,
          }),
        ],
      };

const send = (model: Model, questionnaire: Questionnaire.Questionnaire): UpdateReturn =>
  Questionnaire.hasAnyAnswer(questionnaire)
    ? sendAnswer(model, questionnaire, Questionnaire.answerOf(questionnaire))
    : { model: keep(model, questionnaire) };

export const showQuestionStep = (model: Model, chatId: string, step: number) =>
  answering(model, chatId, (questionnaire) => ({
    model: keep(model, Questionnaire.goTo(questionnaire, step)),
  }));

/** Picks an option. A single choice moves on to the next question, or sends a lone question. */
export const chooseOption = (model: Model, chatId: string, index: number, label: string) =>
  answering(model, chatId, (questionnaire, questions) =>
    Option.match(Array.get(questions, index), {
      onNone: () => ({ model }),
      onSome: (question) => {
        const chosen = Questionnaire.choose(questionnaire, question, index, label);
        if (question.multiSelect === true) {
          return { model: keep(model, chosen) };
        }
        return isSingle(questions)
          ? send(model, chosen)
          : { model: keep(model, Questionnaire.advanceFrom(chosen, index)) };
      },
    }),
  );

export const writeOwnAnswer = (model: Model, chatId: string, index: number) =>
  answering(model, chatId, (questionnaire) => ({
    model: keep(model, Questionnaire.startWriting(questionnaire, index)),
    commands: [FocusOwnAnswer()],
  }));

export const updateOwnAnswer = (model: Model, chatId: string, index: number, text: string) =>
  answering(model, chatId, (questionnaire) => ({
    model: keep(model, Questionnaire.write(questionnaire, index, text)),
  }));

/** Leaves a question, answered or not, for the next one; a lone question is sent instead. */
export const nextQuestion = (model: Model, chatId: string, index: number) =>
  answering(model, chatId, (questionnaire, questions) =>
    isSingle(questions)
      ? send(model, questionnaire)
      : { model: keep(model, Questionnaire.goTo(questionnaire, index + 1)) },
  );

export const sendAnswers = (model: Model, chatId: string) =>
  answering(model, chatId, (questionnaire) => send(model, questionnaire));

/** Sends every question as skipped, so the agent carries on with its best judgment. */
export const skipQuestions = (model: Model, chatId: string) =>
  answering(model, chatId, (questionnaire) =>
    sendAnswer(model, questionnaire, Questionnaire.skipped(questionnaire)),
  );
