import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import type { Url } from "foldkit/url";
import {
  LoadAutomation,
  LoadAutomations,
  Message,
  NavigateInternal,
  SendMessage,
  SaveDraft,
  init,
  update,
  type Workflow,
} from "./main.ts";

const studioUrl = (search?: string): Url => ({
  protocol: "http:",
  host: "localhost:1338",
  port: Option.some("1338"),
  pathname: "/",
  search: search === undefined ? Option.none() : Option.some(search),
  hash: Option.none(),
});

const loaded = (search?: string) =>
  update(
    init(studioUrl(search)).model,
    Message.SucceededLoadAutomation({
      revision: 0,
      maybeDraft: Option.none(),
      hasSaved: false,
      conversation: [],
    }),
  ).model;

const workflow: Workflow = {
  name: "Order summary",
  event: "order.created",
  steps: [
    {
      id: "summarize",
      kind: "agent",
      title: "Summarize order",
      instruction: "Summarize the order",
    },
    {
      id: "notify",
      kind: "webhook",
      title: "Notify fulfillment",
      url: "https://example.com/orders",
    },
  ],
};

test("chat reviews the returned draft and saves that automation", () => {
  story(
    update,
    given(modifyFields(loaded("automation=orders"), { messageInput: () => "Summarize orders" })),
    message(Message.ClickedSend()),
    Command.expectExact(
      SendMessage({ automationId: "orders", revision: 0, message: "Summarize orders" }),
    ),
    model((current) => expect(current.activity._tag).toBe("Working")),
    Command.resolve(
      SendMessage,
      Message.SucceededSendMessage({
        revision: 0,
        sentMessage: "Summarize orders",
        reply: "Review these steps.",
        workflow,
      }),
    ),
    Command.resolve(LoadAutomations, Message.SucceededLoadAutomations({ automations: [] })),
    model((current) => {
      expect(current.conversation).toEqual([
        { id: 0, prompt: "Summarize orders", reply: "Review these steps." },
      ]);
      expect(current.maybeDraft).toEqual(Option.some(workflow));
      expect(current.messageInput).toBe("");
    }),
    message(Message.ClickedSave()),
    Command.expectExact(SaveDraft({ automationId: "orders", revision: 0 })),
    Command.resolve(SaveDraft, Message.SucceededSaveDraft({ revision: 0 })),
    Command.resolve(
      LoadAutomations,
      Message.SucceededLoadAutomations({
        automations: [{ id: "orders", name: "Order summary" }],
      }),
    ),
    model((current) =>
      expect(current.directory).toEqual({
        _tag: "Ready",
        automations: [{ id: "orders", name: "Order summary" }],
      }),
    ),
  );
});

test("a late chat response cannot replace another automation's draft", () => {
  const switched = update(
    loaded(),
    Message.ChangedUrl({ url: studioUrl("automation=other") }),
  ).model;
  const received = update(
    switched,
    Message.SucceededSendMessage({
      revision: 0,
      sentMessage: "Old prompt",
      reply: "Old reply",
      workflow,
    }),
  );
  expect(received.model).toBe(switched);
  expect(received.commands).toBeUndefined();
  expect(switched.maybeDraft).toEqual(Option.none());
});

test("chat completion preserves text typed while the request was pending", () => {
  const current = modifyFields(loaded(), { messageInput: () => "Next revision" });
  const received = update(
    current,
    Message.SucceededSendMessage({
      revision: 0,
      sentMessage: "First prompt",
      reply: "Draft ready",
      workflow,
    }),
  );
  expect(received.model.messageInput).toBe("Next revision");
});

test("run polling continues only for the active running run", () => {
  const started = update(
    loaded(),
    Message.SucceededStartRun({
      revision: 0,
      run: { id: "run-new", status: "running", error: Option.none() },
    }),
  );
  const pending = update(
    started.model,
    Message.SucceededPollRun({
      revision: 0,
      run: { id: "run-new", status: "running", error: Option.none() },
    }),
  );
  expect(pending.commands?.map((command) => command.name)).toEqual(["PollRun"]);
  const stale = update(
    pending.model,
    Message.SucceededPollRun({
      revision: 0,
      run: { id: "run-old", status: "completed", error: Option.none() },
    }),
  );
  expect(stale.model).toBe(pending.model);
  expect(stale.commands).toBeUndefined();
  story(
    update,
    given(pending.model),
    message(
      Message.SucceededPollRun({
        revision: 0,
        run: { id: "run-new", status: "failed", error: Option.some("Webhook rejected") },
      }),
    ),
    Command.expectNone(),
    model((current) =>
      expect(current.activity).toEqual({
        _tag: "Ready",
        notice: "Run run-new: failed: Webhook rejected",
      }),
    ),
  );
});

