/** Presents the planner conversation, pending progress or questions, and the person's message composer. */
import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Bot, CircleAlert, CornerDownLeft, LoaderCircle } from "lucide";
import { Bubble } from "@/components/ui/bubble";
import { button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { markdown } from "@/components/markdown";
import { Message as ChatMessage } from "@/components/ui/message";
import { textarea } from "@/components/ui/textarea";
import { componentName } from "@/lib/component";
import { icon } from "@/lib/icons";
import type { AskedQuestions, PendingChat } from "../../workflow.ts";
import { Message } from "../message.ts";
import {
  Activity,
  type Exchange,
  messageInputOf,
  type Model,
  openQuestionnaire,
} from "../model.ts";
import { answersView, askedQuestionsView, openQuestionnaireView } from "./questionnaire.ts";
import { characterCountView, submitShortcut } from "./shared.ts";

export const conversationView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [
      componentName("conversation"),
      h.Class("flex flex-col border-b lg:min-h-0 lg:border-r lg:border-b-0"),
      h.AriaLabel("Conversation"),
    ],
    [
      h.div(
        [
          h.Id("messages"),
          h.AriaLive("polite"),
          h.Class("flex flex-1 flex-col px-5 py-6 lg:overflow-y-auto"),
        ],
        [
          Array.match(conversationItems(model, h), {
            onEmpty: () =>
              Option.match(model.maybeDraft, {
                onNone: () =>
                  emptyConversationView(
                    "Describe what should happen",
                    "Say what starts the automation and what each step does. The draft on the right updates after every reply, so keep adjusting until it reads correctly.",
                    h,
                  ),
                onSome: () =>
                  emptyConversationView(
                    "No saved conversation",
                    "This draft was made before conversations were saved. Send a message to keep refining it; the agent still remembers the earlier turns.",
                    h,
                  ),
              }),
            onNonEmpty: (items) => ChatMessage.group({ className: "gap-7" }, items, h),
          }),
        ],
      ),
      composerView(model, h),
    ],
  );

const emptyConversationView = (title: string, description: string, h: HtmlBuilder<Message>) =>
  Empty(
    {
      className: "flex-none items-start p-0 pt-2 text-left",
      attributes: [componentName("empty-conversation")],
    },
    [
      Empty.header(
        { className: "items-start" },
        [
          Empty.title({ className: "text-xl font-semibold" }, [title], h),
          Empty.description({}, [description], h),
        ],
        h,
      ),
    ],
    h,
  );

const conversationItems = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  ...Array.map(model.conversation, (exchange) => exchangeView(exchange, h)),
  ...Option.match(model.maybePendingChat, {
    onNone: () => [],
    onSome: (pending) => [pendingChatView(model, pending, h)],
  }),
];

/** Something the person sent, on the right. */
const personView = (children: ReadonlyArray<Html | string>, h: HtmlBuilder<Message>) =>
  ChatMessage(
    { align: "end", attributes: [componentName("person")] },
    [
      ChatMessage.content(
        {},
        [Bubble({ variant: "secondary", align: "end" }, [Bubble.content({}, children, h)], h)],
        h,
      ),
    ],
    h,
  );

const promptView = (prompt: string, h: HtmlBuilder<Message>) =>
  personView([h.span([h.Class("whitespace-pre-wrap")], [prompt])], h);

const replyView = (children: ReadonlyArray<Html | string>, h: HtmlBuilder<Message>) =>
  ChatMessage(
    { attributes: [componentName("reply")] },
    [
      ChatMessage.content(
        { className: "gap-1.5" },
        [
          ChatMessage.header(
            { className: "gap-2 text-sm font-medium text-sand-10" },
            [
              h.span([h.Class("icon-tile"), h.AriaHidden(true)], [icon(h, Bot, "size-3.5")]),
              "Agent",
            ],
            h,
          ),
          Bubble({ variant: "ghost" }, [Bubble.content({}, children, h)], h),
        ],
        h,
      ),
    ],
    h,
  );

