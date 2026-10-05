import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import type { Url } from "foldkit/url";
import {
  ApplyTheme,
  LoadAutomation,
  LoadAutomations,
  Message,
  NavigateInternal,
  PollAutomation,
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
    init({ theme: "System" }, studioUrl(search)).model,
    Message.SucceededLoadAutomation({
      revision: 0,
      maybeDraft: Option.none(),
      hasSaved: false,
      conversation: [],
      maybePendingChat: Option.none(),
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

const working = { id: "chat-1", prompt: "Summarize orders", status: "working" } as const;

test("chat waits for the agent's reply, shows the draft, and saves that automation", () => {
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
        pendingChat: working,
      }),
    ),
    model((current) => {
      expect(current.messageInput).toBe("");
      expect(current.maybePendingChat).toEqual(Option.some(working));
    }),
    Command.expectExact(PollAutomation({ automationId: "orders", revision: 0 })),
    Command.resolve(
      PollAutomation,
      Message.SucceededLoadAutomation({
        revision: 0,
        maybeDraft: Option.none(),
        hasSaved: false,
        conversation: [],
        maybePendingChat: Option.some(working),
      }),
    ),
    Command.expectExact(PollAutomation({ automationId: "orders", revision: 0 })),
    Command.resolve(
      PollAutomation,
      Message.SucceededLoadAutomation({
        revision: 0,
        maybeDraft: Option.some(workflow),
        hasSaved: false,
        conversation: [{ id: 0, prompt: "Summarize orders", reply: "Review these steps." }],
        maybePendingChat: Option.none(),
      }),
    ),
    Command.resolve(LoadAutomations, Message.SucceededLoadAutomations({ automations: [] })),
    model((current) => {
      expect(current.conversation).toEqual([
        { id: 0, prompt: "Summarize orders", reply: "Review these steps." },
      ]);
      expect(current.maybeDraft).toEqual(Option.some(workflow));
      expect(current.maybePendingChat).toEqual(Option.none());
      expect(current.activity).toEqual(
        expect.objectContaining({
          _tag: "Ready",
          notice: "Draft updated. Review the graph before saving.",
        }),
      );
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

test("reopening an automation while the agent is answering keeps waiting for the reply", () => {
  const reopened = update(
    init({ theme: "System" }, studioUrl("automation=orders")).model,
    Message.SucceededLoadAutomation({
      revision: 0,
      maybeDraft: Option.none(),
      hasSaved: false,
      conversation: [],
      maybePendingChat: Option.some(working),
    }),
  );
  expect(reopened.model.activity._tag).toBe("Working");
  expect(reopened.model.maybePendingChat).toEqual(Option.some(working));
  expect(reopened.commands?.map((command) => command.name)).toEqual(["PollAutomation"]);
});

test("a reply the agent couldn't write puts the prompt back in the composer", () => {
  const failed = { ...working, status: "failed", error: "Agent did not answer" } as const;
  const reopened = update(
    init({ theme: "System" }, studioUrl("automation=orders")).model,
    Message.SucceededLoadAutomation({
      revision: 0,
      maybeDraft: Option.none(),
      hasSaved: false,
      conversation: [],
      maybePendingChat: Option.some(failed),
    }),
  );
  expect(reopened.model.messageInput).toBe("Summarize orders");
  expect(reopened.model.activity).toEqual(
    expect.objectContaining({
      _tag: "Failed",
      error: "The agent couldn't reply: Agent did not answer",
    }),
  );
  expect(reopened.commands).toBeUndefined();
});

test("a late chat response cannot touch another automation", () => {
  const switched = update(
    loaded(),
    Message.ChangedUrl({ url: studioUrl("automation=other") }),
  ).model;
  const received = update(
    switched,
    Message.SucceededSendMessage({ revision: 0, sentMessage: "Old prompt", pendingChat: working }),
  );
  expect(received.model).toBe(switched);
  expect(received.commands).toBeUndefined();
  expect(switched.maybePendingChat).toEqual(Option.none());
});

test("sending preserves text typed while the request was in flight", () => {
  const current = modifyFields(loaded(), { messageInput: () => "Next revision" });
  const received = update(
    current,
    Message.SucceededSendMessage({
      revision: 0,
      sentMessage: "First prompt",
      pendingChat: working,
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
  const opened = init({ theme: "System" }, studioUrl("automation=orders"));
  expect(opened.model.automationId).toBe("orders");
  expect(opened.model.automationIdInput).toBe("orders");
  expect(opened.model.activity._tag).toBe("Working");
  expect(opened.commands?.map((command) => command.name)).toEqual([
    "LoadAutomation",
    "LoadAutomations",
  ]);

  expect(init({ theme: "System" }, studioUrl()).model.automationId).toBe("my-automation");
  expect(init({ theme: "System" }, studioUrl("automation=bad%2Fid")).model.activity._tag).toBe(
    "Failed",
  );
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
        maybePendingChat: Option.none(),
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

test("the theme toggle steps through system, light, and dark, applying each choice", () => {
  story(
    update,
    given(loaded()),
    message(Message.ClickedThemeToggle()),
    model((current) => expect(current.theme).toBe("Light")),
    Command.expectExact(ApplyTheme({ theme: "Light" })),
    Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
    message(Message.ClickedThemeToggle()),
    model((current) => expect(current.theme).toBe("Dark")),
    Command.expectExact(ApplyTheme({ theme: "Dark" })),
    Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
    message(Message.ClickedThemeToggle()),
    model((current) => expect(current.theme).toBe("System")),
    Command.expectExact(ApplyTheme({ theme: "System" })),
    Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
  );
});

test("the studio boots with the saved theme", () => {
  expect(init({ theme: "Dark" }, studioUrl()).model.theme).toBe("Dark");
});
