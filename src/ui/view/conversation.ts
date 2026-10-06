import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Bot, CircleAlert, CornerDownLeft, LoaderCircle } from "lucide";
import { Bubble } from "@/components/ui/bubble";
import { button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Message as ChatMessage } from "@/components/ui/message";
import { textarea } from "@/components/ui/textarea";
import { icon } from "@/lib/icons";
import type { PendingChat } from "../../workflow.ts";
import { Message } from "../message.ts";
import { Activity, type Exchange, messageInputOf, type Model } from "../model.ts";
import { characterCountView, submitShortcut } from "./shared.ts";

export const conversationView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [
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
    { className: "flex-none items-start p-0 pt-2 text-left" },
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
    onSome: (pending) => [pendingChatView(pending, model.maybeProgress, h)],
  }),
];

const promptView = (prompt: string, h: HtmlBuilder<Message>) =>
  ChatMessage(
    { align: "end" },
    [
      ChatMessage.content(
        {},
        [
          Bubble(
            { variant: "secondary", align: "end" },
            [Bubble.content({ className: "whitespace-pre-wrap" }, [prompt], h)],
            h,
          ),
        ],
        h,
      ),
    ],
    h,
  );

const replyView = (children: ReadonlyArray<Html | string>, h: HtmlBuilder<Message>) =>
  ChatMessage(
    {},
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

const exchangeView = (exchange: Exchange, h: HtmlBuilder<Message>) =>
  h.keyed("div")(
    String(exchange.id),
    [h.Class("flex flex-col gap-4")],
    [
      promptView(exchange.prompt, h),
      replyView([h.span([h.Class("whitespace-pre-wrap")], [exchange.reply])], h),
    ],
  );

const pendingChatView = (
  pending: PendingChat,
  maybeProgress: Option.Option<string>,
  h: HtmlBuilder<Message>,
) =>
  h.keyed("div")(
    pending.id,
    [h.Class("flex flex-col gap-4")],
    [
      promptView(pending.prompt, h),
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
                    [Option.getOrElse(maybeProgress, () => "Thinking…")],
                  ),
                ],
              ),
            ],
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
    [h.Class("p-3")],
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
              placeholder: "When an order arrives, summarize its contents and send the summary to…",
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
