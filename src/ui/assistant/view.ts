import * as Array from "effect/Array";
import * as Option from "effect/Option";
import { Submodel } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Check,
  Circle,
  Eraser,
  FileText,
  History,
  LoaderCircle,
  LocateFixed,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Square,
  SquarePen,
  Table2,
  Workflow,
} from "lucide";
import type { AssistantState, AssistantThread } from "../../assistant/model.ts";
import { button } from "@/components/ui/button";
import { textarea } from "@/components/ui/textarea";
import { componentName } from "@/lib/component";
import { formatTime } from "@/lib/format";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { changeProposalView } from "../components/change-proposal.ts";
import { markdown } from "../components/markdown.ts";
import { Questionnaire } from "../domain/index.ts";
import { Message } from "./message.ts";
import { inputId } from "./command.ts";
import { Clearing, type Model, Panel, Request, ThreadList, turnInProgress } from "./model.ts";
import { trustedHref } from "./update.ts";
import * as Dictation from "../dictation/index.ts";
import { type ShortcutModifier, submitShortcut } from "../platform.ts";

/** What the root app tells the assistant panel about the browser. */
export type ViewInputs = { readonly shortcutModifier: ShortcutModifier };

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, viewInputs, h) => {
  const busy = Request.guards.Sending(model.request);
  const status = busy
    ? "Working…"
    : Request.guards.Failed(model.request)
      ? "Disconnected"
      : Option.match(model.maybeState, {
          onNone: () => "Connecting…",
          onSome: (state) =>
            state.status === "confirming" || state.status === "asking"
              ? "Needs your answer"
              : state.status === "working"
                ? "Working…"
                : state.status === "failed"
                  ? "Failed"
                  : "Ready",
        });
  if (model.collapsed) {
    return h.aside(
      [
        componentName("assistant"),
        h.AriaLabel("Assistant"),
        h.Class(
          "fixed right-3 bottom-3 z-40 shrink-0 rounded-lg border bg-card p-2 shadow-card lg:static lg:z-auto lg:w-14 lg:rounded-none lg:border-0 lg:border-l lg:shadow-none",
        ),
      ],
      [
        button(
          {
            onClick: Message.ClickedCollapse(),
            variant: "ghost",
            size: "icon",
            className: "text-muted-foreground",
            attributes: [h.AriaLabel("Open assistant"), h.Title(`Open assistant · ${status}`)],
          },
          [icon(h, PanelRightOpen)],
          h,
        ),
        h.span([
          h.Role("status"),
          h.AriaLabel(status),
          h.Class(
            `mx-auto mt-2 hidden size-2 rounded-full lg:block ${status === "Needs your answer" ? "bg-brand" : status === "Working…" ? "animate-pulse bg-signal" : "bg-muted-foreground"}`,
          ),
        ]),
      ],
    );
  }
  const state: AssistantState | undefined = Option.getOrUndefined(model.maybeState);
  return h.aside(
    [
      componentName("assistant"),
      h.AriaLabel("Assistant"),
      h.Class(
        "fixed inset-y-0 right-0 z-40 flex w-[min(360px,100vw)] shrink-0 flex-col border-l bg-sidebar shadow-xl lg:static lg:z-auto lg:w-[360px] lg:shadow-none",
      ),
    ],
    [
      headerView(model, state, h),
      Clearing.guards.Confirming(model.clearing) ? clearConfirmationView(busy, h) : h.empty,
      ...Panel.match(model.panel, {
        History: ({ threads, showArchived }) => [
          historyView(model.sessionId, threads, showArchived, h),
        ],
        Chat: () => chatView(model, viewInputs, state, status, busy, h),
      }),
    ],
  );
});

