import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Check, Circle, CircleCheck, Pencil, Square, SquareCheck } from "lucide";
import { button } from "@/components/ui/button";
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

const optionText = (option: QuestionOption, h: HtmlBuilder<Message>) =>
  h.span(
    [h.Class("flex min-w-0 flex-col gap-0.5")],
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

const stepsView = (context: QuestionnaireContext, h: HtmlBuilder<Message>) => {
  const { chatId, questionnaire } = context;
  const stepButton = (step: number, label: string, isDone: boolean) =>
    h.li(
      [],
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
    [h.AriaLabel("Questions")],
    [
      h.ol(
        [h.Class("flex flex-wrap gap-1")],
        [
          ...Array.map(context.questions, (question, index) =>
            stepButton(
              index,
              question.header,
              Questionnaire.isAnswered(Questionnaire.answerAt(questionnaire, index)),
            ),
          ),
          stepButton(
            Array.length(context.questions),
            "Review",
            Questionnaire.hasAnyAnswer(questionnaire),
          ),
        ],
      ),
    ],
  );
};

const optionView = (
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
    [],
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
          optionText(option, h),
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
          className: "min-h-16 bg-background",
        },
        h,
      )
    : button(
        {
          variant: "ghost",
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
    [h.Class("flex flex-col gap-2.5")],
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
        Array.map(question.options, (option) => optionView(context, question, index, option, h)),
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

const reviewView = (context: QuestionnaireContext, h: HtmlBuilder<Message>) => {
  const unanswered = Questionnaire.unansweredHeaders(context.questionnaire, context.questions);
  return h.div(
    [h.Class("flex flex-col gap-2.5")],
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
    [h.Class(cardClass), h.Role("group"), h.AriaLabel("Questions from the agent")],
    [
      isSingle(context) ? h.empty : stepsView(context, h),
      Option.match(Array.get(context.questions, context.questionnaire.step), {
        onNone: () => reviewView(context, h),
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

/** Questions the agent asked while it answered, and how the person answered them. */
export const answeredQuestionsView = (asked: AskedQuestions, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class(cn(cardClass, "gap-2.5 text-sm"))],
    asked.answer.kind === "message"
      ? [
          h.ul(
            [h.Class("flex flex-col gap-1 text-muted-foreground")],
            Array.map(asked.questions, (question) => h.li([], [question.question])),
          ),
          h.div(
            [h.Class("flex flex-col gap-0.5")],
            [
              h.span(
                [h.Class("text-xs text-muted-foreground")],
                ["You answered in your own words"],
              ),
              h.p([h.Class("whitespace-pre-wrap")], [asked.answer.text]),
            ],
          ),
        ]
      : [
          h.dl(
            [h.Class("flex flex-col gap-2")],
            Array.map(asked.questions, (question, index) => {
              const answer = asked.answer.kind === "answers" ? asked.answer.answers[index] : null;
              return h.div(
                [h.Class("flex flex-col gap-0.5")],
                [
                  h.dt([h.Class("text-xs text-muted-foreground")], [question.question]),
                  h.dd(
                    [h.Class("flex items-start gap-1.5 whitespace-pre-wrap")],
                    answer === null || answer === undefined || answer.trim() === ""
                      ? [h.span([h.Class("text-muted-foreground")], ["Skipped"])]
                      : [icon(h, CircleCheck, "mt-0.5 size-3.5 shrink-0 text-success"), answer],
                  ),
                ],
              );
            }),
          ),
        ],
  );
