import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Command, Dom, Http, type Runtime, type Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { Url, toString as urlToString } from "foldkit/url";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { Disclosure, Input } from "@foldkit/ui";
import {
  Bot,
  Braces,
  ChevronDown,
  GitBranch,
  Hourglass,
  Scale,
  Split,
  UserRound,
  CircleAlert,
  CornerDownLeft,
  LoaderCircle,
  Play,
  Plus,
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
import {
  templateParts,
  workflowVariables,
  Workflow,
  type Comparison,
  type Condition,
  type Step,
} from "../workflow.ts";

// MODEL

export { Workflow };

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

const WorkflowDisplay = Schema.Literals(["Steps", "Json"]);
type WorkflowDisplay = typeof WorkflowDisplay.Type;

const AutomationSummary = Schema.Struct({ id: Schema.String, name: Schema.String });

const Directory = defineTaggedUnion({
  Loading: {},
  Ready: { automations: Schema.Array(AutomationSummary) },
  Unavailable: { error: Schema.String },
});

export const Model = Schema.Struct({
  automationId: Schema.String,
  automationIdInput: Schema.String,
  directory: Directory,
  revision: Schema.Int,
  messageInput: Schema.String,
  conversation: Schema.Array(Exchange),
  maybeDraft: Schema.Option(Workflow),
  maybeRun: Schema.Option(Run),
  expandedStepIds: Schema.Array(Schema.String),
  workflowDisplay: WorkflowDisplay,
  activity: Activity,
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  UpdatedAutomationId: { value: Schema.String },
  ChangedAutomationId: {},
  ClickedNewAutomation: {},
  CompletedFocusAutomationIdInput: {},
  UpdatedMessageInput: { value: Schema.String },
  ToggledStepDetails: { stepId: Schema.String, isOpen: Schema.Boolean },
  SelectedWorkflowDisplay: { display: WorkflowDisplay },
  ClickedSend: {},
  ClickedSave: {},
  ClickedStart: {},
  SucceededLoadAutomation: {
    revision: Schema.Int,
    maybeDraft: Schema.Option(Workflow),
    hasSaved: Schema.Boolean,
    conversation: Schema.Array(Exchange),
  },
  SucceededLoadAutomations: { automations: Schema.Array(AutomationSummary) },
  FailedLoadAutomations: { error: Schema.String },
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

const defaultAutomationId = "my-automation";

export const automationIdFromUrl = (url: Url) =>
  Option.match(url.search, {
    onNone: () => defaultAutomationId,
    onSome: (search) => new URLSearchParams(search).get("automation") ?? defaultAutomationId,
  });

export const automationHref = (automationId: string) =>
  `/?${new URLSearchParams({ automation: automationId })}`;

const invalidIdError = "Automation IDs use letters, numbers, - and _ (up to 80 characters)";

const validId = (value: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(value.trim());

export const init: Runtime.RoutingApplicationInit<Model, Message> = (url) => {
  const automationId = automationIdFromUrl(url);
  const model = Model.make({
    automationId,
    automationIdInput: automationId,
    directory: Directory.Loading(),
    revision: 0,
    messageInput: "",
    conversation: [],
    maybeDraft: Option.none(),
    maybeRun: Option.none(),
    expandedStepIds: [],
    workflowDisplay: "Steps",
    activity: validId(automationId)
      ? Activity.Working({ notice: "Loading automation…" })
      : Activity.Failed({ error: invalidIdError }),
  });
  return {
    model,
    commands: validId(automationId)
      ? [LoadAutomation({ automationId, revision: 0 }), LoadAutomations()]
      : [LoadAutomations()],
  };
};

// UPDATE

const fail = (model: Model, error: string) => ({
  model: modifyFields(model, { activity: () => Activity.Failed({ error }) }),
});

const maxMessageLength = 10_000;

const openAutomation = (model: Model, automationId: string): Update.Return<Model, Message> => {
  const opened = modifyFields(model, {
    automationId: () => automationId,
    automationIdInput: () => automationId,
    revision: (revision) => revision + 1,
    maybeDraft: () => Option.none(),
    maybeRun: () => Option.none(),
    expandedStepIds: () => [],
    conversation: () => [],
    activity: () => Activity.Working({ notice: "Loading automation…" }),
  });
  if (!validId(automationId)) {
    return fail(opened, invalidIdError);
  }
  return {
    model: opened,
    commands: [LoadAutomation({ automationId, revision: opened.revision })],
  };
};

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<Update.Return<Model, Message>>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [NavigateInternal({ url: urlToString(url) })],
        }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),
    ChangedUrl: ({ url }) => openAutomation(model, automationIdFromUrl(url)),
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    UpdatedAutomationId: ({ value }) => ({
      model: modifyFields(model, { automationIdInput: () => value }),
    }),
    ChangedAutomationId: () => {
      const automationId = model.automationIdInput.trim();
      if (!validId(automationId)) {
        return fail(model, invalidIdError);
      }
      if (automationId === model.automationId) {
        return { model };
      }
      return { model, commands: [NavigateInternal({ url: automationHref(automationId) })] };
    },
    ClickedNewAutomation: () => ({
      model: modifyFields(model, { automationIdInput: () => "" }),
      commands: [FocusAutomationIdInput()],
    }),
    CompletedFocusAutomationIdInput: () => ({ model }),
    ToggledStepDetails: ({ stepId, isOpen }) => ({
      model: modifyFields(model, {
        expandedStepIds: (stepIds) => {
          const otherStepIds = Array.filter(stepIds, (id) => id !== stepId);
          return isOpen ? Array.append(otherStepIds, stepId) : otherStepIds;
        },
      }),
    }),
    SelectedWorkflowDisplay: ({ display }) => ({
      model: modifyFields(model, { workflowDisplay: () => display }),
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
    SucceededLoadAutomation: ({ revision, maybeDraft, hasSaved, conversation }) =>
      revision !== model.revision
        ? { model }
        : {
            model: modifyFields(model, {
              maybeDraft: () => maybeDraft,
              conversation: () => conversation,
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
            commands: [LoadAutomations()],
          },
    SucceededSaveDraft: ({ revision }) =>
      revision !== model.revision
        ? { model }
        : {
            model: modifyFields(model, {
              activity: () => Activity.Ready({ notice: "Saved. Ready to start." }),
            }),
            commands: [LoadAutomations()],
          },
    SucceededLoadAutomations: ({ automations }) => ({
      model: modifyFields(model, { directory: () => Directory.Ready({ automations }) }),
    }),
    FailedLoadAutomations: ({ error }) => ({
      model: modifyFields(model, { directory: () => Directory.Unavailable({ error }) }),
    }),
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

const requestJson = Effect.fn("studio.requestJson")(function* <T, E>(
  url: string,
  schema: Schema.Codec<T, E>,
  body?: unknown,
) {
  const client = yield* HttpClient.HttpClient;
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

const request = <T, E>(
  automationId: string,
  path: string,
  schema: Schema.Codec<T, E>,
  body?: unknown,
) => requestJson(`/api/automations/${automationId}${path}`, schema, body);

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
        conversation: Schema.Array(Schema.Struct({ prompt: Schema.String, reply: Schema.String })),
      }),
    ).pipe(
      Effect.map((state) =>
        Message.SucceededLoadAutomation({
          revision,
          maybeDraft: state.draft,
          hasSaved: Option.isSome(state.saved),
          conversation: Array.map(state.conversation, (exchange, id) => ({ id, ...exchange })),
        }),
      ),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

export const LoadAutomations = Command.define("LoadAutomations", {
  messages: [Message.SucceededLoadAutomations, Message.FailedLoadAutomations],
  execute: requestJson("/api/automations", Schema.Array(AutomationSummary)).pipe(
    Effect.map((automations) => Message.SucceededLoadAutomations({ automations })),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedLoadAutomations({ error: errorText(error) })),
    ),
    Effect.provide(Http.layer),
  ),
});

export const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});

const automationIdInputId = "id";

export const FocusAutomationIdInput = Command.define("FocusAutomationIdInput", {
  messages: [Message.CompletedFocusAutomationIdInput],
  execute: Dom.focus(`#${automationIdInputId}`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusAutomationIdInput()),
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
        [
          h.Class(
            "grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[15rem_minmax(0,5fr)_minmax(0,6fr)]",
          ),
        ],
        [sidebarView(model, h), conversationView(model, h), workflowPanelView(model, h)],
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
          id: automationIdInputId,
          value: model.automationIdInput,
          placeholder: "new-automation-id",
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

// VIEW: SIDEBAR

const sidebarNoteClass = "px-2 py-1 text-xs text-muted-foreground";

const sidebarView = (model: Model, h: HtmlBuilder<Message>) =>
  h.nav(
    [
      h.AriaLabel("Automations"),
      h.Class("flex flex-col border-b bg-card/40 lg:min-h-0 lg:border-r lg:border-b-0"),
    ],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-2 px-4 pt-4 pb-2")],
        [
          h.h2([h.Class(eyebrowClass)], ["Automations"]),
          button(
            {
              onClick: Message.ClickedNewAutomation(),
              variant: "ghost",
              size: "xs",
              attributes: [h.AriaLabel("New automation")],
            },
            [icon(h, Plus, "size-3", "inline-start"), "New"],
            h,
          ),
        ],
      ),
      h.div(
        [h.Class("max-h-56 overflow-y-auto px-2 pb-3 lg:max-h-none lg:flex-1")],
        [
          Directory.match(model.directory, {
            Loading: () => h.p([h.Class(sidebarNoteClass)], ["Loading…"]),
            Unavailable: ({ error }) =>
              h.p(
                [h.Class(cn(sidebarNoteClass, "text-destructive"))],
                [`Couldn't load automations: ${error}`],
              ),
            Ready: ({ automations }) =>
              Array.match(automations, {
                onEmpty: () =>
                  h.p(
                    [h.Class(sidebarNoteClass)],
                    ["Automations show up here once the agent drafts one."],
                  ),
                onNonEmpty: (listed) =>
                  h.ul(
                    [h.Class("flex flex-col gap-0.5")],
                    Array.map(listed, (automation) =>
                      automationLinkView(automation, automation.id === model.automationId, h),
                    ),
                  ),
              }),
          }),
        ],
      ),
    ],
  );

const automationLinkView = (
  automation: typeof AutomationSummary.Type,
  isCurrent: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.keyed("li")(
    automation.id,
    [],
    [
      h.a(
        [
          h.Href(automationHref(automation.id)),
          ...(isCurrent ? [h.AriaCurrent("page")] : []),
          h.Class(
            cn(
              "relative flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
              isCurrent &&
                "bg-muted before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-signal",
            ),
          ),
        ],
        [
          h.span([h.Class("truncate text-sm font-medium")], [automation.name]),
          h.span(
            [h.Class("truncate font-mono text-[11px] text-muted-foreground")],
            [automation.id],
          ),
        ],
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

const emptyConversationView = (title: string, description: string, h: HtmlBuilder<Message>) =>
  Empty(
    { className: "flex-none items-start p-0 pt-2 text-left" },
    [
      Empty.header(
        { className: "items-start" },
        [
          Empty.title({ className: "text-base" }, [title], h),
          Empty.description({}, [description], h),
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
          h.div(
            [h.Class("flex shrink-0 items-center gap-2")],
            [
              Option.match(model.maybeRun, {
                onNone: () => h.empty,
                onSome: (run) => runBadgeView(run, h),
              }),
              workflowDisplayToggleView(model.workflowDisplay, h),
            ],
          ),
        ],
      ),
      h.div(
        [h.Id("graph"), h.AriaLive("polite"), h.Class("flex-1 px-6 py-6 lg:overflow-y-auto")],
        [
          Option.match(model.maybeDraft, {
            onNone: () => emptyWorkflowView(h),
            onSome: (workflow) =>
              model.workflowDisplay === "Json"
                ? workflowJsonView(workflow, h)
                : workflowView(workflow, model.expandedStepIds, h),
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

const workflowDisplayToggleView = (display: WorkflowDisplay, h: HtmlBuilder<Message>) =>
  button(
    {
      onClick: Message.SelectedWorkflowDisplay({ display: display === "Json" ? "Steps" : "Json" }),
      variant: display === "Json" ? "secondary" : "ghost",
      size: "xs",
      attributes: [h.AriaPressed(String(display === "Json")), h.Title("Show the draft's raw JSON")],
    },
    [icon(h, Braces, "size-3", "inline-start"), "JSON"],
    h,
  );

const workflowJsonView = (workflow: Workflow, h: HtmlBuilder<Message>) =>
  h.pre(
    [
      h.AriaLabel("Draft JSON"),
      h.Class(
        "max-w-3xl overflow-x-auto rounded-lg border bg-card px-4 py-3 font-mono text-xs leading-relaxed shadow-xs",
      ),
    ],
    [JSON.stringify(workflow, null, 2)],
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

const variableClass =
  "rounded-sm bg-signal/12 px-1 py-px font-mono text-[0.92em] font-medium text-foreground ring-1 ring-signal/30 ring-inset box-decoration-clone";

const variableView = (name: string, h: HtmlBuilder<Message>) =>
  h.span([h.Class(variableClass), h.Title(`Run input: ${name}`)], [name]);

const templateView = (text: string, h: HtmlBuilder<Message>) =>
  Array.map(templateParts(text), (part) =>
    part.kind === "variable" ? variableView(part.name, h) : part.text,
  );

const inputsView = (workflow: Workflow, h: HtmlBuilder<Message>) =>
  Array.match(workflowVariables(workflow), {
    onEmpty: () => h.empty,
    onNonEmpty: (names) =>
      h.div(
        [h.Class("mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1.5 border-t pt-2")],
        [
          h.h3([h.Id("trigger-inputs"), h.Class(eyebrowClass)], ["Inputs"]),
          h.ul(
            [h.AriaLabelledBy("trigger-inputs"), h.Class("flex flex-wrap gap-1.5 text-xs")],
            Array.map(names, (name) => h.keyed("li")(name, [], [variableView(name, h)])),
          ),
        ],
      ),
  });

const workflowView = (
  workflow: Workflow,
  expandedStepIds: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
) =>
  h.ol(
    [
      h.AriaLabel("Steps"),
      h.Class(
        "relative flex max-w-2xl flex-col gap-3 before:absolute before:top-4 before:bottom-4 before:left-4 before:w-px before:bg-border",
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
              inputsView(workflow, h),
            ],
          ),
        ],
      ),
      ...Array.map(workflow.steps, (step, index) =>
        stepView(step, String(index + 1).padStart(2, "0"), false, expandedStepIds, h),
      ),
    ],
  );

const stepIcon: Record<Step["kind"], Parameters<typeof icon>[1]> = {
  agent: Bot,
  webhook: Webhook,
  wait: Hourglass,
  parallel: Split,
  if: GitBranch,
  decide: Scale,
  human: UserRound,
};

const stepLabel: Record<Step["kind"], string> = {
  agent: "Agent",
  webhook: "Webhook",
  wait: "Wait",
  parallel: "Parallel",
  if: "Condition",
  decide: "Decision",
  human: "Human",
};

const comparisonLabel: Record<Comparison, string> = {
  equals: "is",
  notEquals: "is not",
  greaterThan: "is greater than",
  lessThan: "is less than",
  contains: "contains",
};

const stepRefClass = "rounded-sm bg-muted px-1 py-px font-mono text-[0.92em] text-foreground";

const refView = (ref: string, h: HtmlBuilder<Message>) => {
  const [root, ...path] = ref.split(".");
  return root === "input"
    ? variableView(path.join("."), h)
    : h.span(
        [h.Class(stepRefClass), h.Title(`Recorded by step ${path[0] ?? ""}`)],
        [path.join(".")],
      );
};

const valueView = (value: unknown, h: HtmlBuilder<Message>) =>
  h.span([h.Class("font-mono text-[0.92em] text-foreground")], [JSON.stringify(value)]);

const joinedConditions = (
  conditions: ReadonlyArray<Condition>,
  separator: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> =>
  Array.flatMap(conditions, (condition, index) => [
    ...(index === 0 ? [] : [separator]),
    ...conditionView(condition, h),
  ]);

const conditionView = (
  condition: Condition,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> => {
  if ("all" in condition) {
    return ["(", ...joinedConditions(condition.all, " and ", h), ")"];
  }
  if ("any" in condition) {
    return ["(", ...joinedConditions(condition.any, " or ", h), ")"];
  }
  if ("not" in condition) {
    return ["not ", ...conditionView(condition.not, h)];
  }
  if (condition.op === "exists") {
    return [refView(condition.ref, h), " is set"];
  }
  return [
    refView(condition.ref, h),
    ` ${comparisonLabel[condition.op]} `,
    valueView(condition.value, h),
  ];
};

const offsetText = (offset: string) =>
  offset.startsWith("-") ? `${offset.slice(1)} before ` : `${offset} after `;

const detailClass = (isExpanded: boolean) =>
  cn(
    "text-xs text-muted-foreground",
    isExpanded ? "whitespace-pre-wrap break-words" : "line-clamp-2",
  );

const stepDetailView = (step: Step, isExpanded: boolean, h: HtmlBuilder<Message>) =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      agent: (agent) => h.p([h.Class(detailClass(isExpanded))], templateView(agent.instruction, h)),
      webhook: (webhook) =>
        h.p(
          [
            h.Class(
              cn("font-mono text-xs text-muted-foreground", isExpanded ? "break-all" : "truncate"),
            ),
          ],
          [webhook.url],
        ),
      wait: (wait) =>
        h.p(
          [h.Class("text-xs text-muted-foreground")],
          "until" in wait
            ? [
                "Until ",
                wait.offset === undefined ? "" : offsetText(wait.offset),
                refView(wait.until, h),
              ]
            : [`Pauses for ${wait.duration}`],
        ),
      parallel: (parallel) =>
        h.p(
          [h.Class("text-xs text-muted-foreground")],
          [`${parallel.branches.length} branches run at the same time, then the run continues.`],
        ),
      if: () =>
        h.p([h.Class("text-xs text-muted-foreground")], ["Runs the first case that matches."]),
      decide: (decide) =>
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            h.p([h.Class(detailClass(isExpanded))], templateView(decide.question, h)),
            stepMetaView([`Model: ${decide.model}`], h),
          ],
        ),
      human: (human) =>
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            h.p([h.Class(detailClass(isExpanded))], templateView(human.prompt, h)),
            stepMetaView(
              [
                ...(human.assignee === undefined
                  ? []
                  : [h.span([], ["Assignee: ", ...templateView(human.assignee, h)])]),
                human.response === "approval"
                  ? "Approve or reject"
                  : `Form: ${Array.map(human.response.fields, (field) => field.label).join(", ")}`,
                ...(human.timeout === undefined ? [] : [`Times out after ${human.timeout}`]),
              ],
              h,
            ),
          ],
        ),
    }),
  );

const stepMetaView = (items: ReadonlyArray<Html | string>, h: HtmlBuilder<Message>) =>
  h.ul(
    [h.Class("flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground")],
    Array.map(items, (item) => h.li([], [item])),
  );

interface Lane {
  readonly label: string;
  readonly heading: ReadonlyArray<Html | string>;
  readonly steps: ReadonlyArray<Step>;
}

const stepLanes = (step: Step, h: HtmlBuilder<Message>): ReadonlyArray<Lane> =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      agent: () => [],
      webhook: () => [],
      wait: () => [],
      human: () => [],
      parallel: (parallel) =>
        Array.map(parallel.branches, (steps, index) => ({
          label: `Branch ${index + 1}`,
          heading: [`Branch ${index + 1}`],
          steps,
        })),
      if: (branch) => [
        ...Array.map(branch.cases, (branchCase, index) => ({
          label: `Case ${index + 1}`,
          heading: ["If ", ...conditionView(branchCase.when, h)],
          steps: branchCase.steps,
        })),
        ...(branch.otherwise === undefined || Array.isReadonlyArrayEmpty(branch.otherwise)
          ? []
          : [{ label: "Otherwise", heading: ["Otherwise"], steps: branch.otherwise }]),
      ],
      decide: (decide) =>
        Array.map(decide.options, (option) => ({
          label: `Option ${option.id}`,
          heading: [
            h.span([h.Class("font-mono text-foreground")], [option.id]),
            ` · ${option.description}`,
          ],
          steps: option.steps,
        })),
    }),
  );

const laneView = (lane: Lane, expandedStepIds: ReadonlyArray<string>, h: HtmlBuilder<Message>) =>
  h.li(
    [h.Class("flex flex-col gap-2 border-l-2 border-dashed pl-3")],
    [
      h.div([h.Class("text-xs text-muted-foreground")], lane.heading),
      h.ol(
        [h.AriaLabel(lane.label), h.Class("flex flex-col gap-2")],
        Array.map(lane.steps, (step, index) =>
          stepView(step, String(index + 1), true, expandedStepIds, h),
        ),
      ),
    ],
  );

const stepView = (
  step: Step,
  marker: string,
  isNested: boolean,
  expandedStepIds: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const isExpanded = Array.contains(expandedStepIds, step.id);
  return h.keyed("li")(
    step.id,
    [h.Class("flex gap-3 animate-in fade-in slide-in-from-top-1 duration-300")],
    [
      h.span([h.Class(cn(nodeMarkerClass, isNested && "size-6 text-[10px]"))], [marker]),
      Disclosure.view(
        {
          id: `step-${step.id}`,
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
                          [icon(h, stepIcon[step.kind], "size-3"), stepLabel[step.kind]],
                        ),
                        h.div([h.Class("text-sm font-medium")], templateView(step.title, h)),
                      ],
                    ),
                    icon(
                      h,
                      ChevronDown,
                      "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover/step:text-foreground group-aria-expanded/step:rotate-180",
                    ),
                  ],
                ),
                h.div([...panel, h.Class("mx-3.5 mb-2.5")], [stepDetailView(step, isExpanded, h)]),
                Array.match(stepLanes(step, h), {
                  onEmpty: () => h.empty,
                  onNonEmpty: (lanes) =>
                    h.ul(
                      [h.Class("mx-3.5 mb-3 flex flex-col gap-3")],
                      Array.map(lanes, (lane) => laneView(lane, expandedStepIds, h)),
                    ),
                }),
              ],
            ),
        },
        h,
      ),
    ],
  );
};

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
