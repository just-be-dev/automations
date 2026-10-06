import { test } from "bun:test";
import { Animation, Dialog as FoldkitDialog } from "@foldkit/ui";
import * as Option from "effect/Option";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import {
  Command,
  change,
  click,
  expect,
  expectHandled,
  expectIgnored,
  given,
  keydown,
  label,
  Mount,
  role,
  scene,
  selector,
  submit,
  text,
  type,
  within,
} from "foldkit/scene";
import type { Question, Workflow } from "../workflow.ts";
import * as Dialog from "@/components/ui/dialog";
import {
  AnswerTask,
  CreateAutomation,
  FocusOwnAnswer,
  LoadAutomations,
  LoadRun,
  NavigateInternal,
  PollAutomation,
  SendAnswers,
  SendMessage,
  SetPermission,
  StartRun,
} from "./command.ts";
import {
  approvalTask,
  laptopTask,
  onboarding,
  permissionTask,
  runOf,
  studioUrl,
  summaryOf,
} from "./fixtures.ts";
import { init } from "./main.ts";
import { Message, toOverviewMessage } from "./message.ts";
import type { Model } from "./model.ts";
import { Entities, Overview } from "./page/index.ts";
import { update } from "./update/index.ts";
import { view } from "./view/index.ts";

const automationLoaded = (
  fields: Partial<Parameters<typeof Message.SucceededLoadAutomation>[0]> = {},
) =>
  Message.SucceededLoadAutomation({
    revision: 0,
    maybeDraft: Option.none(),
    maybeSaved: Option.none(),
    conversation: [],
    maybePendingChat: Option.none(),
    maybeProgress: Option.none(),
    runs: [],
    ...fields,
  });

const loaded = update(
  init({ theme: "System", shortcutModifier: "Meta" }, studioUrl("automation=my-automation")).model,
  automationLoaded(),
).model;

const runUrl = (runId: string) => studioUrl(`automation=my-automation&run=${runId}`);

const withDraft = (draft: Workflow) =>
  modifyFields(loaded, { maybeDraft: () => Option.some(draft) });

const requestArgs = { automationId: "my-automation", revision: 0 };

const runLoaded = (fields: { revision: number; poll: number; run: ReturnType<typeof runOf> }) =>
  Message.SucceededLoadRun({ ...fields, maybeSubjectTitle: Option.some("Ari Cho") });

const applied = (start: Model, messages: ReadonlyArray<Message>) =>
  messages.reduce((current, next) => update(current, next).model, start);

const withOpenRun = (run: ReturnType<typeof runOf>) =>
  applied(init({ theme: "System", shortcutModifier: "Meta" }, runUrl(run.id)).model, [
    runLoaded({ revision: 0, poll: 1, run }),
  ]);

test("the accessible message input drives chat and safely renders the workflow", () => {
  scene(
    { update, view },
    given(loaded),
    expect(role("banner")).toContainText("my-automation"),
    expect(role("region", { name: "Conversation" })).toExist(),
    type(label("Your message"), "Summarize orders"),
    click(role("button", { name: "Send message" })),
    Command.expectExact(SendMessage({ ...requestArgs, message: "Summarize orders" })),
    Command.resolve(
      SendMessage,
      Message.SucceededSendMessage({
        revision: 0,
        sentMessage: "Summarize orders",
        pendingChat: { id: "chat-1", prompt: "Summarize orders", status: "working" },
      }),
    ),
    expect(label("Your message")).toHaveValue(""),
    expect(text("Summarize orders")).toExist(),
    expect(text("Thinking…")).toExist(),
    Command.resolve(
      PollAutomation,
      automationLoaded({
        maybePendingChat: Option.some({
          id: "chat-1",
          prompt: "Summarize orders",
          status: "working",
        }),
        maybeProgress: Option.some("Planning the steps…"),
      }),
    ),
    expect(text("Planning the steps…")).toExist(),
    expect(text("Thinking…")).not.toExist(),
    Command.resolve(
      PollAutomation,
      automationLoaded({
        conversation: [
          {
            id: 0,
            prompt: "Summarize orders",
            reply: "Ready to review.",
            asked: [],
          },
        ],
        maybeDraft: Option.some({
          name: "Orders",
          trigger: { kind: "manual" },
          steps: [
            {
              id: "summary",
              kind: "agent",
              title: "<script>alert('unsafe')</script>",
              instruction: "Summarize",
            },
          ],
        }),
      }),
    ),
    expect(text("Thinking…")).not.toExist(),
    expect(text("Ready to review.")).toExist(),
    expect(text("Manual start")).toExist(),
    expect(text("<script>alert('unsafe')</script>")).toExist(),
    Command.resolve(LoadAutomations, Message.SucceededLoadAutomations({ automations: [] })),
  );
});

