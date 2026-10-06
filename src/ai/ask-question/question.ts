import * as Schema from "effect/Schema";

/**
 * The questions an agent asks the person with `ask_question`, the answers the person may pick
 * from, and how they answered. Asking parks the agent's turn until the person answers: the studio
 * walks them through the questions one at a time, each option is a button, every question also
 * takes an answer in their own words, and the answers return to the agent as the tool's result.
 */

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

/** The row the studio adds to every question, so an option can't take its label. */
export const OWN_ANSWER_LABEL = "Write your own answer";

// Models reach for "Other", but the studio's own answer row already covers it.
const reservedLabels = ["other", "none of these", OWN_ANSWER_LABEL.toLowerCase()];

export const QuestionOption = Schema.Struct({
  /** What the button says, and what the answer reads when the person picks it. */
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
});
export interface QuestionOption extends Schema.Schema.Type<typeof QuestionOption> {}

export const Question = Schema.Struct({
  question: Schema.String,
  /** A short name for the question, shown on its tab when there are several. */
  header: Schema.String,
  options: Schema.Array(QuestionOption),
  /** Whether the person may pick more than one option. */
  multiSelect: Schema.optionalKey(Schema.Boolean),
});
export interface Question extends Schema.Schema.Type<typeof Question> {}

const quoted = (text: string) => JSON.stringify(text.trim());

/** Values given more than once, ignoring case, surrounding spaces, and blanks, as first written. */
const repeated = (values: ReadonlyArray<string>) => {
  const key = (value: string) => value.trim().toLowerCase();
  return values.filter(
    (value, index) =>
      key(value) !== "" &&
      values.findIndex((other) => key(other) === key(value)) === index &&
      values.some((other, otherIndex) => otherIndex !== index && key(other) === key(value)),
  );
};

const questionProblems = (question: Question, index: number): ReadonlyArray<string> => {
  const name = `Question ${index + 1}`;
  const labels = question.options.map((option) => option.label);
  return [
    ...(question.question.trim() === "" ? [`${name} has no text.`] : []),
    ...(question.header.trim() === ""
      ? [`${name} has no header: give it a short name, such as "Approver".`]
      : question.header.length > MAX_HEADER_LENGTH
        ? [
            `${name}'s header ${quoted(question.header)} is longer than ${MAX_HEADER_LENGTH} characters.`,
          ]
        : []),
    ...(question.options.length < MIN_OPTIONS
      ? [
          `${name} has ${question.options.length} option${question.options.length === 1 ? "" : "s"}; give it at least ${MIN_OPTIONS}, or ask it in your answer instead.`,
        ]
      : question.options.length > MAX_OPTIONS
        ? [
            `${name} has ${question.options.length} options; give it at most ${MAX_OPTIONS}, the likeliest ones. The person can still write their own answer.`,
          ]
        : []),
    ...labels.flatMap((label, option) =>
      label.trim() === ""
        ? [`${name}'s option ${option + 1} has no label.`]
        : label.length > MAX_LABEL_LENGTH
          ? [
              `${name}'s option ${quoted(label)} is longer than ${MAX_LABEL_LENGTH} characters: keep labels to a few words, and explain in "description".`,
            ]
          : reservedLabels.includes(label.trim().toLowerCase())
            ? [
                `${name}'s option ${quoted(label)} isn't needed: the studio already lets the person write their own answer. Remove it.`,
              ]
            : [],
    ),
    ...repeated(labels).map(
      (label) => `${name} has more than one option labelled ${quoted(label)}.`,
    ),
  ];
};

/**
 * Everything that keeps the questions from being shown, in words the agent can act on. Every
 * problem is listed, so one correction can fix them all.
 */
export const questionnaireProblems = (
  questions: ReadonlyArray<Question>,
): ReadonlyArray<string> => [
  ...(questions.length === 0 ? ["Ask at least 1 question."] : []),
  ...(questions.length > MAX_QUESTIONS
    ? [
        `You asked ${questions.length} questions; ask at most ${MAX_QUESTIONS} at a time. Ask the ones you need first, and the rest once they're answered.`,
      ]
    : []),
  ...repeated(questions.map((question) => question.question)).map(
    (question) => `The question ${quoted(question)} is asked more than once.`,
  ),
  ...repeated(questions.map((question) => question.header)).map(
    (header) => `More than one question has the header ${quoted(header)}; give each its own.`,
  ),
  ...questions.flatMap(questionProblems),
];

/**
 * How the person answered: an answer per question, in order (`null` for one they skipped), or a
 * message they wrote instead of picking answers.
 */
export const QuestionsAnswer = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("answers"),
    answers: Schema.Array(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ kind: Schema.Literal("message"), text: Schema.String }),
]);
export type QuestionsAnswer = typeof QuestionsAnswer.Type;

/** Questions an agent asked in one call, and how the person answered them. */
export const AskedQuestions = Schema.Struct({
  questions: Schema.Array(Question),
  answer: QuestionsAnswer,
});
export interface AskedQuestions extends Schema.Schema.Type<typeof AskedQuestions> {}

export const MAX_ANSWER_LENGTH = 2_000;

/** What keeps an answer from fitting the questions it answers. */
export const answerProblem = (
  questions: ReadonlyArray<Question>,
  answer: QuestionsAnswer,
): string | undefined => {
  if (answer.kind === "message") {
    return answer.text.trim() === "" || answer.text.length > 10_000
      ? "Message must be 1–10,000 characters"
      : undefined;
  }
  if (answer.answers.length !== questions.length) {
    return `Give one answer for each of the ${questions.length} questions`;
  }
  return answer.answers.some((text) => text !== null && text.length > MAX_ANSWER_LENGTH)
    ? `Keep each answer to ${MAX_ANSWER_LENGTH.toLocaleString("en-US")} characters`
    : undefined;
};

/** The tool result the agent reads once the person has answered. */
export const answerResult = (questions: ReadonlyArray<Question>, answer: QuestionsAnswer) => {
  if (answer.kind === "message") {
    return `Instead of picking answers, the person wrote:\n\n${answer.text.trim()}\n\nTreat this as their answer, and carry on.`;
  }
  const given = answer.answers.map((text) => (text === null ? "" : text.trim()));
  if (given.every((text) => text === "")) {
    return "The person skipped your questions. Carry on with your best judgment, and say in your answer what you assumed.";
  }
  return [
    "The person answered:",
    ...questions.map(
      (question, index) =>
        `- ${question.question} ${given[index] === "" || given[index] === undefined ? "(skipped)" : given[index]}`,
    ),
    "Carry on with their answers.",
  ].join("\n");
};
