import { test } from "bun:test";
import * as Option from "effect/Option";
import { modifyFields } from "foldkit/struct";
import {
  scene,
  given,
  role,
  label,
  expect,
  type,
  click,
  Command,
  submit,
  keydown,
  expectHandled,
  expectIgnored,
  within,
} from "foldkit/scene";
import * as Assistant from "./assistant/index.ts";
import { assistantOf, sessionId, stateOf } from "./assistant/fixtures.ts";
import { PersistCollapsed } from "./assistant/command.ts";
import { proposalOf } from "./change/fixtures.ts";
import { init } from "./main.ts";
import { studioUrl } from "./fixtures.ts";
import { toAssistantMessage } from "./message.ts";
import { update } from "./update/index.ts";
import { view } from "./view/index.ts";

const root = (pathname = "/") =>
  modifyFields(
    init(
      { theme: "System", shortcutModifier: "Meta" },
      modifyFields(studioUrl(), { pathname: () => pathname }),
    ).model,
    { assistant: () => assistantOf() },
  );

["/", "/entities", "/templates", "/traces"].forEach((pathname) =>
  test(`assistant is available on ${pathname}`, () => {
    scene(
      { update, view },
      given(root(pathname)),
      expect(role("complementary", { name: "Assistant" })).toExist(),
      expect(label("Message assistant")).toExist(),
    );
  }),
);

[
  { name: "Create a template", prompt: "Help me create an onboarding email template." },
  { name: "Add entities", prompt: "Help me create and populate entities." },
  { name: "Draft an automation", prompt: "Help me draft an onboarding automation." },
].forEach(({ name, prompt }) =>
  test(`${name} fills the composer without sending or changing data`, () => {
    scene(
      { update, view },
      given(root("/templates")),
      expect(role("heading", { name: "What would you like to do?" })).toExist(),
      expect(role("button", { name: "Send to assistant" })).toHaveText(""),
      click(role("button", { name })),
      expect(label("Message assistant")).toHaveValue(prompt),
      Command.expectNone(),
    );
  }),
);

test("an existing conversation replaces the introduction", () => {
  scene(
    { update, view },
    given(
      modifyFields(root(), {
        assistant: () =>
          assistantOf({
            conversation: [{ id: "turn-1", prompt: "Create a template", reply: "Which wording?" }],
          }),
      }),
    ),
    expect(role("region", { name: "Get started" })).not.toExist(),
    expect(label("Message assistant")).toExist(),
  );
});

test("assistant controls are labelled icons and following has a visible toggle state", () => {
  scene(
    { update, view },
    given(root("/templates")),
    expect(role("heading", { name: "Assistant" })).not.toExist(),
    expect(role("button", { name: "Follow along" })).toHaveText(""),
    expect(role("button", { name: "Follow along" })).toHaveAttr("title", "Follow along"),
    expect(role("button", { name: "Follow along" })).toHaveAttr("aria-pressed", "false"),
    expect(role("button", { name: "Collapse assistant" })).toHaveText(""),
    expect(role("button", { name: "Collapse assistant" })).toHaveAttr(
      "title",
      "Collapse assistant",
    ),
    click(role("button", { name: "Follow along" })),
    Command.resolve(
      Assistant.RequestAssistant,
      Assistant.Message.SucceededRequest({
        sessionId,
        sequence: 1,
        state: stateOf(),
        sentInput: "",
      }),
    ),
    expect(role("button", { name: "Follow along" })).toHaveAttr("aria-pressed", "true"),
    expect(role("button", { name: "Follow along" })).toHaveAttr("title", "Stop following along"),
    click(role("button", { name: "Follow along" })),
    expect(role("button", { name: "Follow along" })).toHaveAttr("aria-pressed", "false"),
    Command.expectNone(),
  );
});

test("collapsing keeps the input and session; expanding restores the composer", () => {
  scene(
    { update, view },
    given(root("/templates")),
    type(label("Message assistant"), "Keep this draft"),
    click(role("button", { name: "Collapse assistant" })),
    Command.resolve(PersistCollapsed, Assistant.Message.CompletedPersistCollapsed()),
    expect(label("Message assistant")).not.toExist(),
    expect(role("button", { name: "Open assistant" })).toHaveText(""),
    click(role("button", { name: "Open assistant" })),
    Command.resolve(PersistCollapsed, Assistant.Message.CompletedPersistCollapsed()),
    expect(label("Message assistant")).toHaveValue("Keep this draft"),
    submit(role("form", { name: "Assistant chat" })),
    Command.expectExact(
      Assistant.RequestAssistant({
        sessionId,
        sequence: 1,
        path: "/chat",
        body: Option.some({ message: "Keep this draft", context: { pathname: "/templates" } }),
        delay: 0,
        sentInput: "Keep this draft",
      }),
    ),
    Command.resolve(
      Assistant.RequestAssistant,
      Assistant.Message.SucceededRequest({
        sessionId,
        sequence: 1,
        state: stateOf(),
        sentInput: "Keep this draft",
      }),
    ),
  );
});