const chatView = (
  model: Model,
  viewInputs: ViewInputs,
  state: AssistantState | undefined,
  status: string,
  busy: boolean,
  h: HtmlBuilder<Message>,
) => [
  h.div(
    [h.Class("flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"), h.AriaLive("polite")],
    [
      Array.isReadonlyArrayEmpty(state?.conversation ?? []) &&
      Array.isReadonlyArrayEmpty(state?.activities ?? []) &&
      state?.confirmation === undefined &&
      state?.questions === undefined
        ? assistantIntroductionView(h)
        : h.empty,
      ...(state?.conversation ?? []).map((exchange) =>
        h.keyed("article")(
          exchange.id,
          [h.Class("flex flex-col gap-3 text-sm")],
          [
            h.p(
              [
                h.Class(
                  "max-w-[85%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary px-3 py-2",
                ),
              ],
              [exchange.prompt],
            ),
            exchange.reply !== undefined
              ? h.div(
                  [h.Class("leading-relaxed text-muted-foreground")],
                  [markdown(exchange.reply, h)],
                )
              : exchange.stopped === true
                ? h.p([h.Class("text-xs text-sand-10")], ["Stopped"])
                : h.empty,
          ],
        ),
      ),
      ...(state?.activities ?? []).map((activity) =>
        h.keyed("article")(
          activity.id,
          [h.Class("flex items-start gap-2 text-xs text-muted-foreground")],
          [
            icon(
              h,
              activity.status === "completed"
                ? Check
                : activity.status === "working"
                  ? LoaderCircle
                  : Circle,
              `mt-0.5 size-3.5 ${activity.status === "working" && state?.status === "working" ? "animate-spin" : ""}`,
            ),
            h.div(
              [h.Class("min-w-0 flex-1 space-y-1")],
              [
                h.p([], [activity.label]),
                h.p(
                  [h.Class("text-sand-10")],
                  [
                    activity.status === "working"
                      ? state?.status === "confirming"
                        ? "Waiting for your confirmation"
                        : state?.status === "asking"
                          ? "Waiting for your answer"
                          : "In progress"
                      : activity.status === "completed"
                        ? "Completed"
                        : activity.status === "cancelled"
                          ? "Cancelled"
                          : "Failed",
                  ],
                ),
                activity.href !== undefined && trustedHref(activity.href)
                  ? h.a(
                      [
                        h.Href(activity.href),
                        h.Class("inline-flex items-center gap-1 text-signal"),
                      ],
                      ["View resource", icon(h, ArrowUpRight, "size-3")],
                    )
                  : h.empty,
              ],
            ),
          ],
        ),
      ),
      state?.confirmation === undefined
        ? h.empty
        : changeProposalView(
            state.confirmation,
            Message.ClickedConfirmation({ approved: true }),
            Message.ClickedConfirmation({ approved: false }),
            busy,
            h,
          ),
      state?.questions === undefined
        ? h.empty
        : h.section(
            [h.AriaLabel("Assistant questions"), h.Class("space-y-4")],
            [
              ...state.questions.questions.map((question, index) =>
                h.fieldset(
                  [h.Class("space-y-2")],
                  [
                    h.legend([h.Class("text-sm font-medium")], [question.question]),
                    h.div(
                      [h.Class("flex flex-wrap gap-2")],
                      question.options.map((option) =>
                        button(
                          {
                            onClick: Message.ClickedOption({
                              question: index,
                              label: option.label,
                            }),
                            variant: "outline",
                            isDisabled: busy,
                            className:
                              "h-auto min-h-8 max-w-full py-1.5 text-left whitespace-normal aria-pressed:border-signal aria-pressed:bg-signal/10 aria-pressed:text-signal aria-pressed:hover:bg-signal/15 aria-pressed:hover:text-signal",
                            attributes: [
                              h.AriaPressed(
                                String(
                                  Option.exists(model.maybeQuestionnaire, (questionnaire) =>
                                    Questionnaire.isChosen(
                                      Questionnaire.answerAt(questionnaire, index),
                                      option.label,
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          },
                          option.label,
                          h,
                        ),
                      ),
                    ),
                    textarea(
                      {
                        id: `assistant-answer-${index}`,
                        label: "Write your own answer",
                        value: Option.match(model.maybeQuestionnaire, {
                          onNone: () => "",
                          onSome: (questionnaire) => {
                            const answer = Questionnaire.answerAt(questionnaire, index);
                            return Questionnaire.Answer.guards.Wrote(answer) ? answer.text : "";
                          },
                        }),
                        onInput: (value) => Message.UpdatedAnswer({ question: index, value }),
                        isDisabled: busy,
                      },
                      h,
                    ),
                  ],
                ),
              ),
              button(
                { onClick: Message.ClickedAnswers({ skipped: false }), isDisabled: busy },
                "Send answers",
                h,
              ),
              button(
                {
                  onClick: Message.ClickedAnswers({ skipped: true }),
                  variant: "ghost",
                  isDisabled: busy,
                },
                "Skip questions",
                h,
              ),
            ],
          ),
      state?.error === undefined ? h.empty : h.p([h.Role("alert")], [state.error]),
      Request.guards.Failed(model.request)
        ? h.p([h.Role("alert"), h.Class("text-destructive")], [model.request.error])
        : h.empty,
      Request.guards.Failed(model.request)
        ? button({ onClick: Message.ClickedRetry(), variant: "outline" }, "Reconnect assistant", h)
        : h.empty,
    ],
  ),
  status === "Ready"
    ? h.empty
    : h.p(
        [h.Role("status"), h.Class("shrink-0 px-4 pb-2 text-xs text-muted-foreground")],
        [status],
      ),
  h.form(
    [
      h.AriaLabel("Assistant chat"),
      h.OnSubmit(Message.SubmittedChat()),
      h.Class("shrink-0 px-3 pb-3 pt-1"),
    ],
    [
      h.div(
        [
          h.Class(
            "flex flex-col gap-2 rounded-xl bg-background px-3 py-2.5 shadow-card focus-within:ring-2 focus-within:ring-ring/25",
          ),
        ],
        [
          textarea(
            {
              id: inputId,
              label: "Message assistant",
              labelClass: "sr-only",
              placeholder: "Ask a question or describe a task…",
              value: model.input,
              onInput: (value) => Message.UpdatedInput({ value }),
              attributes: submitShortcut(viewInputs.shortcutModifier, Message.SubmittedChat(), h),
              rows: 2,
              className:
                "min-h-12 max-h-40 resize-none rounded-none border-0 bg-transparent px-1 py-0 focus-visible:ring-0",
            },
            h,
          ),
          h.div(
            [h.Class("flex items-center justify-between gap-2")],
            [
              model.dictation.status._tag === "Idle"
                ? h.span([h.Class("text-[11px] text-sand-10")], ["Changes need your confirmation"])
                : h.submodel({
                    slotId: "assistant-dictation-status",
                    model: model.dictation,
                    view: Dictation.statusView,
                    toParentMessage: (message) => Message.GotDictationMessage({ message }),
                  }),
              h.div(
                [h.Class("flex shrink-0 items-center gap-1")],
                [
                  h.submodel({
                    slotId: "assistant-dictation",
                    model: model.dictation,
                    view: Dictation.view,
                    toParentMessage: (message) => Message.GotDictationMessage({ message }),
                  }),
                  turnInProgress(model)
                    ? stopButtonView(busy, h)
                    : button(
                        {
                          type: "submit",
                          size: "icon-sm",
                          className:
                            "aria-disabled:bg-secondary aria-disabled:text-sand-10 aria-disabled:opacity-100",
                          attributes: [h.AriaLabel("Send to assistant"), h.Title("Send message")],
                          isDisabled:
                            busy ||
                            Dictation.active(model.dictation) ||
                            model.sessionId === "" ||
                            model.input.trim() === "" ||
                            (state !== undefined &&
                              state.status !== "idle" &&
                              state.status !== "failed"),
                        },
                        [icon(h, Send, "size-3.5")],
                        h,
                      ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  ),
];

const assistantIntroductionView = (h: HtmlBuilder<Message>) =>
  h.section(
    [
      componentName("assistant-introduction"),
      h.AriaLabel("Get started"),
      h.Class("space-y-5 pt-2"),
    ],
    [
      h.div(
        [h.Class("space-y-2")],
        [
          h.h2([h.Class("text-sm font-medium")], ["What would you like to do?"]),
          h.p(
            [h.Class("text-sm leading-relaxed text-muted-foreground")],
            [
              "Create and update entities, prepare templates, or draft an automation. I’ll ask before making changes.",
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("flex flex-col gap-2")],
        [
          {
            id: "template",
            label: "Create a template",
            prompt: "Help me create an onboarding email template.",
            icon: FileText,
          },
          {
            id: "entities",
            label: "Add entities",
            prompt: "Help me create and populate entities.",
            icon: Table2,
          },
          {
            id: "automation",
            label: "Draft an automation",
            prompt: "Help me draft an onboarding automation.",
            icon: Workflow,
          },
        ].map((suggestion) =>
          h.keyed("div")(
            suggestion.id,
            [],
            [
              button(
                {
                  onClick: Message.UpdatedInput({ value: suggestion.prompt }),
                  variant: "outline",
                  className: "h-auto w-full justify-start gap-2.5 px-3 py-2.5 text-xs font-normal",
                },
                [icon(h, suggestion.icon, "size-3.5 text-sand-10"), suggestion.label],
                h,
              ),
            ],
          ),
        ),
      ),
    ],
  );

const headerView = (model: Model, state: AssistantState | undefined, h: HtmlBuilder<Message>) =>
  h.header(
    [
      componentName("assistant-header"),
      h.Class("flex h-12 shrink-0 items-center gap-1 border-b px-4"),
    ],
    [
      h.span(
        [
          h.Class("mr-auto min-w-0 truncate text-sm font-semibold"),
          h.Title(state?.title ?? "Studio agent"),
        ],
        [Panel.guards.History(model.panel) ? "Threads" : (state?.title ?? "Studio agent")],
      ),
      headerButtonView(
        Message.ClickedNewThread(),
        SquarePen,
        "New thread",
        { isDisabled: model.sessionId === "" },
        h,
      ),
      headerButtonView(
        Message.ClickedHistory(),
        History,
        "Past threads",
        { isPressed: Panel.guards.History(model.panel) },
        h,
      ),
      Panel.guards.Chat(model.panel) && Array.isReadonlyArrayNonEmpty(state?.conversation ?? [])
        ? headerButtonView(
            Message.ClickedClearThread(),
            Eraser,
            "Clear thread",
            { isDisabled: Request.guards.Sending(model.request) },
            h,
          )
        : h.empty,
      button(
        {
          onClick: Message.ClickedFollow(),
          variant: "ghost",
          size: "icon",
          className: model.follow ? "bg-signal/10 text-signal" : "text-muted-foreground",
          attributes: [
            h.AriaLabel("Follow along"),
            h.AriaPressed(String(model.follow)),
            h.Title(model.follow ? "Stop following along" : "Follow along"),
          ],
        },
        [icon(h, LocateFixed)],
        h,
      ),
      headerButtonView(Message.ClickedCollapse(), PanelRightClose, "Collapse assistant", {}, h),
    ],
  );

const headerButtonView = (
  onClick: Message,
  iconNode: Parameters<typeof icon>[1],
  label: string,
  options: { readonly isDisabled?: boolean; readonly isPressed?: boolean },
  h: HtmlBuilder<Message>,
) =>
  button(
    {
      onClick,
      variant: "ghost",
      size: "icon",
      isDisabled: options.isDisabled ?? false,
      className: options.isPressed === true ? "bg-hover text-foreground" : "text-muted-foreground",
      attributes: [
        h.AriaLabel(label),
        h.Title(label),
        ...(options.isPressed === undefined ? [] : [h.AriaPressed(String(options.isPressed))]),
      ],
    },
    [icon(h, iconNode)],
    h,
  );

const clearConfirmationView = (busy: boolean, h: HtmlBuilder<Message>) =>
  h.div(
    [
      componentName("clear-confirmation"),
      h.Role("alertdialog"),
      h.AriaLabel("Clear this thread?"),
      h.Class("flex shrink-0 flex-col gap-2 border-b bg-background px-4 py-3 text-sm"),
    ],
    [
      h.p(
        [h.Class("text-muted-foreground")],
        ["Clear this thread? Its messages and what the agent remembers of them are erased."],
      ),
      h.div(
        [h.Class("flex gap-2")],
        [
          button(
            {
              onClick: Message.ClickedConfirmClear(),
              variant: "destructive",
              size: "sm",
              isDisabled: busy,
            },
            "Clear thread",
            h,
          ),
          button(
            { onClick: Message.ClickedCancelClear(), variant: "ghost", size: "sm" },
            "Cancel",
            h,
          ),
        ],
      ),
    ],
  );

const stopButtonView = (busy: boolean, h: HtmlBuilder<Message>) =>
  button(
    {
      onClick: Message.ClickedStop(),
      size: "icon-sm",
      isDisabled: busy,
      attributes: [componentName("stop-button"), h.AriaLabel("Stop the agent"), h.Title("Stop")],
    },
    [icon(h, Square, "size-3 fill-current")],
    h,
  );

const historyView = (
  openSessionId: string,
  threads: ThreadList,
  showArchived: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.section(
    [
      componentName("thread-history"),
      h.AriaLabel("Past threads"),
      h.Class("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3"),
    ],
    ThreadList.match(threads, {
      Loading: () => [
        h.p(
          [h.Role("status"), h.Class("px-1 text-xs text-muted-foreground")],
          ["Loading threads…"],
        ),
      ],
      Failed: ({ error }) => [
        h.p([h.Role("alert"), h.Class("px-1 text-sm text-destructive")], [error]),
        button(
          { onClick: Message.ClickedHistory(), variant: "outline", size: "sm" },
          "Back to chat",
          h,
        ),
      ],
      Ready: ({ threads }) => {
        const active = threads.filter((thread) => !thread.archived);
        const archived = threads.filter((thread) => thread.archived);
        return [
          Array.match(active, {
            onEmpty: () =>
              h.p([h.Class("px-1 text-sm text-muted-foreground")], ["No other threads yet."]),
            onNonEmpty: (listed) => threadListView("Threads", listed, openSessionId, h),
          }),
          Array.isReadonlyArrayEmpty(archived)
            ? h.empty
            : button(
                {
                  onClick: Message.ClickedShowArchived(),
                  variant: "ghost",
                  size: "sm",
                  className: "self-start text-muted-foreground",
                  attributes: [h.AriaExpanded(showArchived)],
                },
                [
                  icon(h, Archive, "size-3.5", "inline-start"),
                  `${showArchived ? "Hide" : "Show"} archived (${archived.length})`,
                ],
                h,
              ),
          showArchived && Array.isReadonlyArrayNonEmpty(archived)
            ? threadListView("Archived threads", archived, openSessionId, h)
            : h.empty,
        ];
      },
    }),
  );

const threadListView = (
  label: string,
  threads: ReadonlyArray<AssistantThread>,
  openSessionId: string,
  h: HtmlBuilder<Message>,
) =>
  h.ul(
    [componentName("thread-list"), h.AriaLabel(label), h.Class("flex flex-col")],
    threads.map((thread) => threadRowView(thread, thread.id === openSessionId, h)),
  );

const threadRowView = (thread: AssistantThread, isOpen: boolean, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    thread.id,
    [
      componentName("thread-row"),
      h.Class(
        cn("group flex items-center gap-1 rounded-[8px] hover:bg-hover", isOpen && "bg-hover"),
      ),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.OnClick(Message.ClickedThread({ sessionId: thread.id })),
          ...(isOpen ? [h.AriaCurrent("true")] : []),
          h.Class(
            "flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 rounded-[8px] px-2 py-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          ),
        ],
        [
          h.span(
            [h.Class("w-full truncate text-[13px] font-medium")],
            [thread.title ?? "Untitled thread"],
          ),
          h.span([h.Class("text-xs text-sand-10 tabular-nums")], [formatTime(thread.updatedAt)]),
        ],
      ),
      button(
        {
          onClick: Message.ClickedArchiveThread({
            sessionId: thread.id,
            archived: !thread.archived,
          }),
          variant: "ghost",
          size: "icon-sm",
          className: "mr-1 shrink-0 text-muted-foreground",
          attributes: [
            h.AriaLabel(
              `${thread.archived ? "Restore" : "Archive"} ${thread.title ?? "untitled thread"}`,
            ),
            h.Title(thread.archived ? "Restore" : "Archive"),
          ],
        },
        [icon(h, thread.archived ? ArchiveRestore : Archive, "size-3.5")],
        h,
      ),
    ],
  );