/** Questions the agent asked while it answered, then the person's answers to them. */
const askedView = (asked: AskedQuestions, h: HtmlBuilder<Message>) => [
  replyView([askedQuestionsView(asked.questions, h)], h),
  personView([answersView(asked, h)], h),
];

const exchangeView = (exchange: Exchange, h: HtmlBuilder<Message>) =>
  h.keyed("div")(
    String(exchange.id),
    [componentName("exchange"), h.Class("flex flex-col gap-4")],
    [
      promptView(exchange.prompt, h),
      ...Array.flatMap(exchange.asked, (asked) => askedView(asked, h)),
      replyView([markdown(exchange.reply, h)], h),
    ],
  );

const answeredSoFar = (pending: PendingChat): ReadonlyArray<AskedQuestions> =>
  pending.status === "failed" ? [] : (pending.asked ?? []);

const pendingChatView = (model: Model, pending: PendingChat, h: HtmlBuilder<Message>) =>
  h.keyed("div")(
    pending.id,
    [componentName("pending-chat"), h.Class("flex flex-col gap-4")],
    [
      promptView(pending.prompt, h),
      ...Array.flatMap(answeredSoFar(pending), (asked) => askedView(asked, h)),
      replyView(
        Match.value(pending).pipe(
          Match.discriminatorsExhaustive("status")({
            working: () => [
              h.span(
                [h.Class("flex items-center gap-2 text-muted-foreground")],
                [
                  icon(h, LoaderCircle, "size-3.5 shrink-0 animate-spin text-signal"),
                  h.span(
                    [h.Class("truncate")],
                    [Option.getOrElse(model.maybeProgress, () => "Thinking…")],
                  ),
                ],
              ),
            ],
            asking: () =>
              Option.match(openQuestionnaire(model), {
                onNone: () => [],
                onSome: ({ questions, questionnaire }) => [
                  openQuestionnaireView(
                    {
                      chatId: questionnaire.chatId,
                      questions,
                      questionnaire,
                      isBusy: Activity.guards.Working(model.activity),
                      shortcutModifier: model.shortcutModifier,
                    },
                    h,
                  ),
                ],
              }),
            failed: () => [
              h.span(
                [h.Class("flex items-center gap-2 text-destructive")],
                [icon(h, CircleAlert, "size-3.5"), "Sorry, I couldn't finish this one."],
              ),
            ],
          }),
        ),
        h,
      ),
    ],
  );

const composerView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("composer"), h.Class("p-3")],
    [
      h.div(
        [
          h.Class(
            "rounded-xl bg-background shadow-raised transition-shadow duration-200 focus-within:ring-3 focus-within:ring-ring/25",
          ),
        ],
        [
          textarea(
            {
              id: "message",
              label: "Your message",
              labelClass: "sr-only",
              value: messageInputOf(model),
              placeholder: Option.isSome(openQuestionnaire(model))
                ? "Or answer the agent in your own words…"
                : "When an order arrives, summarize its contents and send the summary to…",
              onInput: (value) => Message.UpdatedMessageInput({ value }),
              attributes: submitShortcut(model.shortcutModifier, Message.SubmittedMessage(), h),
              className:
                "max-h-60 min-h-20 resize-none border-0 bg-transparent px-3.5 pt-3 placeholder:text-muted-foreground/80 focus-visible:ring-0",
            },
            h,
          ),
          h.div(
            [h.Class("flex items-center justify-between gap-3 pr-2 pb-2 pl-3.5")],
            [
              characterCountView(messageInputOf(model).length, undefined, h),
              button(
                {
                  onClick: Message.SubmittedMessage(),
                  isDisabled: Activity.guards.Working(model.activity),
                  attributes: [h.Id("send")],
                },
                ["Send message", icon(h, CornerDownLeft, "size-3.5", "inline-end")],
                h,
              ),
            ],
          ),
        ],
      ),
    ],
  );
