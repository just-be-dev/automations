/** Walks the person through the planner's questions and answer review, with choices, written answers, and skips.
 * Also presents completed question rounds in the conversation. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  Check,
  Circle,
  CircleCheck,
  MessageCircleQuestionMark,
  Pencil,
  Square,
  SquareCheck,
} from "lucide";
import { button } from "@/components/ui/button";
import { componentName } from "@/lib/component";
import { textarea } from "@/components/ui/textarea";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { AskedQuestions, Question, QuestionOption } from "../../workflow.ts";
import { ownAnswerId } from "../constant.ts";
import { Questionnaire } from "../domain/index.ts";
import { Message } from "../message.ts";
import type { ShortcutModifier } from "../platform.ts";
import { submitShortcut } from "./shared.ts";

const cardClass = "mt-1 flex flex-col gap-3 rounded-xl bg-background p-3 shadow-card";

const optionTextView = (option: QuestionOption, h: HtmlBuilder<Message>) =>
  h.span(
    [componentName("option-text"), h.Class("flex min-w-0 flex-col gap-0.5")],
    [
      h.span([h.Class("font-medium")], [option.label]),
      option.description === undefined
        ? h.empty
        : h.span([h.Class("text-xs font-normal text-muted-foreground")], [option.description]),
    ],
  );

/** What the person sees while answering: the step, whether they can act, and how they send. */
export interface QuestionnaireContext {
  readonly chatId: string;
  readonly questions: Array.NonEmptyReadonlyArray<Question>;
  readonly questionnaire: Questionnaire.Questionnaire;
  readonly isBusy: boolean;
  readonly shortcutModifier: ShortcutModifier;
}

const isSingle = (context: QuestionnaireContext) => Array.length(context.questions) === 1;

const questionStepsView = (context: QuestionnaireContext, h: HtmlBuilder<Message>) => {
  const { chatId, questionnaire } = context;
  const questionStepButton = (step: number, label: string, isDone: boolean) =>
    h.li(
      [componentName("question-step-button")],
      [
        h.button(
          [
            h.Type("button"),
            h.Class(
              cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-50",
                questionnaire.step === step
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground",
              ),
            ),
            ...(questionnaire.step === step ? [h.AriaCurrent("step")] : []),
            h.Disabled(context.isBusy),
            h.OnClick(Message.ClickedQuestionStep({ chatId, step })),
          ],
          [
            isDone
              ? icon(h, Check, "size-3 text-success")
              : h.span([h.Class("size-3"), h.AriaHidden(true)]),
            label,
          ],
        ),
      ],
    );
  return h.nav(
    [componentName("question-steps"), h.AriaLabel("Questions")],
    [
      h.ol(
        [h.Class("flex flex-wrap gap-1")],
        [
          ...Array.map(context.questions, (question, index) =>
            questionStepButton(
              index,
              question.header,
              Questionnaire.isAnswered(Questionnaire.answerAt(questionnaire, index)),
            ),
          ),
          questionStepButton(
            Array.length(context.questions),
            "Review",
            Questionnaire.hasAnyAnswer(questionnaire),
          ),
        ],
      ),
    ],
  );
};

const questionOptionView = (
  context: QuestionnaireContext,
  question: Question,
  index: number,
  option: QuestionOption,
  h: HtmlBuilder<Message>,
) => {
  const isChosen = Questionnaire.isChosen(
    Questionnaire.answerAt(context.questionnaire, index),
    option.label,
  );
  const marker =
    question.multiSelect === true
      ? isChosen
        ? SquareCheck
        : Square
      : isChosen
        ? CircleCheck
        : Circle;
  return h.li(
    [componentName("question-option")],
    [
      button(
        {
          variant: "outline",
          onClick: Message.ClickedQuestionOption({
            chatId: context.chatId,
            question: index,
            label: option.label,
          }),
          isDisabled: context.isBusy,
          className: cn(
            "h-auto w-full items-start justify-start gap-2.5 py-2 text-left whitespace-normal",
            isChosen && "ring-2 ring-signal/40",
          ),
          attributes: [h.AriaPressed(isChosen ? "true" : "false")],
        },
        [
          icon(h, marker, cn("mt-0.5 size-4", isChosen ? "text-signal" : "text-sand-8")),
          optionTextView(option, h),
        ],
        h,
      ),
    ],
  );
};

