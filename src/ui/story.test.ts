import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { Message, SendMessage, SaveDraft, init, update, type Workflow } from "./main.ts";

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
    given(
      modifyFields(init().model, {
        automationId: () => "orders",
        messageInput: () => "Summarize orders",
      }),
    ),
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
  );
});

test("a late chat response cannot replace another automation's draft", () => {
  const switched = update(init().model, Message.UpdatedAutomationId({ value: "other" })).model;
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
  const current = modifyFields(init().model, { messageInput: () => "Next revision" });
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
    init().model,
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
    modifyFields(init().model, { messageInput: () => "Hello" }),
    Message.ClickedSend(),
  );
  const failed = update(
    sending.model,
    Message.FailedRequest({ revision: 0, error: "Access denied" }),
  );
  expect(failed.model.activity).toEqual({ _tag: "Failed", error: "Access denied" });
  const switched = update(failed.model, Message.UpdatedAutomationId({ value: "different" })).model;
  expect(update(switched, Message.FailedRequest({ revision: 0, error: "Old error" })).model).toBe(
    switched,
  );
});

test("invalid IDs and saving without a draft return errors without requests", () => {
  const invalid = modifyFields(init().model, {
    automationId: () => "orders/bad",
    messageInput: () => "Hello",
  });
  expect(update(invalid, Message.ClickedSend()).commands).toBeUndefined();
  expect(update(invalid, Message.ClickedSend()).model.activity._tag).toBe("Failed");
  expect(update(init().model, Message.ClickedSave()).model.activity).toEqual({
    _tag: "Failed",
    error: "Create a draft first",
  });
});

test("messages up to 10,000 characters are sent and longer ones are rejected", () => {
  const longest = "a".repeat(10_000);
  const withInput = (messageInput: string) =>
    modifyFields(init().model, { messageInput: () => messageInput });

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
