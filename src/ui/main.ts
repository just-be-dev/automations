import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Command, Http, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { Disclosure, Input } from "@foldkit/ui";
import {
  Bot,
  ChevronDown,
  CircleAlert,
  CornerDownLeft,
  LoaderCircle,
  Play,
  Radio,
  Webhook,
  Workflow as WorkflowIcon,
} from "lucide";
import { badge } from "@/components/ui/badge";
import { Bubble } from "@/components/ui/bubble";
import { button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { inputClass } from "@/components/ui/input";
import { Message as ChatMessage } from "@/components/ui/message";
import { textarea } from "@/components/ui/textarea";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";

// MODEL

export const Workflow = Schema.Struct({
  name: Schema.String,
  event: Schema.NullOr(Schema.String),
  steps: Schema.Array(
    Schema.Union([
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        kind: Schema.Literal("agent"),
        instruction: Schema.String,
      }),
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        kind: Schema.Literal("webhook"),
        url: Schema.String,
      }),
    ]),
  ),
});
export type Workflow = typeof Workflow.Type;

const Run = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["running", "completed", "failed"]),
  error: Schema.OptionFromOptional(Schema.String),
});

const Activity = defineTaggedUnion({
  Ready: { notice: Schema.String },
  Working: { notice: Schema.String },
  Failed: { error: Schema.String },
});

const Exchange = Schema.Struct({
  id: Schema.Int,
  prompt: Schema.String,
  reply: Schema.String,
});

export const Model = Schema.Struct({
  automationId: Schema.String,
  revision: Schema.Int,
  messageInput: Schema.String,
  conversation: Schema.Array(Exchange),
  maybeDraft: Schema.Option(Workflow),
  maybeRun: Schema.Option(Run),
  expandedStepIds: Schema.Array(Schema.String),
  activity: Activity,
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedAutomationId: { value: Schema.String },
  ChangedAutomationId: {},
  UpdatedMessageInput: { value: Schema.String },
  ToggledStepDetails: { stepId: Schema.String, isOpen: Schema.Boolean },
  ClickedSend: {},
  ClickedSave: {},
  ClickedStart: {},
  SucceededLoadAutomation: {
    revision: Schema.Int,
    maybeDraft: Schema.Option(Workflow),
    hasSaved: Schema.Boolean,
  },
  SucceededSendMessage: {
    revision: Schema.Int,
    sentMessage: Schema.String,
    reply: Schema.String,
    workflow: Workflow,
  },
  SucceededSaveDraft: { revision: Schema.Int },
  SucceededStartRun: { revision: Schema.Int, run: Run },
  SucceededPollRun: { revision: Schema.Int, run: Run },
  FailedRequest: { revision: Schema.Int, error: Schema.String },
  FailedPollRun: { revision: Schema.Int, runId: Schema.String, error: Schema.String },
});
export type Message = typeof Message.Type;

// INIT

export const init = () => ({
  model: Model.make({
    automationId: "my-automation",
    revision: 0,
    messageInput: "",
    conversation: [],
    maybeDraft: Option.none(),
    maybeRun: Option.none(),
    expandedStepIds: [],
    activity: Activity.Ready({ notice: "" }),
  }),
});

// UPDATE

const fail = (model: Model, error: string) => ({
  model: modifyFields(model, { activity: () => Activity.Failed({ error }) }),
});

const maxMessageLength = 10_000;