const ownAnswerView = (context: QuestionnaireContext, index: number, h: HtmlBuilder<Message>) => {
  const answer = Questionnaire.answerAt(context.questionnaire, index);
  return Questionnaire.Answer.guards.Wrote(answer)
    ? textarea(
        {
          id: ownAnswerId,
          wrapperAttributes: [componentName("own-answer")],
          label: "Your own answer",
          labelClass: "text-xs text-muted-foreground",
          value: answer.text,
          isDisabled: context.isBusy,
          onInput: (text) =>
            Message.UpdatedOwnAnswer({ chatId: context.chatId, question: index, text }),
          attributes: submitShortcut(
            context.shortcutModifier,
            Message.ClickedNextQuestion({ chatId: context.chatId, question: index }),
            h,
          ),
          className: "min-h-16",
        },
        h,
      )
    : button(
        {
          variant: "ghost",
          attributes: [componentName("own-answer")],
          onClick: Message.ClickedWriteOwnAnswer({
            chatId: context.chatId,
            question: index,
          }),
          isDisabled: context.isBusy,
          className: "w-full justify-start gap-2.5 text-muted-foreground",
        },
        [icon(h, Pencil, "size-4"), "Write your own answer"],
        h,
      );
};

const nextLabel = (context: QuestionnaireContext, isAnswered: boolean) => {
  if (isSingle(context)) {
    return "Send answer";
  }
  return isAnswered ? "Next" : "Skip";
};

const questionStepView = (
  context: QuestionnaireContext,
  question: Question,
  index: number,
  h: HtmlBuilder<Message>,
) => {
  const answer = Questionnaire.answerAt(context.questionnaire, index);
  const isAnswered = Questionnaire.isAnswered(answer);
  const hasNext =
    !isSingle(context) ||
    question.multiSelect === true ||
    Questionnaire.Answer.guards.Wrote(answer);
  return h.div(
    [componentName("question-step"), h.Class("flex flex-col gap-2.5")],
    [
      h.div(
        [h.Class("flex flex-col gap-0.5")],
        [
          h.p([h.Class("text-sm font-medium")], [question.question]),
          question.multiSelect === true
            ? h.p([h.Class("text-xs text-muted-foreground")], ["Pick any that apply."])
            : h.empty,
        ],
      ),
      h.ul(
        [h.Class("flex flex-col gap-1.5")],
        Array.map(question.options, (option) =>
          questionOptionView(context, question, index, option, h),
        ),
      ),
      ownAnswerView(context, index, h),
      hasNext
        ? h.div(
            [h.Class("flex justify-end")],
            [
              button(
                {
                  variant: isAnswered ? "default" : "ghost",
                  size: "sm",
                  onClick: Message.ClickedNextQuestion({
                    chatId: context.chatId,
                    question: index,
                  }),
                  isDisabled: context.isBusy || (isSingle(context) && !isAnswered),
                },
                [nextLabel(context, isAnswered)],
                h,
              ),
            ],
          )
        : h.empty,
    ],
  );
};