test("the agent's reply renders Markdown without letting it add markup", () => {
  const reply = [
    "**Almost done.** Two things:",
    "",
    "1. Read [the guide](https://example.com/guide)",
    "2. Ignore [this](javascript:alert(1)) and <b>raw</b> HTML",
  ].join("\n");
  const conversation = role("region", { name: "Conversation" });
  scene(
    { update, view },
    given(
      update(
        loaded,
        automationLoaded({
          conversation: [{ id: 0, prompt: "Summarize orders", reply, asked: [] }],
        }),
      ).model,
    ),
    expect(within(conversation, role("strong"))).toHaveText("Almost done."),
    expect(within(conversation, role("list"))).toContainText("Read the guide"),
    expect(role("link", { name: "the guide" })).toHaveAttr("href", "https://example.com/guide"),
    expect(role("link", { name: "the guide" })).toHaveAttr("target", "_blank"),
    expect(role("link", { name: "this" })).not.toExist(),
    expect(within(conversation, role("list"))).toContainText("Ignore this and <b>raw</b> HTML"),
  );
});

const approver = {
  question: "Who should approve the email?",
  header: "Approver",
  options: [{ label: "Managers", description: "Each hire's manager" }, { label: "HR" }],
};

const askedWith = (questions: ReadonlyArray<Question>) =>
  update(
    loaded,
    automationLoaded({
      maybePendingChat: Option.some({
        id: "chat-1",
        prompt: "Email new hires",
        status: "asking" as const,
        questions,
      }),
    }),
  ).model;

const answered = (answers: ReadonlyArray<string | null>) =>
  SendAnswers({ ...requestArgs, chatId: "chat-1", answer: { kind: "answers", answers } });

const resumedWith = (questions: ReadonlyArray<Question>, answers: ReadonlyArray<string | null>) =>
  Command.resolve(
    SendAnswers,
    Message.SucceededSendAnswers({
      revision: 0,
      pendingChat: {
        id: "chat-1",
        prompt: "Email new hires",
        status: "working",
        asked: [{ questions, answer: { kind: "answers", answers } }],
      },
    }),
  );

const yourAnswers = selector('[aria-label="Your answers"]');

test("picking an answer to the agent's only question sends it and resumes the reply", () => {
  const managers = role("button", { name: /Managers/ });
  scene(
    { update, view },
    given(askedWith([approver])),
    expect(role("group", { name: "Questions from the agent" })).toContainText(approver.question),
    expect(role("navigation", { name: "Questions" })).not.toExist(),
    expect(managers).toContainText("Each hire's manager"),
    expect(label("Your message")).toHaveAttr(
      "placeholder",
      "Or answer the agent in your own words…",
    ),
    click(managers),
    Command.expectExact(answered(["Managers"])),
    expect(managers).toBeDisabled(),
    resumedWith([approver], ["Managers"]),
    expect(managers).not.toExist(),
    expect(role("list", { name: "Questions from the agent, answered" })).toContainText(
      approver.question,
    ),
    expect(yourAnswers).toContainText("Approver"),
    expect(yourAnswers).toContainText("Managers"),
    expect(text("Thinking…")).toExist(),
    Command.resolve(PollAutomation, Message.FailedRequest({ revision: 0, error: "Offline" })),
  );
});

test("the person can skip the agent's questions", () => {
  scene(
    { update, view },
    given(askedWith([approver])),
    click(role("button", { name: "Skip questions" })),
    Command.expectExact(answered([null])),
    resumedWith([approver], [null]),
    expect(text("Skipped the questions")).toExist(),
    Command.resolve(PollAutomation, Message.FailedRequest({ revision: 0, error: "Offline" })),
  );
});

test("a finished reply shows the questions it asked and how they were answered", () => {
  const timeZone = {
    question: "Which time zone?",
    header: "Time zone",
    options: [{ label: "London" }, { label: "Tokyo" }],
  };
  const conversation = role("region", { name: "Conversation" });
  scene(
    { update, view },
    given(
      update(
        loaded,
        automationLoaded({
          conversation: [
            {
              id: 0,
              prompt: "Email new hires",
              asked: [
                {
                  questions: [approver, timeZone],
                  answer: { kind: "answers", answers: ["HR", null] },
                },
                { questions: [timeZone], answer: { kind: "message", text: "Whatever HR uses" } },
              ],
              reply: "Done.",
            },
          ],
        }),
      ).model,
    ),
    expect(conversation).toContainText(approver.question),
    expect(yourAnswers).toContainText("HR"),
    expect(yourAnswers).toContainText("Skipped"),
    expect(conversation).toContainText("Whatever HR uses"),
    expect(conversation).toContainText("Done."),
    expect(role("group", { name: "Questions from the agent" })).not.toExist(),
  );
});

test("the person can answer a question in their own words", () => {
  const ownAnswer = label("Your own answer");
  scene(
    { update, view },
    given(askedWith([approver])),
    click(role("button", { name: "Write your own answer" })),
    Command.expectExact(FocusOwnAnswer()),
    Command.resolve(FocusOwnAnswer, Message.CompletedFocusOwnAnswer()),
    expect(role("button", { name: "Send answer" })).toBeDisabled(),
    type(ownAnswer, "  The People Ops lead  "),
    click(role("button", { name: "Send answer" })),
    Command.expectExact(answered(["The People Ops lead"])),
    resumedWith([approver], ["The People Ops lead"]),
    expect(yourAnswers).toContainText("The People Ops lead"),
    expect(ownAnswer).not.toExist(),
    Command.resolve(PollAutomation, Message.FailedRequest({ revision: 0, error: "Offline" })),
  );
});