test("the platform's modifier with Enter sends the assistant message, and Enter alone doesn't", () => {
  const composer = label("Message assistant");
  const sent = Assistant.RequestAssistant({
    sessionId,
    sequence: 1,
    path: "/chat",
    body: Option.some({ message: "Add a customer", context: { pathname: "/templates" } }),
    delay: 0,
    sentInput: "Add a customer",
  });
  const succeeded = Assistant.Message.SucceededRequest({
    sessionId,
    sequence: 1,
    state: stateOf(),
    sentInput: "Add a customer",
  });
  scene(
    { update, view },
    given(root("/templates")),
    expect(composer).toHaveAttr("aria-keyshortcuts", "Meta+Enter"),
    type(composer, "Add a customer"),
    keydown(composer, "Enter"),
    expectIgnored(),
    keydown(composer, "Enter", { ctrlKey: true }),
    expectIgnored(),
    keydown(composer, "Enter", { metaKey: true }),
    expectHandled(),
    Command.expectExact(sent),
    Command.resolve(Assistant.RequestAssistant, succeeded),
  );
  scene(
    { update, view },
    given(modifyFields(root("/templates"), { shortcutModifier: () => "Control" as const })),
    type(composer, "Add a customer"),
    keydown(composer, "Enter", { metaKey: true }),
    expectIgnored(),
    keydown(composer, "Enter", { ctrlKey: true }),
    Command.expectExact(sent),
    Command.resolve(Assistant.RequestAssistant, succeeded),
  );
});

[true, false].forEach((approved) =>
  test(`inline confirmation ${approved ? "approves" : "cancels"} only on explicit action`, () => {
    const proposal = proposalOf({ kind: "deleteTemplate", name: "welcome_email" });
    const confirming = modifyFields(root(), {
      assistant: () => assistantOf({ status: "confirming", confirmation: proposal }),
    });
    scene(
      { update, view },
      given(confirming),
      expect(role("heading", { name: proposal.title })).toExist(),
      Command.expectNone(),
      click(role("button", { name: approved ? proposal.confirmLabel : "Cancel" })),
      Command.expectExact(
        Assistant.RequestAssistant({
          sessionId,
          sequence: 1,
          path: "/confirmation",
          body: Option.some({ proposalId: proposal.id, approved }),
          delay: 0,
          sentInput: "",
        }),
      ),
      Command.resolve(
        Assistant.RequestAssistant,
        Assistant.Message.SucceededRequest({
          sessionId,
          sequence: 1,
          state: stateOf(),
          sentInput: "",
        }),
      ),
      expect(role("heading", { name: proposal.title })).not.toExist(),
    );
  }),
);

test("assistant questions accept choices and written answers in the same session", () => {
  const questions = {
    callId: "ask-1",
    questions: [
      {
        header: "Timing",
        question: "When should this run?",
        options: [{ label: "Today" }, { label: "Tomorrow" }],
      },
    ],
  };
  const asking = update(
    root(),
    toAssistantMessage(
      Assistant.Message.SucceededRequest({
        sessionId,
        sequence: 0,
        state: stateOf({ status: "asking", questions }),
        sentInput: "",
      }),
    ),
  ).model;
  scene(
    { update, view },
    given(asking),
    click(role("button", { name: "Today" })),
    expect(role("button", { name: "Today" })).toHaveAttr("aria-pressed", "true"),
    type(label("Write your own answer"), "Next Monday"),
    click(role("button", { name: "Send answers" })),
    Command.expectExact(
      Assistant.RequestAssistant({
        sessionId,
        sequence: 2,
        path: "/answers",
        body: Option.some({
          callId: "ask-1",
          answer: { kind: "answers", answers: ["Next Monday"] },
        }),
        delay: 0,
        sentInput: "",
      }),
    ),
    Command.resolve(
      Assistant.RequestAssistant,
      Assistant.Message.SucceededRequest({
        sessionId,
        sequence: 2,
        state: stateOf(),
        sentInput: "",
      }),
    ),
    expect(role("region", { name: "Assistant questions" })).not.toExist(),
  );
});

test("stopping a turn swaps the send button for stop, and marks the message stopped", () => {
  const working = modifyFields(root(), {
    assistant: () =>
      assistantOf({ status: "working", conversation: [{ id: "turn", prompt: "Draft it" }] }),
  });
  scene(
    { update, view },
    given(working),
    expect(role("button", { name: "Send to assistant" })).not.toExist(),
    click(role("button", { name: "Stop the agent" })),
    Command.expectExact(
      Assistant.RequestAssistant({
        sessionId,
        sequence: 1,
        path: "/stop",
        body: Option.some({}),
        delay: 0,
        sentInput: "",
      }),
    ),
    Command.resolve(
      Assistant.RequestAssistant,
      Assistant.Message.SucceededRequest({
        sessionId,
        sequence: 1,
        state: stateOf({ conversation: [{ id: "turn", prompt: "Draft it", stopped: true }] }),
        sentInput: "",
      }),
    ),
    expect(role("button", { name: "Stop the agent" })).not.toExist(),
    expect(role("button", { name: "Send to assistant" })).toExist(),
    expect(role("complementary", { name: "Assistant" })).toContainText("Stopped"),
  );
});

