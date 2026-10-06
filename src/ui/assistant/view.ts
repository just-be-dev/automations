import * as Array from "effect/Array";
import * as Option from "effect/Option";
import { Submodel } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import {
  ArrowUpRight,
  Check,
  Circle,
  FileText,
  LoaderCircle,
  LocateFixed,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Table2,
  Workflow,
} from "lucide";
import type { AssistantState } from "../../assistant/model.ts";
import { button } from "@/components/ui/button";
import { textarea } from "@/components/ui/textarea";
import { componentName } from "@/lib/component";
import { icon } from "@/lib/icons";
import { changeProposalView } from "../components/change-proposal.ts";
import { markdown } from "../components/markdown.ts";
import { Questionnaire } from "../domain/index.ts";
import { Message } from "./message.ts";
import { type Model, Request } from "./model.ts";
import { trustedHref } from "./update.ts";

export const view = Submodel.defineView<Model, Message>((model, h) => {
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
      h.header(
        [h.Class("flex h-12 shrink-0 items-center gap-1 border-b px-4")],
        [
          h.span([h.Class("mr-auto text-sm font-semibold")], ["Studio agent"]),
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
          button(
            {
              onClick: Message.ClickedCollapse(),
              variant: "ghost",
              size: "icon",
              className: "text-muted-foreground",
              attributes: [h.AriaLabel("Collapse assistant"), h.Title("Collapse assistant")],
            },
            [icon(h, PanelRightClose)],
            h,
          ),
        ],
      ),
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
                exchange.reply === undefined
                  ? h.empty
                  : h.div(
                      [h.Class("leading-relaxed text-muted-foreground")],
                      [markdown(exchange.reply, h)],
                    ),
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
                        ...question.options.map((option) =>
                          button(
                            {
                              onClick: Message.ClickedOption({
                                question: index,
                                label: option.label,
                              }),
                              variant: "outline",
                              isDisabled: busy,
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
            ? button(
                { onClick: Message.ClickedRetry(), variant: "outline" },
                "Reconnect assistant",
                h,
              )
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
                  id: "assistant-input",
                  label: "Message assistant",
                  labelClass: "sr-only",
                  placeholder: "Ask a question or describe a task…",
                  value: model.input,
                  onInput: (value) => Message.UpdatedInput({ value }),
                  rows: 2,
                  className:
                    "min-h-12 max-h-40 resize-none rounded-none border-0 bg-transparent px-1 py-0 focus-visible:ring-0",
                },
                h,
              ),
              h.div(
                [h.Class("flex items-center justify-between gap-2")],
                [
                  h.span([h.Class("text-[11px] text-sand-10")], ["Changes need your confirmation"]),
                  button(
                    {
                      type: "submit",
                      size: "icon-sm",
                      className:
                        "aria-disabled:bg-secondary aria-disabled:text-sand-10 aria-disabled:opacity-100",
                      attributes: [h.AriaLabel("Send to assistant"), h.Title("Send message")],
                      isDisabled:
                        busy ||
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
  );
});

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