test("several questions are answered one at a time, reviewed, and sent together", () => {
  const timeZones = {
    question: "Which time zones should it use?",
    header: "Time zones",
    multiSelect: true,
    options: [{ label: "London" }, { label: "New York" }, { label: "Tokyo" }],
  };
  const channel = {
    question: "Where should reminders go?",
    header: "Channel",
    options: [{ label: "Slack" }, { label: "Email" }],
  };
  const questions = role("group", { name: "Questions from the agent" });
  const step = (name: string) =>
    within(role("navigation", { name: "Questions" }), role("button", { name }));
  scene(
    { update, view },
    given(askedWith([approver, timeZones, channel])),
    expect(step("Approver")).toHaveAttr("aria-current", "step"),
    click(role("button", { name: "HR" })),
    expect(questions).toContainText(timeZones.question),
    expect(step("Time zones")).toHaveAttr("aria-current", "step"),
    expect(questions).toContainText("Pick any that apply."),
    click(role("button", { name: "London" })),
    click(role("button", { name: "New York" })),
    click(role("button", { name: "Tokyo" })),
    click(role("button", { name: "New York" })),
    expect(role("button", { name: "London" })).toHaveAttr("aria-pressed", "true"),
    expect(role("button", { name: "New York" })).toHaveAttr("aria-pressed", "false"),
    click(role("button", { name: "Next" })),
    expect(questions).toContainText(channel.question),
    click(role("button", { name: "Skip" })),
    expect(questions).toContainText("Review your answers"),
    expect(questions).toContainText("London, Tokyo"),
    expect(questions).toContainText("Not answered yet: Channel."),
    click(step("Approver")),
    expect(role("button", { name: "HR" })).toHaveAttr("aria-pressed", "true"),
    click(step("Review")),
    click(role("button", { name: "Send answers" })),
    Command.expectExact(answered(["HR", "London, Tokyo", null])),
    resumedWith([approver, timeZones, channel], ["HR", "London, Tokyo", null]),
    expect(yourAnswers).toContainText("London, Tokyo"),
    expect(yourAnswers).toContainText("Skipped"),
    expect(questions).not.toExist(),
    Command.resolve(PollAutomation, Message.FailedRequest({ revision: 0, error: "Offline" })),
  );
});

test("the platform's modifier with Enter sends the composer's message, and Enter alone doesn't", () => {
  const composer = label("Your message");
  scene(
    { update, view },
    given(loaded),
    type(composer, "Summarize orders"),
    keydown(composer, "Enter"),
    expectIgnored(),
    keydown(composer, "Enter", { ctrlKey: true }),
    expectIgnored(),
    keydown(composer, "Enter", { metaKey: true }),
    expectHandled(),
    Command.expectExact(SendMessage({ ...requestArgs, message: "Summarize orders" })),
    Command.resolve(SendMessage, Message.FailedRequest({ revision: 0, error: "Offline" })),
  );
  scene(
    { update, view },
    given(modifyFields(loaded, { shortcutModifier: () => "Control" as const })),
    type(composer, "Summarize orders"),
    keydown(composer, "Enter", { metaKey: true }),
    expectIgnored(),
    keydown(composer, "Enter", { ctrlKey: true }),
    Command.expectExact(SendMessage({ ...requestArgs, message: "Summarize orders" })),
    Command.resolve(SendMessage, Message.FailedRequest({ revision: 0, error: "Offline" })),
  );
});

test("a truncated step description expands to show the full text", () => {
  const instruction =
    "Read the order payload and write a two-sentence summary of what was bought, the total, and anything unusual about shipping or payment.";
  const stepToggle = role("button", { name: /Summarize the order/ });

  scene(
    { update, view },
    given(
      withDraft({
        name: "Orders",
        trigger: { kind: "manual" },
        steps: [{ id: "summary", kind: "agent", title: "Summarize the order", instruction }],
      }),
    ),
    expect(stepToggle).toHaveAttr("aria-expanded", "false"),
    expect(text(instruction)).toHaveClass("line-clamp-2"),
    click(stepToggle),
    expect(stepToggle).toHaveAttr("aria-expanded", "true"),
    expect(text(instruction)).not.toHaveClass("line-clamp-2"),
    expect(text(instruction)).toHaveClass("whitespace-pre-wrap"),
    click(stepToggle),
    expect(stepToggle).toHaveAttr("aria-expanded", "false"),
    expect(text(instruction)).toHaveClass("line-clamp-2"),
  );
});

test("the sidebar links to every automation and marks the open one", () => {
  scene(
    { update, view },
    given(
      update(
        loaded,
        Message.SucceededLoadAutomations({
          automations: [
            { id: "my-automation", name: "Manager onboarding" },
            { id: "orders", name: "Order summaries" },
          ],
        }),
      ).model,
    ),
    expect(role("link", { name: /Manager onboarding/ })).toHaveAttr(
      "href",
      "/?automation=my-automation",
    ),
    expect(role("link", { name: /Manager onboarding/ })).toHaveAttr("aria-current", "page"),
    expect(role("link", { name: /Order summaries/ })).toHaveAttr("href", "/?automation=orders"),
    expect(role("link", { name: /Order summaries/ })).not.toHaveAttr("aria-current"),
  );
});

