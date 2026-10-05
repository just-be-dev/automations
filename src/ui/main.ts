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
  Hash,
  Hourglass,
  Monitor,
  Moon,
  Scale,
  Split,
  Sun,
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
import { Bubble } from "@/components/ui/bubble";
import { button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Message as ChatMessage } from "@/components/ui/message";
import { textarea } from "@/components/ui/textarea";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import {
  PendingChat,
  templateParts,
  workflowVariables,
  Workflow,
  type Comparison,
  type Condition,
  type Step,
} from "../workflow.ts";
import { applyTheme, nextTheme, Theme, type Flags } from "./theme.ts";

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
  maybePendingChat: Schema.Option(PendingChat),
  maybeRun: Schema.Option(Run),
  expandedStepIds: Schema.Array(Schema.String),
  workflowDisplay: WorkflowDisplay,
  theme: Theme,
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
  ClickedThemeToggle: {},
  CompletedApplyTheme: {},
  ClickedSend: {},
  ClickedSave: {},
  ClickedStart: {},
  SucceededLoadAutomation: {
    revision: Schema.Int,
    maybeDraft: Schema.Option(Workflow),
    hasSaved: Schema.Boolean,
    conversation: Schema.Array(Exchange),
    maybePendingChat: Schema.Option(PendingChat),
  },
  SucceededLoadAutomations: { automations: Schema.Array(AutomationSummary) },
  FailedLoadAutomations: { error: Schema.String },
  SucceededSendMessage: {
    revision: Schema.Int,
    sentMessage: Schema.String,
    pendingChat: PendingChat,
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

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (flags, url) => {
  const automationId = automationIdFromUrl(url);
  const model = Model.make({
    automationId,
    automationIdInput: automationId,
    directory: Directory.Loading(),
    revision: 0,
    messageInput: "",
    conversation: [],
    maybeDraft: Option.none(),
    maybePendingChat: Option.none(),
    maybeRun: Option.none(),
    expandedStepIds: [],
    workflowDisplay: "Steps",
    theme: flags.theme,
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
    maybePendingChat: () => Option.none(),
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

const thinking = Activity.Working({ notice: "The agent is thinking…" });

const isAnswering = (pending: PendingChat) => pending.status === "working";

const loadedAutomation = (
  model: Model,
  options: { readonly wasWaiting: boolean; readonly idleNotice: string },
): Update.Return<Model, Message> =>
  Option.match(model.maybePendingChat, {
    onNone: () =>
      options.wasWaiting
        ? {
            model: modifyFields(model, {
              activity: () =>
                Activity.Ready({ notice: "Draft updated. Review the graph before saving." }),
            }),
            commands: [LoadAutomations()],
          }
        : {
            model: modifyFields(model, {
              activity: () => Activity.Ready({ notice: options.idleNotice }),
            }),
          },
    onSome: (pending) =>
      Match.value(pending).pipe(
        Match.discriminatorsExhaustive("status")({
          working: () => ({
            model: modifyFields(model, { activity: () => thinking }),
            commands: [
              PollAutomation({ automationId: model.automationId.trim(), revision: model.revision }),
            ],
          }),
          failed: ({ prompt, error }) => ({
            model: modifyFields(model, {
              messageInput: (value) => (value === "" ? prompt : value),
              activity: () => Activity.Failed({ error: `The agent couldn't reply: ${error}` }),
            }),
          }),
        }),
      ),
  });

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
    ClickedThemeToggle: () => {
      const theme = nextTheme[model.theme];
      return {
        model: modifyFields(model, { theme: () => theme }),
        commands: [ApplyTheme({ theme })],
      };
    },
    CompletedApplyTheme: () => ({ model }),
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
    SucceededLoadAutomation: ({
      revision,
      maybeDraft,
      hasSaved,
      conversation,
      maybePendingChat,
    }) =>
      revision !== model.revision
        ? { model }
        : loadedAutomation(
            modifyFields(model, {
              maybeDraft: () => maybeDraft,
              conversation: () => conversation,
              maybePendingChat: () => maybePendingChat,
            }),
            {
              wasWaiting: Option.exists(model.maybePendingChat, isAnswering),
              idleNotice: hasSaved ? "Saved automation available." : "No saved automation yet.",
            },
          ),
    SucceededSendMessage: ({ revision, sentMessage, pendingChat }) =>
      revision !== model.revision
        ? { model }
        : {
            model: modifyFields(model, {
              maybePendingChat: () => Option.some(pendingChat),
              messageInput: (value) => (value === sentMessage ? "" : value),
              activity: () => thinking,
            }),
            commands: [PollAutomation({ automationId: model.automationId.trim(), revision })],
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

const loadAutomation = (automationId: string, revision: number) =>
  request(
    automationId,
    "",
    Schema.Struct({
      draft: Schema.OptionFromOptional(Workflow),
      saved: Schema.OptionFromOptional(Workflow),
      conversation: Schema.Array(Schema.Struct({ prompt: Schema.String, reply: Schema.String })),
      pendingChat: Schema.OptionFromOptional(PendingChat),
    }),
  ).pipe(
    Effect.map((state) =>
      Message.SucceededLoadAutomation({
        revision,
        maybeDraft: state.draft,
        hasSaved: Option.isSome(state.saved),
        conversation: Array.map(state.conversation, (exchange, id) => ({ id, ...exchange })),
        maybePendingChat: state.pendingChat,
      }),
    ),
    recoverRequest(revision),
    Effect.provide(Http.layer),
  );

export const LoadAutomation = Command.define("LoadAutomation", {
  args: requestArgs,
  messages: [Message.SucceededLoadAutomation, Message.FailedRequest],
  execute: ({ automationId, revision }) => loadAutomation(automationId, revision),
});

/** Reloads the automation after a pause, while the agent is still answering a message. */
export const PollAutomation = Command.define("PollAutomation", {
  args: requestArgs,
  messages: [Message.SucceededLoadAutomation, Message.FailedRequest],
  execute: ({ automationId, revision }) =>
    Effect.sleep("1500 millis").pipe(Effect.andThen(loadAutomation(automationId, revision))),
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

export const ApplyTheme = Command.define("ApplyTheme", {
  args: { theme: Theme },
  messages: [Message.CompletedApplyTheme],
  execute: ({ theme }) => applyTheme(theme).pipe(Effect.as(Message.CompletedApplyTheme())),
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
    request(automationId, "/chat", Schema.Struct({ pendingChat: PendingChat }), { message }).pipe(
      Effect.map((data) =>
        Message.SucceededSendMessage({
          revision,
          sentMessage: message,
          pendingChat: data.pendingChat,
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

const eyebrowClass = "text-xs font-medium text-sand-10";

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Automations studio",
  body: h.div(
    [h.Class("flex min-h-full flex-col bg-sidebar lg:h-full lg:flex-row")],
    [
      sidebarView(model, h),
      h.div(
        [h.Class("flex min-w-0 flex-1 flex-col bg-background lg:min-h-0 lg:border-l")],
        [
          headerView(model, h),
          h.main(
            [
              h.Class(
                "grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]",
              ),
            ],
            [conversationView(model, h), workflowPanelView(model, h)],
          ),
        ],
      ),
    ],
  ),
});

const headerView = (model: Model, h: HtmlBuilder<Message>) =>
  h.header(
    [
      h.Class(
        "grid h-12 shrink-0 grid-cols-[1fr_minmax(0,28rem)_1fr] items-center gap-2 border-b px-4",
      ),
    ],
    [
      h.div([]),
      Input.view(
        {
          id: automationIdInputId,
          value: model.automationIdInput,
          placeholder: "new-automation-id",
          onInput: (value) => Message.UpdatedAutomationId({ value }),
          toView: (attributes) =>
            h.div(
              [
                h.Class(
                  "flex h-8 w-full max-w-md items-center gap-1.5 rounded-[10px] border bg-sidebar px-2 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25",
                ),
              ],
              [
                icon(h, Hash, "size-4 text-muted-foreground"),
                h.label([...attributes.label, h.Class("sr-only")], ["Automation ID"]),
                h.input([
                  ...attributes.input,
                  h.Autocomplete("off"),
                  h.Spellcheck(false),
                  h.OnChange(() => Message.ChangedAutomationId()),
                  h.Class(
                    "h-full min-w-0 flex-1 bg-transparent px-0.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground",
                  ),
                ]),
              ],
            ),
        },
        h,
      ),
      themeToggleView(model.theme, h),
    ],
  );

const themeIcon: Record<Theme, Parameters<typeof icon>[1]> = {
  System: Monitor,
  Light: Sun,
  Dark: Moon,
};

const themeToggleView = (theme: Theme, h: HtmlBuilder<Message>) =>
  button(
    {
      onClick: Message.ClickedThemeToggle(),
      variant: "ghost",
      size: "icon-sm",
      className: "justify-self-end rounded-[10px] text-sand-10",
      attributes: [
        h.AriaLabel(`Color theme: ${theme}`),
        h.Title(`Color theme: ${theme}. Click for ${nextTheme[theme]}.`),
      ],
    },
    [icon(h, themeIcon[theme], "size-4")],
    h,
  );

// VIEW: SIDEBAR

const sidebarNoteClass = "px-1.5 py-1 text-xs text-muted-foreground";

const sidebarView = (model: Model, h: HtmlBuilder<Message>) =>
  h.nav(
    [
      h.AriaLabel("Automations"),
      h.Class("flex shrink-0 flex-col border-b px-2 pb-2 lg:min-h-0 lg:w-60 lg:border-b-0"),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-1.5 px-2 py-3")],
        [
          h.span(
            [
              h.Class(
                "flex size-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-brand/80 to-brand text-[13px] font-medium text-signal-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.3)]",
              ),
              h.AriaHidden(true),
            ],
            ["A"],
          ),
          h.span([h.Class("truncate text-sm font-medium")], ["Automations studio"]),
        ],
      ),
      h.div(
        [h.Class("mt-1 mb-px flex h-[22px] items-center justify-between gap-2 pr-0.5 pl-1.5")],
        [
          h.h2([h.Class("text-[11px] font-semibold tracking-tight text-sand-10")], ["Automations"]),
          button(
            {
              onClick: Message.ClickedNewAutomation(),
              variant: "ghost",
              size: "icon-xs",
              className: "text-sand-10",
              attributes: [h.AriaLabel("New automation"), h.Title("New automation")],
            },
            [icon(h, Plus, "size-3.5")],
            h,
          ),
        ],
      ),
      h.div(
        [h.Class("max-h-56 overflow-y-auto lg:max-h-none lg:flex-1")],
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
                    [h.Class("flex flex-col")],
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
              "group/nav-item my-px flex items-start gap-2 rounded-[8px] py-1.5 pr-2.5 pl-1.5 text-muted-foreground transition-colors duration-100 outline-none hover:bg-hover hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
              isCurrent && "bg-hover text-foreground",
            ),
          ),
        ],
        [
          h.span([h.Class("flex h-5 shrink-0 items-center")], [icon(h, WorkflowIcon, "size-4")]),
          h.span(
            [h.Class("flex min-w-0 flex-col gap-0.5")],
            [
              h.span(
                [h.Class("truncate text-[13px] font-medium tracking-tight")],
                [automation.name],
              ),
              h.span([h.Class("truncate font-mono text-[11px] text-sand-10")], [automation.id]),
            ],
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
    onSome: (pending) => [pendingChatView(pending, h)],
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

const pendingChatView = (pending: PendingChat, h: HtmlBuilder<Message>) =>
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
                [icon(h, LoaderCircle, "size-3.5 animate-spin text-signal"), "Thinking…"],
              ),
            ],
            failed: ({ error }) => [
              h.span(
                [h.Class("flex items-center gap-2 text-destructive")],
                [icon(h, CircleAlert, "size-3.5"), `Couldn't reply: ${error}`],
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
              value: model.messageInput,
              placeholder: "When an order arrives, summarize its contents and send the summary to…",
              onInput: (value) => Message.UpdatedMessageInput({ value }),
              className:
                "max-h-60 min-h-20 resize-none border-0 bg-transparent px-3.5 pt-3 placeholder:text-muted-foreground/80 focus-visible:ring-0",
            },
            h,
          ),
          h.div(
            [h.Class("flex items-center justify-between gap-3 pr-2 pb-2 pl-3.5")],
            [
              h.span(
                [h.Class("font-mono text-[11px] text-muted-foreground tabular-nums")],
                [`${model.messageInput.length} / ${maxMessageLength.toLocaleString("en-US")}`],
              ),
              button(
                {
                  onClick: Message.ClickedSend(),
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

// VIEW: WORKFLOW

const workflowPanelView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [h.Class("flex flex-col lg:min-h-0"), h.AriaLabel("Workflow")],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-4 px-6 pt-5")],
        [
          h.div(
            [h.Class("min-w-0")],
            [
              h.div([h.Class(eyebrowClass)], ["Draft"]),
              h.h2(
                [h.Class("truncate text-xl font-semibold")],
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
        [h.Class("flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-6 py-3")],
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
        "max-w-3xl overflow-x-auto rounded-[10px] bg-card px-4 py-3 font-mono text-xs leading-relaxed shadow-card",
      ),
    ],
    [JSON.stringify(workflow, null, 2)],
  );

const emptyWorkflowView = (h: HtmlBuilder<Message>) =>
  Empty(
    { className: "max-w-xl rounded-[10px] bg-card shadow-card" },
    [
      Empty.header(
        {},
        [
          Empty.media({ className: "icon-tile" }, [icon(h, WorkflowIcon, "size-3.5")], h),
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

const chipClass =
  "rounded-[4px] bg-chip px-1.5 py-0.5 font-mono text-[0.92em] box-decoration-clone";

const variableView = (name: string, h: HtmlBuilder<Message>) =>
  h.span([h.Class(cn(chipClass, "text-foreground")), h.Title(`Run input: ${name}`)], [name]);

const templateView = (text: string, h: HtmlBuilder<Message>) =>
  Array.map(templateParts(text), (part) =>
    part.kind === "variable" ? variableView(part.name, h) : part.text,
  );

const inputsView = (workflow: Workflow, h: HtmlBuilder<Message>) =>
  Array.match(workflowVariables(workflow), {
    onEmpty: () => h.empty,
    onNonEmpty: (names) =>
      h.div(
        [h.Class("flex flex-wrap items-baseline gap-x-2 gap-y-1.5")],
        [
          h.h3([h.Id("trigger-inputs"), h.Class("text-muted-foreground")], ["Inputs"]),
          h.ul(
            [h.AriaLabelledBy("trigger-inputs"), h.Class("flex flex-wrap gap-1.5")],
            Array.map(names, (name) => h.keyed("li")(name, [], [variableView(name, h)])),
          ),
        ],
      ),
  });

const triggerView = (workflow: Workflow, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("flex gap-3")],
    [
      h.div(
        [h.Class("flex w-[18px] shrink-0 flex-col items-center"), h.AriaHidden(true)],
        [
          icon(h, workflow.event ? Radio : Play, "mt-[3px] size-[18px] text-muted-foreground"),
          h.div([h.Class("mt-1.5 w-[1.5px] flex-1 bg-rail")]),
        ],
      ),
      h.div(
        [h.Class("flex min-w-0 flex-1 flex-col gap-2 text-sm")],
        [
          workflow.event
            ? h.p(
                [h.Class("text-muted-foreground")],
                [
                  "When ",
                  h.span(
                    [h.Class(cn(chipClass, "text-foreground")), h.Title("Event")],
                    [workflow.event],
                  ),
                  " arrives",
                ],
              )
            : h.p([h.Class("leading-6 text-muted-foreground")], ["Manual start"]),
          inputsView(workflow, h),
        ],
      ),
    ],
  );

const workflowView = (
  workflow: Workflow,
  expandedStepIds: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [h.Class("flex max-w-2xl flex-col")],
    [
      triggerView(workflow, h),
      h.ol(
        [h.AriaLabel("Steps"), h.Class("mt-3 flex flex-col gap-3")],
        Array.map(workflow.steps, (step) => stepView(step, expandedStepIds, h)),
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

const stepRefClass = cn(chipClass, "text-sand-11");

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
    [h.Class("flex flex-col gap-2")],
    [
      h.div([h.Class("text-xs text-muted-foreground")], lane.heading),
      h.ol(
        [h.AriaLabel(lane.label), h.Class("rail-start flex flex-col gap-3")],
        Array.map(lane.steps, (step) => stepView(step, expandedStepIds, h)),
      ),
    ],
  );

const stepView = (
  step: Step,
  expandedStepIds: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const isExpanded = Array.contains(expandedStepIds, step.id);
  return h.keyed("li")(
    step.id,
    [h.Class("rail-item animate-in fade-in slide-in-from-top-1 duration-300")],
    [
      Disclosure.view(
        {
          id: `step-${step.id}`,
          isOpen: isExpanded,
          onToggle: (isOpen) => Message.ToggledStepDetails({ stepId: step.id, isOpen }),
          toView: ({ button, panel }) =>
            h.div(
              [h.Class("flex flex-col gap-1")],
              [
                h.button(
                  [
                    ...button,
                    h.Class(
                      "group/step flex w-full cursor-pointer items-start gap-2.5 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    ),
                  ],
                  [
                    h.span(
                      [h.Class("icon-tile"), h.Title(stepLabel[step.kind]), h.AriaHidden(true)],
                      [icon(h, stepIcon[step.kind], "size-3.5")],
                    ),
                    h.span(
                      [h.Class("min-w-0 flex-1 py-0.5 text-sm")],
                      [
                        h.span([h.Class("sr-only")], [`${stepLabel[step.kind]}: `]),
                        ...templateView(step.title, h),
                      ],
                    ),
                    icon(
                      h,
                      ChevronDown,
                      "mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover/step:opacity-100 group-focus-visible/step:opacity-100 group-aria-expanded/step:rotate-180 group-aria-expanded/step:opacity-100",
                    ),
                  ],
                ),
                h.div([...panel, h.Class("pl-[34px]")], [stepDetailView(step, isExpanded, h)]),
                Array.match(stepLanes(step, h), {
                  onEmpty: () => h.empty,
                  onNonEmpty: (lanes) =>
                    h.ul(
                      [h.Class("flex flex-col gap-3 pt-1.5 pl-[34px]")],
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

const runStatusClass: Record<Run["status"], string> = {
  running: "text-signal",
  completed: "text-success",
  failed: "text-destructive",
};

const runDotClass: Record<Run["status"], string> = {
  running: "animate-pulse bg-signal",
  completed: "bg-success",
  failed: "bg-destructive",
};

const runBadgeView = (run: Run, h: HtmlBuilder<Message>) =>
  h.span(
    [
      h.Class(
        cn(
          "mt-1.5 inline-flex items-center gap-1.5 text-sm font-semibold whitespace-nowrap",
          runStatusClass[run.status],
        ),
      ),
    ],
    [
      h.span([h.Class(cn("size-1.5 rounded-full", runDotClass[run.status])), h.AriaHidden(true)]),
      runStatusLabel[run.status],
      h.span([h.Class("font-mono text-xs font-normal text-sand-10")], [run.id]),
    ],
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
