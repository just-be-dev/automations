import { test } from "bun:test";
import * as Option from "effect/Option";
import { modifyFields } from "foldkit/struct";
import { scene, given, role, label, expect, type, click, Command, submit } from "foldkit/scene";
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