const validId = (value: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(value.trim());

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    UpdatedAutomationId: ({ value }) => ({
      model: modifyFields(model, {
        automationId: () => value,
        revision: (revision) => revision + 1,
        maybeDraft: () => Option.none(),
        maybeRun: () => Option.none(),
        expandedStepIds: () => [],
        conversation: () => [],
        activity: () => Activity.Ready({ notice: "" }),
      }),
    }),
    ChangedAutomationId: () => {
      if (!validId(model.automationId)) {
        return fail(model, "Use an alphanumeric automation ID");
      }
      return {
        model: modifyFields(model, {
          activity: () => Activity.Working({ notice: "Loading automation…" }),
        }),
        commands: [
          LoadAutomation({ automationId: model.automationId.trim(), revision: model.revision }),
        ],
      };
    },
    ToggledStepDetails: ({ stepId, isOpen }) => ({
      model: modifyFields(model, {
        expandedStepIds: (stepIds) => {
          const otherStepIds = Array.filter(stepIds, (id) => id !== stepId);
          return isOpen ? Array.append(otherStepIds, stepId) : otherStepIds;
        },
      }),
    }),
    UpdatedMessageInput: ({ value }) => ({
      model: modifyFields(model, { messageInput: () => value }),
    }),
    ClickedSend: () => {
      if (Activity.guards.Working(model.activity)) {
        return { model };
      }
      if (!validId(model.automationId)) {
        return fail(model, "Use an alphanumeric automation ID");
      }
      if (!model.messageInput.trim() || model.messageInput.length > maxMessageLength) {
        return fail(model, "Message must be 1–10,000 characters");
      }
      return {
        model: modifyFields(model, {
          activity: () => Activity.Working({ notice: "Sending message…" }),
        }),
        commands: [
          SendMessage({
            automationId: model.automationId.trim(),
            revision: model.revision,
            message: model.messageInput,
          }),
        ],
      };
    },
    ClickedSave: () => {
      if (Activity.guards.Working(model.activity)) {
        return { model };
      }
      if (!validId(model.automationId)) {
        return fail(model, "Use an alphanumeric automation ID");
      }
      if (Option.isNone(model.maybeDraft)) {
        return fail(model, "Create a draft first");
      }
      return {
        model: modifyFields(model, {
          activity: () => Activity.Working({ notice: "Saving draft…" }),
        }),
        commands: [
          SaveDraft({ automationId: model.automationId.trim(), revision: model.revision }),
        ],
      };
    },
    ClickedStart: () => {
      if (Activity.guards.Working(model.activity)) {
        return { model };
      }
      if (!validId(model.automationId)) {
        return fail(model, "Use an alphanumeric automation ID");
      }
      return {
        model: modifyFields(model, {
          activity: () => Activity.Working({ notice: "Starting run…" }),
        }),
        commands: [StartRun({ automationId: model.automationId.trim(), revision: model.revision })],
      };
    },
    SucceededLoadAutomation: ({ revision, maybeDraft, hasSaved }) =>
      revision !== model.revision
        ? { model }
        : {
            model: modifyFields(model, {
              maybeDraft: () => maybeDraft,
              activity: () =>
                Activity.Ready({
                  notice: hasSaved ? "Saved automation available." : "No saved automation yet.",
                }),
            }),
          },
    SucceededSendMessage: ({ revision, sentMessage, reply, workflow }) =>
      revision !== model.revision
        ? { model }
        : {
            model: modifyFields(model, {
              conversation: (conversation) =>
                Array.append(conversation, { id: conversation.length, prompt: sentMessage, reply }),
              maybeDraft: () => Option.some(workflow),
              messageInput: (value) => (value === sentMessage ? "" : value),
              activity: () =>
                Activity.Ready({ notice: "Draft updated. Review the graph before saving." }),
            }),
          },
    SucceededSaveDraft: ({ revision }) =>
      revision !== model.revision
        ? { model }
        : {
            model: modifyFields(model, {
              activity: () => Activity.Ready({ notice: "Saved. Ready to start." }),
            }),
          },
    SucceededStartRun: ({ revision, run }) => {
      if (revision !== model.revision) {
        return { model };
      }
      return {
        model: modifyFields(model, {
          maybeRun: () => Option.some(run),
          activity: () => Activity.Ready({ notice: `Run ${run.id} started.` }),
        }),
        commands: [PollRun({ automationId: model.automationId.trim(), revision, runId: run.id })],
      };
    },
    SucceededPollRun: ({ revision, run }) => {
      if (
        revision !== model.revision ||
        !Option.exists(model.maybeRun, (current) => current.id === run.id)
      ) {
        return { model };
      }
      const runNotice = `Run ${run.id}: ${run.status}${Option.match(run.error, { onNone: () => "", onSome: (error) => `: ${error}` })}`;
      return {
        model: modifyFields(model, {
          maybeRun: () => Option.some(run),
          activity: (activity) =>
            Activity.guards.Working(activity) ? activity : Activity.Ready({ notice: runNotice }),
        }),
        commands:
          run.status === "running"
            ? [PollRun({ automationId: model.automationId.trim(), revision, runId: run.id })]
            : [],
      };
    },
    FailedRequest: ({ revision, error }) =>
      revision !== model.revision ? { model } : fail(model, error),
    FailedPollRun: ({ revision, runId, error }) => {
      if (
        revision !== model.revision ||
        !Option.exists(model.maybeRun, (run) => run.id === runId)
      ) {
        return { model };
      }
      return fail(model, error);
    },
  });

