import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Command, Http, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { Button, Input, Textarea } from "@foldkit/ui";

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

export const Model = Schema.Struct({
  automationId: Schema.String,
  revision: Schema.Int,
  messageInput: Schema.String,
  conversation: Schema.String,
  maybeDraft: Schema.Option(Workflow),
  maybeRun: Schema.Option(Run),
  activity: Activity,
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedAutomationId: { value: Schema.String },
  ChangedAutomationId: {},
  UpdatedMessageInput: { value: Schema.String },
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

const initialConversation = "Start by describing what should happen.";

export const init = () => ({
  model: Model.make({
    automationId: "my-automation",
    revision: 0,
    messageInput: "",
    conversation: initialConversation,
    maybeDraft: Option.none(),
    maybeRun: Option.none(),
    activity: Activity.Ready({ notice: "" }),
  }),
});

// UPDATE

const fail = (model: Model, error: string) => ({
  model: modifyFields(model, { activity: () => Activity.Failed({ error }) }),
});

const validId = (value: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(value.trim());

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    UpdatedAutomationId: ({ value }) => ({
      model: modifyFields(model, {
        automationId: () => value,
        revision: (revision) => revision + 1,
        maybeDraft: () => Option.none(),
        maybeRun: () => Option.none(),
        conversation: () => initialConversation,
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
      if (!model.messageInput.trim() || model.messageInput.length > 4000) {
        return fail(model, "Message must be 1–4000 characters");
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
                `${conversation}\n\nYou: ${sentMessage}\nAgent: ${reply}`,
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

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Automations studio",
  body: h.div(
    [],
    [
      h.header(
        [],
        [
          h.h1([], ["✳ Automations ", h.span([], ["studio"])]),
          h.span([], ["Design → Review → Run"]),
        ],
      ),
      h.main(
        [],
        [
          h.section(
            [],
            [
              h.h2([], ["Describe your process"]),
              h.p(
                [],
                [
                  "Talk through the steps with an agent. Revise as often as you like before saving.",
                ],
              ),
              Input.view(
                {
                  id: "id",
                  value: model.automationId,
                  onInput: (value) => Message.UpdatedAutomationId({ value }),
                  toView: (attributes) =>
                    h.div(
                      [],
                      [
                        h.label(attributes.label, ["Automation ID"]),
                        h.input([
                          ...attributes.input,
                          h.Autocomplete("off"),
                          h.OnChange(() => Message.ChangedAutomationId()),
                        ]),
                      ],
                    ),
                },
                h,
              ),
              h.div([h.Id("messages"), h.AriaLive("polite")], [model.conversation]),
              Textarea.view(
                {
                  id: "message",
                  value: model.messageInput,
                  placeholder:
                    "When an order arrives, summarize its contents and send the summary to…",
                  onInput: (value) => Message.UpdatedMessageInput({ value }),
                  toView: (attributes) =>
                    h.div(
                      [],
                      [
                        h.label(attributes.label, ["Your message"]),
                        h.textarea(attributes.textarea),
                      ],
                    ),
                },
                h,
              ),
              h.div(
                [h.Class("row")],
                [
                  Button.view(
                    {
                      onClick: Message.ClickedSend(),
                      isDisabled: Activity.guards.Working(model.activity),
                      toView: (attributes) =>
                        h.button([...attributes.button, h.Id("send")], ["Send message"]),
                    },
                    h,
                  ),
                ],
              ),
            ],
          ),
          h.section(
            [],
            [
              h.h2([], ["Workflow preview"]),
              h.p(
                [],
                [
                  "Steps run from top to bottom. Event triggers accept POST requests; you can also start any saved automation manually.",
                ],
              ),
              h.div(
                [h.Id("graph"), h.AriaLive("polite")],
                [
                  Option.match(model.maybeDraft, {
                    onNone: () => h.div([], ["Your workflow will appear here."]),
                    onSome: (workflow) => workflowView(workflow, h),
                  }),
                ],
              ),
              h.div(
                [h.Class("row")],
                [
                  Button.view(
                    {
                      onClick: Message.ClickedSave(),
                      isDisabled: Activity.guards.Working(model.activity),
                      toView: (attributes) =>
                        h.button(
                          [...attributes.button, h.Id("save"), h.Class("secondary")],
                          ["Save reviewed draft"],
                        ),
                    },
                    h,
                  ),
                  Button.view(
                    {
                      onClick: Message.ClickedStart(),
                      isDisabled: Activity.guards.Working(model.activity),
                      toView: (attributes) =>
                        h.button(
                          [...attributes.button, h.Id("start"), h.Class("secondary")],
                          ["Start manually"],
                        ),
                    },
                    h,
                  ),
                ],
              ),
              h.div(
                [
                  h.Id("status"),
                  h.Role("status"),
                  h.Class(Activity.guards.Failed(model.activity) ? "error" : ""),
                ],
                [
                  Activity.match(model.activity, {
                    Ready: ({ notice }) => notice,
                    Working: ({ notice }) => notice,
                    Failed: ({ error }) => error,
                  }),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  ),
});

const workflowView = (workflow: Workflow, h: HtmlBuilder<Message>) =>
  h.div(
    [],
    [
      h.div(
        [h.Class("node")],
        [
          h.small([], ["trigger"]),
          h.b([], [workflow.event ? `Event: ${workflow.event}` : "Manual start"]),
        ],
      ),
      ...workflow.steps.map((step) =>
        h.keyed("div")(
          step.id,
          [],
          [
            h.div([h.Class("arrow"), h.AriaHidden(true)], ["↓"]),
            h.div([h.Class("node")], [h.small([], [step.kind]), h.b([], [step.title])]),
          ],
        ),
      ),
    ],
  );