test("+ opens a dialog whose description creates an automation, lists it, and opens it", () => {
  const created = { id: "onboard-new-hires", name: "Onboard new hires" };
  const orders = { id: "orders", name: "Order summaries" };
  const form = role("form", { name: "New automation" });
  const onboarding = "When a hire's start date is set, welcome them by email.";
  scene(
    { update, view },
    given(update(loaded, Message.SucceededLoadAutomations({ automations: [orders] })).model),
    click(role("button", { name: "New automation" })),
    Command.resolveAll(
      [FoldkitDialog.ShowDialog, Dialog.Message.SucceededShowDialog()],
      [Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })],
      [Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })],
    ),
    Mount.resolve(FoldkitDialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    expect(role("heading", { name: "New automation" })).toExist(),
    submit(form),
    expect(role("alert")).toHaveText("Describe what the automation should do"),
    type(label("What should it do?"), onboarding),
    expect(role("alert")).not.toExist(),
    submit(form),
    Command.expectExact(CreateAutomation({ description: onboarding })),
    expect(role("button", { name: "Creating…" })).toBeDisabled(),
    Command.resolve(
      CreateAutomation,
      Message.SucceededCreateAutomation({ automation: created, wasDescriptionSent: true }),
    ),
    expect(role("link", { name: /Onboard new hires/ })).toHaveAttr(
      "href",
      "/?automation=onboard-new-hires",
    ),
    Command.resolveAll(
      [Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 2 })],
      [Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 2 })],
      [FoldkitDialog.CloseDialog, Dialog.Message.CompletedCloseDialog()],
      [NavigateInternal, Message.CompletedNavigateInternal()],
      [LoadAutomations, Message.SucceededLoadAutomations({ automations: [created, orders] })],
    ),
    Mount.expectEnded(FoldkitDialog.AcquireResources),
    expect(role("heading", { name: "New automation" })).not.toExist(),
    expect(role("link", { name: /Order summaries/ })).toExist(),
  );
});

test("the empty overview's New automation button opens the dialog", () => {
  scene(
    { update, view },
    given(
      applied(init({ theme: "System", shortcutModifier: "Meta" }, studioUrl()).model, [
        toOverviewMessage(
          Overview.Message.SucceededLoadOverview({ session: 0, poll: 0, automations: [] }),
        ),
        Message.SucceededLoadAutomations({ automations: [] }),
      ]),
    ),
    expect(text("No automations yet")).toExist(),
    click(within(role("main"), role("button", { name: "New automation" }))),
    Command.resolveAll(
      [FoldkitDialog.ShowDialog, Dialog.Message.SucceededShowDialog()],
      [Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })],
      [Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })],
    ),
    Mount.resolve(FoldkitDialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    expect(role("heading", { name: "New automation" })).toExist(),
  );
});

