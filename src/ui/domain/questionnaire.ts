import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import type { Question, QuestionsAnswer } from "../../workflow.ts";

/** How the person has answered one of the agent's questions so far. */
export const Answer = defineTaggedUnion({
  Unanswered: {},
  Chose: { labels: Schema.NonEmptyArray(Schema.String) },
  Wrote: { text: Schema.String },
});
export type Answer = typeof Answer.Type;

/**
 * The answers to the questions the agent is waiting on while it answers the message `chatId`, and
 * the step on screen: a question's index, or the review once `step` reaches the number of
 * questions.
 */
export const Questionnaire = Schema.Struct({
  chatId: Schema.String,
  step: Schema.Int,
  answers: Schema.Array(Answer),
});
export type Questionnaire = typeof Questionnaire.Type;

export const start = (chatId: string, questions: ReadonlyArray<Question>): Questionnaire => ({
  chatId,
  step: 0,
  answers: Array.map(questions, () => Answer.Unanswered()),
});

export const answerAt = (questionnaire: Questionnaire, index: number): Answer =>
  Option.getOrElse(Array.get(questionnaire.answers, index), () => Answer.Unanswered());

export const isAnswered = (answer: Answer) =>
  Answer.match(answer, {
    Unanswered: () => false,
    Chose: () => true,
    Wrote: ({ text }) => text.trim() !== "",
  });

/** The answer as the agent reads it, unless there is none. */
export const answerText = (answer: Answer): Option.Option<string> =>
  Answer.match(answer, {
    Unanswered: () => Option.none(),
    Chose: ({ labels }) => Option.some(Array.join(labels, ", ")),
    Wrote: ({ text }) => (text.trim() === "" ? Option.none() : Option.some(text.trim())),
  });

export const isChosen = (answer: Answer, label: string) =>
  Answer.guards.Chose(answer) && Array.contains(answer.labels, label);

const setAnswer = (questionnaire: Questionnaire, index: number, answer: Answer): Questionnaire =>
  modifyFields(questionnaire, {
    answers: (answers) =>
      Array.map(answers, (current, position) => (position === index ? answer : current)),
  });

/** Picks an option: the only one on a single-choice question, one more (or one fewer) otherwise. */
export const choose = (
  questionnaire: Questionnaire,
  question: Question,
  index: number,
  label: string,
): Questionnaire => {
  const current = answerAt(questionnaire, index);
  if (question.multiSelect !== true || !Answer.guards.Chose(current)) {
    return setAnswer(questionnaire, index, Answer.Chose({ labels: [label] }));
  }
  const kept = Array.filter(current.labels, (chosen) => chosen !== label);
  const labels = Array.length(kept) === Array.length(current.labels) ? [...kept, label] : kept;
  return setAnswer(
    questionnaire,
    index,
    Array.match(labels, {
      onEmpty: () => Answer.Unanswered(),
      onNonEmpty: (chosen) => Answer.Chose({ labels: chosen }),
    }),
  );
};

/** Opens the question's own answer, keeping whatever was already written there. */
export const startWriting = (questionnaire: Questionnaire, index: number): Questionnaire => {
  const current = answerAt(questionnaire, index);
  return Answer.guards.Wrote(current)
    ? questionnaire
    : setAnswer(questionnaire, index, Answer.Wrote({ text: "" }));
};

export const write = (questionnaire: Questionnaire, index: number, text: string) =>
  setAnswer(questionnaire, index, Answer.Wrote({ text }));

export const goTo = (questionnaire: Questionnaire, step: number): Questionnaire =>
  modifyFields(questionnaire, {
    step: () => Math.max(0, Math.min(step, Array.length(questionnaire.answers))),
  });

/** Moves on from a question to the next one still unanswered, or to the review. */
export const advanceFrom = (questionnaire: Questionnaire, index: number): Questionnaire => {
  const count = Array.length(questionnaire.answers);
  const later = Array.filter(
    Array.makeBy(count, (offset) => (index + 1 + offset) % count),
    (next) => next !== index,
  );
  return goTo(
    questionnaire,
    Option.getOrElse(
      Array.findFirst(later, (next) => !isAnswered(answerAt(questionnaire, next))),
      () => count,
    ),
  );
};

export const unansweredHeaders = (
  questionnaire: Questionnaire,
  questions: ReadonlyArray<Question>,
): ReadonlyArray<string> =>
  Array.map(
    Array.filter(questions, (_, index) => !isAnswered(answerAt(questionnaire, index))),
    (question) => question.header,
  );

export const hasAnyAnswer = (questionnaire: Questionnaire) =>
  Array.some(questionnaire.answers, isAnswered);

/** The answers to send, in question order; a question without one is skipped. */
export const answerOf = (questionnaire: Questionnaire): QuestionsAnswer => ({
  kind: "answers",
  answers: Array.map(questionnaire.answers, (answer) => Option.getOrNull(answerText(answer))),
});

/** Every question skipped, for when the person would rather not answer. */
export const skipped = (questionnaire: Questionnaire): QuestionsAnswer => ({
  kind: "answers",
  answers: Array.map(questionnaire.answers, () => null),
});