const answersReviewView = (context: QuestionnaireContext, h: HtmlBuilder<Message>) => {
  const unanswered = Questionnaire.unansweredHeaders(context.questionnaire, context.questions);
  return h.div(
    [componentName("answers-review"), h.Class("flex flex-col gap-2.5")],
    [
      h.p([h.Class("text-sm font-medium")], ["Review your answers"]),
      h.dl(
        [h.Class("flex flex-col gap-2 text-sm")],
        Array.map(context.questions, (question, index) =>
          h.div(
            [h.Class("flex flex-col gap-0.5")],
            [
              h.dt([h.Class("text-xs text-muted-foreground")], [question.question]),
              h.dd(
                [h.Class("whitespace-pre-wrap")],
                [
                  Option.match(
                    Questionnaire.answerText(Questionnaire.answerAt(context.questionnaire, index)),
                    {
                      onNone: () => h.span([h.Class("text-muted-foreground")], ["No answer"]),
                      onSome: (answer) => answer,
                    },
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
      Array.match(unanswered, {
        onEmpty: () => h.empty,
        onNonEmpty: (headers) =>
          h.p(
            [h.Class("text-xs text-muted-foreground")],
            [`Not answered yet: ${Array.join(headers, ", ")}. You can send without them.`],
          ),
      }),
      h.div(
        [h.Class("flex justify-end")],
        [
          button(
            {
              size: "sm",
              onClick: Message.ClickedSendAnswers({ chatId: context.chatId }),
              isDisabled: context.isBusy || !Questionnaire.hasAnyAnswer(context.questionnaire),
            },
            ["Send answers"],
            h,
          ),
        ],
      ),
    ],
  );
};

/**
 * The questions the agent is waiting on, one step at a time, with a review when there are
 * several. Skipping sends no answers, and the agent carries on with its best judgment.
 */
export const openQuestionnaireView = (context: QuestionnaireContext, h: HtmlBuilder<Message>) =>
  h.div(
    [
      componentName("open-questionnaire"),
      h.Class(cardClass),
      h.Role("group"),
      h.AriaLabel("Questions from the agent"),
    ],
    [
      isSingle(context) ? h.empty : questionStepsView(context, h),
      Option.match(Array.get(context.questions, context.questionnaire.step), {
        onNone: () => answersReviewView(context, h),
        onSome: (question) => questionStepView(context, question, context.questionnaire.step, h),
      }),
      h.div(
        [h.Class("flex items-center justify-between gap-3 border-t pt-2.5")],
        [
          h.span(
            [h.Class("text-xs text-muted-foreground")],
            ["The agent is waiting for your answers."],
          ),
          button(
            {
              variant: "ghost",
              size: "xs",
              onClick: Message.ClickedSkipQuestions({ chatId: context.chatId }),
              isDisabled: context.isBusy,
              className: "text-muted-foreground",
            },
            ["Skip questions"],
            h,
          ),
        ],
      ),
    ],
  );

/** Questions the agent asked and the person has answered, which their answers follow. */
export const askedQuestionsView = (
  questions: ReadonlyArray<Question>,
  h: HtmlBuilder<Message>,
): Html =>
  h.ul(
    [
      componentName("asked-questions"),
      h.Class(cn(cardClass, "gap-2 text-sm")),
      h.AriaLabel("Questions from the agent, answered"),
    ],
    Array.map(questions, (question) =>
      h.li(
        [h.Class("flex items-start gap-2")],
        [
          icon(h, MessageCircleQuestionMark, "mt-0.5 size-3.5 shrink-0 text-sand-9"),
          question.question,
        ],
      ),
    ),
  );

const isSkipped = (answer: string | null | undefined) =>
  answer === null || answer === undefined || answer.trim() === "";

/** The person's answers, as they sent them: each question's name and answer, or their message. */
export const answersView = (asked: AskedQuestions, h: HtmlBuilder<Message>): Html => {
  if (asked.answer.kind === "message") {
    return h.p([componentName("answers"), h.Class("whitespace-pre-wrap")], [asked.answer.text]);
  }
  const { answers } = asked.answer;
  if (Array.every(answers, isSkipped)) {
    return h.p([componentName("answers"), h.Class("italic")], ["Skipped the questions"]);
  }
  return h.dl(
    [componentName("answers"), h.Class("flex flex-col gap-1.5"), h.AriaLabel("Your answers")],
    Array.map(asked.questions, (question, index) => {
      const answer = answers[index];
      return h.div(
        [h.Class("flex flex-col")],
        [
          h.dt([h.Class("text-xs text-muted-foreground")], [question.header]),
          h.dd(
            [h.Class("whitespace-pre-wrap")],
            [isSkipped(answer) ? h.span([h.Class("italic")], ["Skipped"]) : (answer ?? "")],
          ),
        ],
      );
    }),
  );
};