// COMMAND

const requestArgs = { automationId: Schema.String, revision: Schema.Int };
const ErrorResponse = Schema.Struct({ error: Schema.String });

class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  message: Schema.String,
}) {}

const request = Effect.fn("studio.request")(function* <T, E>(
  automationId: string,
  path: string,
  schema: Schema.Codec<T, E>,
  body?: unknown,
) {
  const client = yield* HttpClient.HttpClient;
  const url = `/api/automations/${automationId}${path}`;
  const httpRequest =
    body === undefined
      ? HttpClientRequest.get(url)
      : yield* HttpClientRequest.bodyJson(HttpClientRequest.post(url), body);
  const response = yield* client.execute(httpRequest);
  const data = yield* response.json;
  if (response.status < 200 || response.status >= 300) {
    const failure = yield* Schema.decodeUnknownEffect(ErrorResponse)(data);
    return yield* new ApiError({ message: failure.error });
  }
  return yield* Schema.decodeUnknownEffect(schema)(data);
});

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Unexpected error");

const recoverRequest = (revision: number) =>
  Effect.catch((error: unknown) =>
    Effect.succeed(Message.FailedRequest({ revision, error: errorText(error) })),
  );

export const LoadAutomation = Command.define("LoadAutomation", {
  args: requestArgs,
  messages: [Message.SucceededLoadAutomation, Message.FailedRequest],
  execute: ({ automationId, revision }) =>
    request(
      automationId,
      "",
      Schema.Struct({
        draft: Schema.OptionFromOptional(Workflow),
        saved: Schema.OptionFromOptional(Workflow),
      }),
    ).pipe(
      Effect.map((state) =>
        Message.SucceededLoadAutomation({
          revision,
          maybeDraft: state.draft,
          hasSaved: Option.isSome(state.saved),
        }),
      ),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

export const SendMessage = Command.define("SendMessage", {
  args: { ...requestArgs, message: Schema.String },
  messages: [Message.SucceededSendMessage, Message.FailedRequest],
  execute: ({ automationId, revision, message }) =>
    request(automationId, "/chat", Schema.Struct({ reply: Schema.String, workflow: Workflow }), {
      message,
    }).pipe(
      Effect.map((data) =>
        Message.SucceededSendMessage({
          revision,
          sentMessage: message,
          reply: data.reply,
          workflow: data.workflow,
        }),
      ),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

export const SaveDraft = Command.define("SaveDraft", {
  args: requestArgs,
  messages: [Message.SucceededSaveDraft, Message.FailedRequest],
  execute: ({ automationId, revision }) =>
    request(automationId, "/save", Schema.Unknown, {}).pipe(
      Effect.map(() => Message.SucceededSaveDraft({ revision })),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

export const StartRun = Command.define("StartRun", {
  args: requestArgs,
  messages: [Message.SucceededStartRun, Message.FailedRequest],
  execute: ({ automationId, revision }) =>
    request(automationId, "/start", Run, { input: {} }).pipe(
      Effect.map((run) => Message.SucceededStartRun({ revision, run })),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

export const PollRun = Command.define("PollRun", {
  args: { ...requestArgs, runId: Schema.String },
  messages: [Message.SucceededPollRun, Message.FailedPollRun],
  execute: ({ automationId, revision, runId }) =>
    Effect.gen(function* () {
      yield* Effect.sleep("1500 millis");
      const run = yield* request(automationId, `/runs/${runId}`, Run);
      return Message.SucceededPollRun({ revision, run });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedPollRun({ revision, runId, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});

// VIEW

type Exchange = typeof Exchange.Type;
type Step = Workflow["steps"][number];
type Run = typeof Run.Type;

const eyebrowClass =
  "font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase";

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Automations studio",
  body: h.div(
    [h.Class("flex min-h-full flex-col lg:h-full")],
    [
      headerView(model, h),
      h.main(
        [h.Class("grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]")],
        [conversationView(model, h), workflowPanelView(model, h)],
      ),
    ],
  ),
});

const headerView = (model: Model, h: HtmlBuilder<Message>) =>
  h.header(
    [h.Class("flex h-12 shrink-0 items-center gap-2.5 border-b bg-card px-4")],
    [
      h.div(
        [h.Class("flex items-center gap-2 text-sm font-semibold tracking-tight")],
        [h.span([h.Class("size-2.5 rounded-[2px] bg-signal"), h.AriaHidden(true)]), "Automations"],
      ),
      h.span([h.Class("font-mono text-sm text-muted-foreground/50"), h.AriaHidden(true)], ["/"]),
      Input.view(
        {
          id: "id",
          value: model.automationId,
          onInput: (value) => Message.UpdatedAutomationId({ value }),
          toView: (attributes) =>
            h.div(
              [],
              [
                h.label([...attributes.label, h.Class("sr-only")], ["Automation ID"]),
                h.input([
                  ...attributes.input,
                  h.Autocomplete("off"),
                  h.Spellcheck(false),
                  h.OnChange(() => Message.ChangedAutomationId()),
                  h.Class(
                    cn(
                      inputClass,
                      "h-7 w-56 border-transparent bg-transparent px-1.5 font-mono text-[13px] hover:border-input dark:bg-transparent md:text-[13px]",
                    ),
                  ),
                ]),
              ],
            ),
        },
        h,
      ),
    ],
  );

// VIEW: CONVERSATION

const conversationView = (model: Model, h: HtmlBuilder<Message>) =>
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
          Array.match(model.conversation, {
            onEmpty: () => emptyConversationView(h),
            onNonEmpty: (exchanges) =>
              ChatMessage.group(
                { className: "gap-7" },
                Array.map(exchanges, (exchange) => exchangeView(exchange, h)),
                h,
              ),
          }),
        ],
      ),
      composerView(model, h),
    ],
  );

const emptyConversationView = (h: HtmlBuilder<Message>) =>
  Empty(
    { className: "flex-none items-start p-0 pt-2 text-left" },
    [
      Empty.header(
        { className: "items-start" },
        [
          Empty.title({ className: "text-base" }, ["Describe what should happen"], h),
          Empty.description(
            {},
            [
              "Say what starts the automation and what each step does. The draft on the right updates after every reply, so keep adjusting until it reads correctly.",
            ],
            h,
          ),
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
      ChatMessage(
        { align: "end" },
        [
          ChatMessage.content(
            {},
            [
              Bubble(
                { variant: "secondary", align: "end" },
                [Bubble.content({ className: "whitespace-pre-wrap" }, [exchange.prompt], h)],
                h,
              ),
            ],
            h,
          ),
        ],
        h,
      ),
      ChatMessage(
        {},
        [
          ChatMessage.content(
            { className: "gap-1.5" },
            [
              ChatMessage.header({ className: eyebrowClass }, ["Agent"], h),
              Bubble(
                { variant: "ghost" },
                [Bubble.content({ className: "whitespace-pre-wrap" }, [exchange.reply], h)],
                h,
              ),
            ],
            h,
          ),
        ],
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
            "rounded-lg border bg-card transition-[border-color,box-shadow] focus-within:border-ring/70 focus-within:ring-3 focus-within:ring-ring/15",
          ),
        ],
        [
          textarea(
            {
              id: "message",
              label: "Your message",
              labelClass: "sr-only",
              value: model.messageInput,
              placeholder: "When an order arrives, summarize its contents and send the summary to…",
              onInput: (value) => Message.UpdatedMessageInput({ value }),
              className:
                "max-h-60 min-h-20 resize-none border-0 bg-transparent px-3 pt-2.5 focus-visible:ring-0 dark:bg-transparent",
            },
            h,
          ),
          h.div(
            [h.Class("flex items-center justify-between gap-3 px-3 pb-2.5")],
            [
              h.span(
                [h.Class("font-mono text-[11px] text-muted-foreground tabular-nums")],
                [`${model.messageInput.length} / ${maxMessageLength.toLocaleString("en-US")}`],
              ),
              button(
                {
                  onClick: Message.ClickedSend(),
                  isDisabled: Activity.guards.Working(model.activity),
                  size: "sm",
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

// VIEW: WORKFLOW

const workflowPanelView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [h.Class("dot-grid flex flex-col lg:min-h-0"), h.AriaLabel("Workflow")],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-4 px-6 pt-5")],
        [
          h.div(
            [h.Class("min-w-0")],
            [
              h.div([h.Class(eyebrowClass)], ["Draft"]),
              h.h2(
                [h.Class("truncate text-base font-semibold tracking-tight")],
                [
                  Option.match(model.maybeDraft, {
                    onNone: () => "Untitled workflow",
                    onSome: (workflow) => workflow.name,
                  }),
                ],
              ),
            ],
          ),
          Option.match(model.maybeRun, {
            onNone: () => h.empty,
            onSome: (run) => runBadgeView(run, h),
          }),
        ],
      ),
      h.div(
        [h.Id("graph"), h.AriaLive("polite"), h.Class("flex-1 px-6 py-6 lg:overflow-y-auto")],
        [
          Option.match(model.maybeDraft, {
            onNone: () => emptyWorkflowView(h),
            onSome: (workflow) => workflowView(workflow, model.expandedStepIds, h),
          }),
        ],
      ),
      h.div(
        [h.Class("flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-card px-6 py-3")],
        [
          statusView(model, h),
          h.div(
            [h.Class("ml-auto flex gap-2")],
            [
              button(
                {
                  onClick: Message.ClickedSave(),
                  isDisabled: Activity.guards.Working(model.activity),
                  variant: "outline",
                  attributes: [h.Id("save")],
                },
                "Save draft",
                h,
              ),
              button(
                {
                  onClick: Message.ClickedStart(),
                  isDisabled: Activity.guards.Working(model.activity),
                  attributes: [h.Id("start")],
                },
                [icon(h, Play, "size-3.5", "inline-start"), "Run saved version"],
                h,
              ),
            ],
          ),
        ],
      ),
    ],
  );

const emptyWorkflowView = (h: HtmlBuilder<Message>) =>
  Empty(
    { className: "max-w-xl border border-dashed bg-card/60" },
    [
      Empty.header(
        {},
        [
          Empty.media({ variant: "icon" }, [icon(h, WorkflowIcon)], h),
          Empty.title({}, ["No draft yet"], h),
          Empty.description(
            {},
            [
              "Steps show up here once the agent replies. They run top to bottom; event triggers also accept POST requests.",
            ],
            h,
          ),
        ],
        h,
      ),
    ],
    h,
  );

const nodeMarkerClass =
  "relative z-10 grid size-8 shrink-0 place-items-center rounded-full border bg-card font-mono text-[11px] text-muted-foreground tabular-nums";

const nodeCardClass = "min-w-0 flex-1 rounded-lg border bg-card px-3.5 py-2.5 shadow-xs";

const workflowView = (
  workflow: Workflow,
  expandedStepIds: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
) =>
  h.ol(
    [
      h.AriaLabel("Steps"),
      h.Class(
        "relative flex max-w-xl flex-col gap-3 before:absolute before:top-4 before:bottom-4 before:left-4 before:w-px before:bg-border",
      ),
    ],
    [
      h.li(
        [h.Class("flex gap-3")],
        [
          h.span(
            [h.Class(cn(nodeMarkerClass, "border-signal bg-signal text-primary-foreground"))],
            [icon(h, workflow.event ? Radio : Play, "size-3.5")],
          ),
          h.div(
            [h.Class(nodeCardClass)],
            [
              h.div([h.Class(eyebrowClass)], ["Trigger"]),
              h.div(
                [h.Class("text-sm font-medium")],
                [workflow.event ? `Event: ${workflow.event}` : "Manual start"],
              ),
            ],
          ),
        ],
      ),
      ...Array.map(workflow.steps, (step, index) =>
        stepView(step, index, Array.contains(expandedStepIds, step.id), h),
      ),
    ],
  );

const stepView = (step: Step, index: number, isExpanded: boolean, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    step.id,
    [h.Class("flex gap-3 animate-in fade-in slide-in-from-top-1 duration-300")],
    [
      h.span([h.Class(nodeMarkerClass)], [String(index + 1).padStart(2, "0")]),
      Disclosure.view(
        {
          id: `step-${index + 1}`,
          isOpen: isExpanded,
          onToggle: (isOpen) => Message.ToggledStepDetails({ stepId: step.id, isOpen }),
          toView: ({ button, panel }) =>
            h.div(
              [h.Class(cn(nodeCardClass, "p-0"))],
              [
                h.button(
                  [
                    ...button,
                    h.Class(
                      "group/step flex w-full cursor-pointer items-start gap-3 rounded-lg px-3.5 pt-2.5 pb-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    ),
                  ],
                  [
                    h.div(
                      [h.Class("min-w-0 flex-1")],
                      [
                        h.div(
                          [h.Class(cn(eyebrowClass, "flex items-center gap-1.5"))],
                          [icon(h, step.kind === "agent" ? Bot : Webhook, "size-3"), step.kind],
                        ),
                        h.div([h.Class("text-sm font-medium")], [step.title]),
                      ],
                    ),
                    icon(
                      h,
                      ChevronDown,
                      "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover/step:text-foreground group-aria-expanded/step:rotate-180",
                    ),
                  ],
                ),
                step.kind === "agent"
                  ? h.p(
                      [
                        ...panel,
                        h.Class(
                          cn(
                            "mx-3.5 mb-2.5 text-xs text-muted-foreground",
                            isExpanded ? "whitespace-pre-wrap break-words" : "line-clamp-2",
                          ),
                        ),
                      ],
                      [step.instruction],
                    )
                  : h.p(
                      [
                        ...panel,
                        h.Class(
                          cn(
                            "mx-3.5 mb-2.5 font-mono text-xs text-muted-foreground",
                            isExpanded ? "break-all" : "truncate",
                          ),
                        ),
                      ],
                      [step.url],
                    ),
              ],
            ),
        },
        h,
      ),
    ],
  );

const runStatusLabel: Record<Run["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

const runDotClass: Record<Run["status"], string> = {
  running: "animate-pulse bg-signal",
  completed: "bg-success",
  failed: "bg-destructive",
};

const runBadgeView = (run: Run, h: HtmlBuilder<Message>) =>
  badge(
    {
      variant: run.status === "failed" ? "destructive" : "outline",
      className: cn("mt-1", run.status !== "failed" && "bg-card"),
    },
    [
      h.span([h.Class(cn("size-1.5 rounded-full", runDotClass[run.status])), h.AriaHidden(true)]),
      runStatusLabel[run.status],
      h.span([h.Class("font-mono text-muted-foreground")], [run.id]),
    ],
    h,
  );

const statusView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [
      h.Id("status"),
      h.Role("status"),
      h.Class(
        cn(
          "flex min-w-0 items-center gap-2 text-xs text-muted-foreground",
          Activity.guards.Failed(model.activity) && "text-destructive",
        ),
      ),
    ],
    Activity.match(model.activity, {
      Ready: ({ notice }) => [notice],
      Working: ({ notice }) => [icon(h, LoaderCircle, "size-3.5 animate-spin text-signal"), notice],
      Failed: ({ error }) => [icon(h, CircleAlert, "size-3.5"), error],
    }),
  );