test("a description the server turns down stays in the dialog with the reason", () => {
  scene(
    { update, view },
    given(
      modifyFields(loaded, {
        newAutomationDialog: () =>
          modifyFields(Dialog.init({ id: "new-automation", isAnimated: false }), {
            isOpen: () => true,
          }),
      }),
    ),
    Mount.resolve(FoldkitDialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    type(label("What should it do?"), "Summarize orders"),
    submit(role("form", { name: "New automation" })),
    Command.resolve(CreateAutomation, Message.FailedCreateAutomation({ error: "Offline" })),
    expect(role("alert")).toHaveText("Offline"),
    expect(label("What should it do?")).toHaveValue("Summarize orders"),
    expect(role("button", { name: "Create automation" })).not.toBeDisabled(),
  );
});

test("⌘+Enter in the description creates the automation, and Enter alone doesn't", () => {
  const description = label("What should it do?");
  scene(
    { update, view },
    given(
      modifyFields(loaded, {
        newAutomationDialog: () =>
          modifyFields(Dialog.init({ id: "new-automation", isAnimated: false }), {
            isOpen: () => true,
          }),
      }),
    ),
    Mount.resolve(FoldkitDialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    type(description, "Summarize orders"),
    keydown(description, "Enter"),
    expectIgnored(),
    keydown(description, "Enter", { ctrlKey: true }),
    expectIgnored(),
    keydown(description, "Enter", { metaKey: true }),
    expectHandled(),
    Command.expectExact(CreateAutomation({ description: "Summarize orders" })),
    Command.resolve(CreateAutomation, Message.FailedCreateAutomation({ error: "Offline" })),
  );
});

test("subject fields render as chips in steps and in the list of what the workflow reads", () => {
  scene(
    { update, view },
    given(
      withDraft({
        name: "Onboarding",
        trigger: { kind: "manual", subject: "employee" },
        steps: [
          {
            id: "it",
            kind: "agent",
            title: "Order a laptop for {{employee.name}}",
            instruction:
              "File an IT ticket for {{employee.name}} starting {{employee.start_date}}.",
            output: { fields: [{ name: "ticket", type: "text" }] },
          },
        ],
      }),
    ),
    expect(text("Manual start for an employee")).toExist(),
    expect(role("list", { name: "Reads" })).toHaveText("employee.nameemployee.start_date"),
    expect(role("button", { name: /Order a laptop for employee.name$/ })).toExist(),
    expect(text("File an IT ticket for employee.name starting employee.start_date.")).toExist(),
    expect(text("Records ticket")).toExist(),
    expect(text("{{employee.name}}", { exact: false })).not.toExist(),
  );
});

test("an entity trigger reads as the change that starts the run", () => {
  scene(
    { update, view },
    given(
      withDraft({
        name: "Onboarding",
        trigger: {
          kind: "entity",
          entity: "employee",
          fields: ["start_date", "manager"],
          when: { ref: "employee.start_date", op: "after", value: "now" },
        },
        steps: [{ id: "wait", kind: "wait", title: "Wait a day", duration: "1 day" }],
      }),
    ),
    expect(
      text(
        "When an employee is created or its start_date or manager changes, and employee.start_date is after now",
      ),
    ).toExist(),
    expect(role("list", { name: "Reads" })).toHaveText("employee.start_date"),
  );
});

test("action steps name their operation, list their inputs, and flag simulated connections", () => {
  scene(
    { update, view },
    given(withDraft(onboarding)),
    expect(role("button", { name: "Send a Slack message: Tell the manager" })).toExist(),
    expect(role("list", { name: "Tell the manager inputs" })).toHaveText(
      "to: employee.managertext: employee.name starts on employee.start_date",
    ),
    expect(text("Simulated")).toExist(),
    expect(text("Assignee: employee.manager")).toExist(),
    expect(text("Notifies via Slack")).toExist(),
    expect(role("list", { name: "Order a laptop form" })).toContainText(
      "Start date · date · default employee.start_date",
    ),
  );
});

test("action steps show the template they use and the inputs each match case supplies", () => {
  const welcome: Workflow = {
    name: "Welcome",
    trigger: { kind: "entity", entity: "employee" },
    steps: [
      {
        id: "welcome",
        kind: "action",
        title: "Welcome the hire",
        use: "email.send",
        with: { to: "{{employee}}" },
        match: {
          on: "employee.role",
          cases: [
            {
              when: { op: "contains", value: "engineer" },
              template: {
                use: "engineering_welcome_email",
                with: { hire: "{{employee}}", manager: "{{employee.manager}}" },
              },
            },
          ],
          otherwise: {
            with: { subject: "Welcome" },
            template: { use: "welcome_email", with: { hire: "{{employee}}" } },
          },
        },
      },
    ],
  };
  scene(
    { update, view },
    given(withDraft(welcome)),
    expect(role("list", { name: "Welcome the hire inputs" })).toHaveText("to: employee"),
    expect(role("list", { name: "Welcome the hire cases" })).toContainText(
      'If employee.role contains "engineer"Template engineering_welcome_email · hire: employee · manager: employee.manager',
    ),
    expect(role("list", { name: "Welcome the hire cases" })).toContainText(
      "OtherwiseTemplate welcome_email · hire: employee",
    ),
    expect(role("list", { name: "Otherwise inputs" })).toHaveText("subject: Welcome"),
  );
});

const roles = [
  { name: "people_ops", label: "People Ops", members: [{ type: "employee", id: "grace" }] },
  { name: "finance", label: "Finance", members: [] },
];

const withRoles = (model: Model, listed: typeof roles = roles) =>
  update(model, Message.SucceededLoadRoles({ roles: listed })).model;

const permissionButton = (name: string) =>
  within(role("group", { name: "Send a Slack message permission" }), role("button", { name }));

test("asking first picks a role to approve, and the approver can be changed", () => {
  const asking = (ask: string): Workflow => ({
    ...onboarding,
    permissions: { "slack.sendMessage": { ask } },
  });
  scene(
    { update, view },
    given(withRoles(withDraft({ ...onboarding, permissions: { "slack.sendMessage": "auto" } }))),
    expect(role("list", { name: "Permissions" })).toContainText("Send a Slack message"),
    expect(permissionButton("Allow")).toHaveAttr("aria-pressed", "true"),
    expect(role("combobox", { name: "Send a Slack message approver" })).not.toExist(),
    click(permissionButton("Ask first")),
    Command.expectExact(
      SetPermission({
        ...requestArgs,
        operation: "slack.sendMessage",
        permission: { ask: "people_ops" },
      }),
    ),
    Command.resolve(
      SetPermission,
      Message.SucceededSetPermission({ revision: 0, draft: asking("people_ops") }),
    ),
    expect(permissionButton("Ask first")).toHaveAttr("aria-pressed", "true"),
    expect(role("combobox", { name: "Send a Slack message approver" })).toHaveValue("people_ops"),
    expect(text("Asks People Ops")).toExist(),
    change(role("combobox", { name: "Send a Slack message approver" }), "finance"),
    Command.expectExact(
      SetPermission({
        ...requestArgs,
        operation: "slack.sendMessage",
        permission: { ask: "finance" },
      }),
    ),
    Command.resolve(
      SetPermission,
      Message.SucceededSetPermission({ revision: 0, draft: asking("finance") }),
    ),
    expect(text("Asks Finance")).toExist(),
    expect(text("Permission updated. Save the draft to use it in runs.")).toExist(),
  );
});

test("without roles, nothing can ask first", () => {
  scene(
    { update, view },
    given(
      withRoles(withDraft({ ...onboarding, permissions: { "slack.sendMessage": "auto" } }), []),
    ),
    expect(permissionButton("Ask first")).toBeDisabled(),
    expect(permissionButton("Ask first")).toHaveAttr("title", "Ask first: Add a role to ask first"),
  );
});

test("a run shows declined and skipped steps, and why a stop step ended it", () => {
  const stopped = runOf({
    workflow: {
      ...onboarding,
      steps: [
        ...onboarding.steps,
        {
          id: "follow-up",
          kind: "agent",
          title: "Follow up",
          instruction: "Check {{steps.notify.ts}}",
        },
        { id: "halt", kind: "stop", title: "Halt", reason: "{{employee.name}} withdrew" },
      ],
    },
    status: "stopped",
    stopReason: "Ari Cho withdrew",
    steps: {
      approve: { status: "done", record: { approved: true } },
      laptop: { status: "done" },
      notify: { status: "declined" },
      "follow-up": { status: "skipped" },
      halt: { status: "done", record: { reason: "Ari Cho withdrew" } },
    },
  });
  scene(
    { update, view },
    given(withOpenRun(stopped)),
    expect(text("Stopped: Ari Cho withdrew")).toExist(),
    expect(role("button", { name: /Tell the manager.*Declined/ })).toExist(),
    expect(role("button", { name: /Follow up.*Skipped/ })).toExist(),
    expect(role("button", { name: /Stop: Halt.*Done/ })).toExist(),
    expect(text("Ends the run: employee.name withdrew")).toExist(),
  );
});

test("a permission request shows what the action will send and sends the approval", () => {
  const waiting = runOf({
    workflow: { ...onboarding, permissions: { "slack.sendMessage": { ask: "people_ops" } } },
    steps: {
      approve: { status: "done", record: { approved: true } },
      laptop: { status: "done" },
      notify: { status: "waiting" },
    },
    tasks: [permissionTask],
  });
  const sent = runOf({
    ...waiting,
    status: "completed",
    steps: {
      ...waiting.steps,
      notify: { status: "done", record: { simulated: true, channel: "@sam@example.com", ts: "1" } },
    },
    tasks: [{ ...permissionTask, status: "closed" }],
  });
  scene(
    { update, view },
    given(withOpenRun(waiting)),
    expect(text(permissionTask.prompt)).toExist(),
    expect(text("Approved by People Ops (Grace Hopper)")).toExist(),
    expect(role("list", { name: "Send a Slack message details" })).toHaveText(
      "to: Sam Park <sam@example.com>text: Ari Cho starts on 2026-11-02",
    ),
    expect(role("button", { name: /Tell the manager.*Waiting/ })).toExist(),
    click(role("button", { name: "Approve" })),
    Command.expectExact(
      AnswerTask({ ...requestArgs, runId: "run-1", step: "notify", answer: { approved: true } }),
    ),
    Command.resolve(
      AnswerTask,
      Message.SucceededAnswerTask({ revision: 0, runId: "run-1", step: "notify" }),
    ),
    Command.resolve(LoadRun, runLoaded({ revision: 0, poll: 2, run: sent })),
    expect(role("list", { name: "Open tasks" })).not.toExist(),
    expect(text("Answer sent.")).toExist(),
  );
});

test("the JSON toggle shows the draft's raw workflow", () => {
  const draft: Workflow = {
    name: "Orders",
    trigger: { kind: "manual" },
    steps: [{ id: "summary", kind: "agent", title: "Summarize", instruction: "Summarize it" }],
  };
  const toggle = role("button", { name: "JSON" });

  scene(
    { update, view },
    given(withDraft(draft)),
    expect(toggle).toHaveAttr("aria-pressed", "false"),
    expect(label("Draft JSON")).not.toExist(),
    click(toggle),
    expect(toggle).toHaveAttr("aria-pressed", "true"),
    expect(label("Draft JSON")).toHaveText(JSON.stringify(draft, null, 2)),
    expect(role("list", { name: "Steps" })).not.toExist(),
    click(toggle),
    expect(role("list", { name: "Steps" })).toExist(),
  );
});

test("nested steps render as labelled lanes with readable conditions and settings", () => {
  scene(
    { update, view },
    given(
      withDraft({
        name: "Onboarding",
        trigger: { kind: "manual", subject: "employee" },
        steps: [
          {
            id: "prep",
            title: "Prep",
            kind: "parallel",
            branches: [
              [{ id: "laptop", title: "Order laptop", kind: "agent", instruction: "Order it" }],
              [
                {
                  id: "week-out",
                  title: "One week out",
                  kind: "wait",
                  until: "employee.start_date",
                  offset: "-7 days",
                },
              ],
            ],
          },
          {
            id: "route",
            title: "Route",
            kind: "decide",
            model: "clef-flash",
            question: "Is {{employee.manager}} around?",
            options: [
              { id: "around", description: "Available", steps: [] },
              {
                id: "away",
                description: "Out of office",
                steps: [
                  {
                    id: "ask",
                    title: "Ask for cover",
                    kind: "human",
                    prompt: "Who covers?",
                    assignee: "employee.manager",
                    response: "approval",
                    timeout: "2 days",
                  },
                ],
              },
            ],
          },
          {
            id: "check",
            title: "Check",
            kind: "if",
            cases: [
              {
                when: { ref: "steps.ask.approved", op: "equals", value: true },
                steps: [{ id: "pause", title: "Pause", kind: "wait", duration: "3 days" }],
              },
            ],
          },
        ],
      }),
    ),
    expect(role("list", { name: "Branch 1" })).toExist(),
    expect(role("list", { name: "Branch 2" })).toExist(),
    expect(text("Until 7 days before employee.start_date")).toExist(),
    expect(role("list", { name: "Option away" })).toExist(),
    expect(role("button", { name: /Ask for cover$/ })).toExist(),
    expect(text("Assignee: employee.manager")).toExist(),
    expect(text("Times out after 2 days")).toExist(),
    expect(text("If ask.approved is true")).toExist(),
    expect(text("Pauses for 3 days")).toExist(),
    expect(role("list", { name: "Reads" })).toHaveText("employee.start_dateemployee.manager"),
  );
});

test("picking an employee and running the saved version links to the new run", () => {
  const completed = runOf({
    status: "completed",
    steps: {
      approve: { status: "done", record: { approved: true } },
      laptop: { status: "done" },
      notify: { status: "done", record: { simulated: true, channel: "D-sam", ts: "1" } },
    },
  });
  scene(
    { update, view },
    given(
      applied(loaded, [
        automationLoaded({
          maybeDraft: Option.some(onboarding),
          maybeSaved: Option.some(onboarding),
          runs: [summaryOf(completed)],
        }),
        Message.SucceededLoadSubjects({
          revision: 0,
          entityType: "employee",
          label: "Employee",
          subjects: [
            { id: "emp-1", title: "Dana Lee" },
            { id: "emp-2", title: "Ari Cho" },
          ],
        }),
      ]),
    ),
    expect(label("Employee")).toHaveValue(""),
    change(label("Employee"), "emp-2"),
    expect(label("Employee")).toHaveValue("emp-2"),
    click(role("button", { name: "Run saved version" })),
    Command.expectExact(StartRun({ ...requestArgs, maybeSubjectId: Option.some("emp-2") })),
    Command.resolve(StartRun, Message.SucceededStartRun({ revision: 0, runId: "run-1" })),
    Command.expectExact(NavigateInternal({ url: "/?automation=my-automation&run=run-1" })),
    Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
    expect(text("Run run-1 started.")).toExist(),
    expect(role("link", { name: /Ari Cho/ })).toHaveAttr(
      "href",
      "/?automation=my-automation&run=run-1",
    ),
  );
});

test("a run page shows each step's outcome without the planner, and links to the editor", () => {
  const completed = runOf({
    status: "completed",
    steps: {
      approve: { status: "done", record: { approved: true } },
      laptop: { status: "done" },
      notify: { status: "done", record: { simulated: true, channel: "D-sam", ts: "1" } },
    },
  });
  scene(
    { update, view },
    given(withOpenRun(completed)),
    expect(text("Completed")).toExist(),
    expect(text("Ari Cho")).toExist(),
    expect(role("button", { name: /Tell the manager.*Done/ })).toExist(),
    expect(label("Tell the manager result")).toContainText("ChannelD-sam"),
    expect(label("Tell the manager result")).not.toContainText("simulated"),
    expect(label("Approve the plan result")).toHaveText("ApprovedYes"),
    expect(text("Simulated: nothing was sent. This is what it would have sent.")).toExist(),
    expect(text("Runs the version saved when it started", { exact: false })).toExist(),
    expect(role("link", { name: "Edit automation" })).toHaveAttr(
      "href",
      "/?automation=my-automation",
    ),
    expect(label("Your message")).not.toExist(),
    expect(role("region", { name: "Conversation" })).not.toExist(),
    expect(role("button", { name: "Save draft" })).not.toExist(),
    expect(role("button", { name: "Run saved version" })).not.toExist(),
  );
});

test("an approval task shows who it's for and sends the answer", () => {
  const waiting = runOf({
    steps: { approve: { status: "waiting" } },
    tasks: [approvalTask],
  });
  const approved = runOf({
    status: "completed",
    steps: { approve: { status: "done", record: { approved: true } } },
    tasks: [{ ...approvalTask, status: "closed" }],
  });
  scene(
    { update, view },
    given(withOpenRun(waiting)),
    expect(role("list", { name: "Open tasks" })).toExist(),
    expect(text("Approve onboarding for Ari Cho?")).toExist(),
    expect(text("Assigned to Sam Park")).toExist(),
    expect(text("Notified via Slack")).toExist(),
    expect(role("button", { name: /Approve the plan.*Waiting/ })).toExist(),
    click(role("button", { name: "Approve" })),
    Command.expectExact(
      AnswerTask({ ...requestArgs, runId: "run-1", step: "approve", answer: { approved: true } }),
    ),
    Command.resolve(
      AnswerTask,
      Message.SucceededAnswerTask({ revision: 0, runId: "run-1", step: "approve" }),
    ),
    Command.resolve(LoadRun, runLoaded({ revision: 0, poll: 2, run: approved })),

    expect(role("list", { name: "Open tasks" })).not.toExist(),
    expect(text("Answer sent.")).toExist(),
  );
});

test("a form task is prefilled from its defaults and submits typed values", () => {
  const waiting = runOf({ steps: { laptop: { status: "waiting" } }, tasks: [laptopTask] });
  const answered = runOf({
    status: "completed",
    steps: { laptop: { status: "done" } },
    tasks: [{ ...laptopTask, status: "closed" }],
  });
  scene(
    { update, view },
    given(withOpenRun(waiting)),
    expect(label("Start date")).toHaveValue("2026-11-02"),
    expect(label("Start date")).toHaveAttr("type", "date"),
    expect(label("Budget")).toHaveValue(""),
    expect(role("checkbox", { name: "Works remotely" })).toHaveAttr("aria-checked", "false"),
    type(label("Budget"), "1800"),
    click(role("checkbox", { name: "Works remotely" })),
    expect(role("checkbox", { name: "Works remotely" })).toHaveAttr("aria-checked", "true"),
    submit(role("form", { name: "Order a laptop" })),
    Command.expectExact(
      AnswerTask({
        ...requestArgs,
        runId: "run-1",
        step: "laptop",
        answer: { values: { start_date: "2026-11-02", budget: 1800, remote: true } },
      }),
    ),
    Command.resolve(
      AnswerTask,
      Message.SucceededAnswerTask({ revision: 0, runId: "run-1", step: "laptop" }),
    ),
    Command.resolve(LoadRun, runLoaded({ revision: 0, poll: 2, run: answered })),

    expect(role("form", { name: "Order a laptop" })).not.toExist(),
  );
});

test("the sidebar's overview link marks the overview page", () => {
  scene(
    { update, view },
    given(init({ theme: "System", shortcutModifier: "Meta" }, studioUrl()).model),
    expect(role("link", { name: "Overview" })).toHaveAttr("href", "/"),
    expect(role("link", { name: "Overview" })).toHaveAttr("aria-current", "page"),
    expect(text("Runs and automations")).toExist(),
  );
});

test("a run opens in a panel beside the editor, which can expand to its page or close", () => {
  const waiting = runOf({ steps: { approve: { status: "waiting" } }, tasks: [approvalTask] });
  const editing = applied(loaded, [
    automationLoaded({ maybeDraft: Option.some(onboarding), runs: [summaryOf(waiting)] }),
    Message.ClickedLink({
      request: UrlRequest.Internal({ url: runUrl("run-1") }),
    }),
    runLoaded({ revision: 0, poll: 1, run: waiting }),
  ]);
  scene(
    { update, view },
    given(editing),
    expect(role("region", { name: "Conversation" })).toExist(),
    expect(role("region", { name: "Workflow" })).toExist(),
    expect(role("complementary", { name: "Run preview" })).toContainText("Manager onboarding"),
    expect(role("complementary", { name: "Run preview" })).toContainText(
      "Approve onboarding for Ari Cho?",
    ),
    expect(role("link", { name: /Ari Cho/ })).toHaveAttr("aria-current", "true"),
    click(role("button", { name: "Open the run's page" })),
    Command.expectExact(NavigateInternal({ url: "/?automation=my-automation&run=run-1" })),
    Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
    click(role("button", { name: "Close the run" })),
    expect(role("complementary", { name: "Run preview" })).not.toExist(),
    expect(role("region", { name: "Conversation" })).toExist(),
  );
});

test("a step's result reads as labelled fields, not JSON", () => {
  const workflow: Workflow = {
    name: "Kickoff",
    trigger: { kind: "manual" },
    steps: [
      { id: "joke", kind: "agent", title: "Write a joke", instruction: "Write one" },
      {
        id: "meet",
        kind: "action",
        title: "Book the kickoff",
        use: "calendar.createEvent",
        with: { title: "Kickoff", attendees: ["ari@example.com"], start: "2026-11-02" },
      },
    ],
  };
  const completed = runOf({
    status: "completed",
    workflow,
    steps: {
      joke: { status: "done", record: "Why did the email cross the road?" },
      meet: {
        status: "done",
        record: {
          simulated: true,
          eventId: "sim_123",
          attendees: ["ari@example.com", "sam@example.com"],
          start_date: "2026-11-02",
          repeat: null,
          is_remote: false,
          room: { floor: 3, name: "Lighthouse" },
        },
      },
    },
  });
  scene(
    { update, view },
    given(withOpenRun(completed)),
    expect(label("Write a joke result")).toHaveText("Why did the email cross the road?"),
    expect(label("Book the kickoff result")).toContainText("Event IDsim_123"),
    expect(label("Book the kickoff result")).toContainText(
      "Attendeesari@example.comsam@example.com",
    ),
    expect(label("Book the kickoff result")).toContainText("Start dateNov 2, 2026"),
    expect(label("Book the kickoff result")).toContainText("RepeatNone"),
    expect(label("Book the kickoff result")).toContainText("Is remoteNo"),
    expect(label("Book the kickoff result")).toContainText("RoomFloor3NameLighthouse"),
    expect(label("Book the kickoff result")).not.toContainText("{"),
    expect(label("Book the kickoff result")).not.toContainText('"'),
    expect(label("Book the kickoff result")).not.toContainText("start_date"),
  );
});

test("the sidebar's entity store link opens the entity store page", () => {
  scene(
    { update, view },
    given(
      applied(loaded, [
        Message.ChangedUrl({ url: { ...studioUrl(), pathname: "/entities" } }),
        Message.GotEntitiesMessage({ message: Entities.Message.SucceededLoadTypes({ types: [] }) }),
      ]),
    ),
    expect(role("link", { name: "Entity store" })).toHaveAttr("aria-current", "page"),
    expect(role("link", { name: "Entity store" })).toHaveAttr("href", "/entities"),
    expect(role("heading", { name: "Entity types" })).toExist(),
    expect(text("No entity types yet.")).toExist(),
  );
});