test("request failures re-enable actions and old failures leave a new automation unchanged", () => {
  const sending = update(
    modifyFields(loaded(), { messageInput: () => "Hello" }),
    Message.ClickedSend(),
  );
  const failed = update(
    sending.model,
    Message.FailedRequest({ revision: 0, error: "Access denied" }),
  );
  expect(failed.model.activity).toEqual({ _tag: "Failed", error: "Access denied" });
  const switched = update(
    failed.model,
    Message.ChangedUrl({ url: studioUrl("automation=different") }),
  ).model;
  expect(update(switched, Message.FailedRequest({ revision: 0, error: "Old error" })).model).toBe(
    switched,
  );
});

test("invalid IDs and saving without a draft return errors without requests", () => {
  const invalid = modifyFields(loaded(), {
    automationId: () => "orders/bad",
    messageInput: () => "Hello",
  });
  expect(update(invalid, Message.ClickedSend()).commands).toBeUndefined();
  expect(update(invalid, Message.ClickedSend()).model.activity._tag).toBe("Failed");
  expect(update(loaded(), Message.ClickedSave()).model.activity).toEqual({
    _tag: "Failed",
    error: "Create a draft first",
  });
});

test("messages up to 10,000 characters are sent and longer ones are rejected", () => {
  const longest = "a".repeat(10_000);
  const withInput = (messageInput: string) =>
    modifyFields(loaded(), { messageInput: () => messageInput });

  story(
    update,
    given(withInput(longest)),
    message(Message.ClickedSend()),
    Command.expectExact(
      SendMessage({ automationId: "my-automation", revision: 0, message: longest }),
    ),
    Command.resolve(SendMessage, Message.FailedRequest({ revision: 0, error: "Offline" })),
  );

  const rejected = update(withInput(`${longest}a`), Message.ClickedSend());
  expect(rejected.model.activity).toEqual(
    expect.objectContaining({ _tag: "Failed", error: "Message must be 1–10,000 characters" }),
  );
  expect(rejected.commands).toBeUndefined();
});

test("the URL picks which automation opens and loads it with the automation list", () => {
  const opened = init(studioUrl("automation=orders"));
  expect(opened.model.automationId).toBe("orders");
  expect(opened.model.automationIdInput).toBe("orders");
  expect(opened.model.activity._tag).toBe("Working");
  expect(opened.commands?.map((command) => command.name)).toEqual([
    "LoadAutomation",
    "LoadAutomations",
  ]);

  expect(init(studioUrl()).model.automationId).toBe("my-automation");
  expect(init(studioUrl("automation=bad%2Fid")).model.activity._tag).toBe("Failed");
});

test("typing an ID doesn't reset the page and committing it navigates to its URL", () => {
  const typed = update(loaded(), Message.UpdatedAutomationId({ value: "orders" }));
  expect(typed.model.automationId).toBe("my-automation");
  expect(typed.model.automationIdInput).toBe("orders");

  story(
    update,
    given(typed.model),
    message(Message.ChangedAutomationId()),
    Command.expectExact(NavigateInternal({ url: "/?automation=orders" })),
    Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
  );

  const unchanged = update(
    modifyFields(loaded(), { automationIdInput: () => " my-automation " }),
    Message.ChangedAutomationId(),
  );
  expect(unchanged.commands).toBeUndefined();
});

test("a URL change loads that automation and restores its conversation", () => {
  story(
    update,
    given(loaded()),
    message(Message.ChangedUrl({ url: studioUrl("automation=orders") })),
    Command.expectExact(LoadAutomation({ automationId: "orders", revision: 1 })),
    model((current) => {
      expect(current.automationId).toBe("orders");
      expect(current.activity._tag).toBe("Working");
    }),
    Command.resolve(
      LoadAutomation,
      Message.SucceededLoadAutomation({
        revision: 1,
        maybeDraft: Option.some(workflow),
        hasSaved: true,
        conversation: [{ id: 0, prompt: "Summarize orders", reply: "Review these steps." }],
      }),
    ),
    model((current) => {
      expect(current.maybeDraft).toEqual(Option.some(workflow));
      expect(current.conversation).toEqual([
        { id: 0, prompt: "Summarize orders", reply: "Review these steps." },
      ]);
    }),
  );
});