test("past threads open, archive, and restore from the history view", () => {
  const otherId = "c3a1e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c5d";
  const archivedId = "d4b2f3c5-6e7a-4b8c-9d0e-1f2a3b4c5d6e";
  const threads = [
    { id: sessionId, title: "Open thread", createdAt: 0, updatedAt: 2, archived: false },
    {
      id: otherId,
      title: "Onboarding email template",
      createdAt: 0,
      updatedAt: 1,
      archived: false,
    },
    { id: archivedId, title: "Old idea", createdAt: 0, updatedAt: 0, archived: true },
  ];
  scene(
    { update, view },
    given(root()),
    click(role("button", { name: "Past threads" })),
    Command.expectExact(Assistant.LoadThreads()),
    Command.resolve(Assistant.LoadThreads, Assistant.Message.SucceededLoadThreads({ threads })),
    expect(role("list", { name: "Threads" })).toContainText("Onboarding email template"),
    expect(role("list", { name: "Archived threads" })).not.toExist(),
    click(role("button", { name: "Show archived (1)" })),
    expect(role("list", { name: "Archived threads" })).toContainText("Old idea"),
    click(role("button", { name: "Restore Old idea" })),
    Command.expectExact(Assistant.ArchiveThread({ sessionId: archivedId, archived: false })),
    Command.resolve(
      Assistant.ArchiveThread,
      Assistant.Message.SucceededArchiveThread({
        sessionId: archivedId,
        archived: false,
        threads: threads.map((thread) => ({ ...thread, archived: false })),
      }),
    ),
    expect(role("list", { name: "Threads" })).toContainText("Old idea"),
    click(role("button", { name: /Onboarding email template/ })),
    Command.expectExact(
      Assistant.RequestAssistant({
        sessionId: otherId,
        sequence: 1,
        path: "",
        body: Option.none(),
        delay: 0,
        sentInput: "",
      }),
      Assistant.PersistSession({ sessionId: otherId }),
    ),
    Command.resolve(
      Assistant.RequestAssistant,
      Assistant.Message.SucceededRequest({
        sessionId: otherId,
        sequence: 1,
        state: {
          ...stateOf({ conversation: [{ id: "t", prompt: "Make a template", reply: "Done" }] }),
          sessionId: otherId,
          title: "Onboarding email template",
        },
        sentInput: "",
      }),
    ),
    Command.resolve(Assistant.PersistSession, Assistant.Message.CompletedPersistSession()),
    expect(role("list", { name: "Threads" })).not.toExist(),
    expect(role("complementary", { name: "Assistant" })).toContainText("Make a template"),
  );
});

test("a new thread opens empty and focuses the composer", () => {
  const newId = "e5c3a4d6-7f8b-4c9d-8e1f-2a3b4c5d6e7f";
  const chatting = modifyFields(root(), {
    assistant: () =>
      assistantOf({ conversation: [{ id: "t", prompt: "Earlier question", reply: "Answer" }] }),
  });
  scene(
    { update, view },
    given(chatting),
    click(role("button", { name: "New thread" })),
    Command.expectExact(Assistant.CreateThread({ input: "" })),
    Command.resolve(
      Assistant.CreateThread,
      Assistant.Message.CompletedCreateThread({ sessionId: newId, input: "" }),
    ),
    Command.expectHas(Assistant.FocusInput()),
    Command.resolve(Assistant.FocusInput, Assistant.Message.CompletedFocusInput()),
    Command.resolve(
      Assistant.RequestAssistant,
      Assistant.Message.SucceededRequest({
        sessionId: newId,
        sequence: 1,
        state: { ...stateOf(), sessionId: newId },
        sentInput: "",
      }),
    ),
    expect(role("heading", { name: "What would you like to do?" })).toExist(),
  );
});

test("clearing a thread asks first, then erases it in place", () => {
  const chatting = modifyFields(root(), {
    assistant: () =>
      assistantOf({ conversation: [{ id: "t", prompt: "Earlier question", reply: "Answer" }] }),
  });
  scene(
    { update, view },
    given(chatting),
    click(role("button", { name: "Clear thread" })),
    Command.expectNone(),
    expect(role("alertdialog", { name: "Clear this thread?" })).toExist(),
    click(role("button", { name: "Cancel" })),
    expect(role("alertdialog", { name: "Clear this thread?" })).not.toExist(),
    click(role("button", { name: "Clear thread" })),
    click(within(role("alertdialog"), role("button", { name: "Clear thread" }))),
    Command.expectExact(
      Assistant.RequestAssistant({
        sessionId,
        sequence: 1,
        path: "/clear",
        body: Option.some({}),
        delay: 0,
        sentInput: "",
      }),
    ),
    Command.resolve(
      Assistant.RequestAssistant,
      Assistant.Message.SucceededRequest({
        sessionId,
        sequence: 1,
        state: stateOf(),
        sentInput: "",
      }),
    ),
    expect(role("heading", { name: "What would you like to do?" })).toExist(),
  );
});
