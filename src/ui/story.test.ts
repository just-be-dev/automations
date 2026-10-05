import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import {
  AnswerTask,
  ApplyTheme,
  LoadAutomation,
  LoadAutomations,
  LoadRun,
  LoadRuns,
  LoadSubjects,
  Message,
  NavigateInternal,
  PollAutomation,
  PollRun,
  SendMessage,
  SaveDraft,
  StartRun,
  init,
  update,
  type Model,
  type Workflow,
} from "./main.ts";
import { approvalTask, laptopTask, onboarding, runOf, studioUrl, summaryOf } from "./fixtures.ts";

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

const loaded = (search?: string) =>
  update(init({ theme: "System" }, studioUrl(search)).model, automationLoaded()).model;

const workflow: Workflow = {
  name: "Order summary",
  trigger: { kind: "manual" },
  steps: [
    {
      id: "summarize",
      kind: "agent",
      title: "Summarize order",
      instruction: "Summarize the order",
    },
    {
      id: "notify",
      kind: "action",
      title: "Notify fulfillment",
      use: "http.post",
      with: { url: "https://example.com/orders" },
    },
  ],
};

const working = { id: "chat-1", prompt: "Summarize orders", status: "working" } as const;

const requestArgs = { automationId: "my-automation", revision: 0 };

const withOpenRun = (current: Model, run: ReturnType<typeof runOf>) => {
  const clicked = update(current, Message.ClickedRun({ runId: run.id })).model;
  return update(clicked, Message.SucceededLoadRun({ revision: 0, poll: clicked.runPoll, run }))
    .model;
};

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
    Command.resolve(PollAutomation, automationLoaded({ maybePendingChat: Option.some(working) })),
    Command.expectExact(PollAutomation({ automationId: "orders", revision: 0 })),
    Command.resolve(
      PollAutomation,
      automationLoaded({
        maybeDraft: Option.some(workflow),
        conversation: [{ id: 0, prompt: "Summarize orders", reply: "Review these steps." }],
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
    Command.resolve(SaveDraft, Message.SucceededSaveDraft({ revision: 0, saved: workflow })),
    model((current) => {
      expect(current.maybeSaved).toEqual(Option.some(workflow));
      expect(current.subjectChoices._tag).toBe("NotNeeded");
    }),
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
    automationLoaded({ maybePendingChat: Option.some(working) }),
  );
  expect(reopened.model.activity._tag).toBe("Working");
  expect(reopened.model.maybePendingChat).toEqual(Option.some(working));
  expect(reopened.commands?.map((command) => command.name)).toEqual(["PollAutomation"]);
});

test("a reply the agent couldn't write puts the prompt back in the composer", () => {
  const failed = { ...working, status: "failed", error: "Agent did not answer" } as const;
  const reopened = update(
    init({ theme: "System" }, studioUrl("automation=orders")).model,
    automationLoaded({ maybePendingChat: Option.some(failed) }),
  );
  expect(reopened.model.messageInput).toBe("Summarize orders");
  expect(reopened.model.activity).toEqual(
    expect.objectContaining({
      _tag: "Failed",
      error: "The agent couldn't finish its reply. Send your message again to retry.",
    }),
  );
  expect(reopened.commands ?? []).toEqual([]);
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

test("a saved workflow about an employee loads employees, and a run starts for the one picked", () => {
  const completed = runOf({ status: "completed" });
  story(
    update,
    given(loaded()),
    message(
      automationLoaded({
        maybeDraft: Option.some(onboarding),
        maybeSaved: Option.some(onboarding),
      }),
    ),
    Command.expectExact(LoadSubjects({ revision: 0, entityType: "employee" })),
    Command.resolve(
      LoadSubjects,
      Message.SucceededLoadSubjects({
        revision: 0,
        entityType: "employee",
        label: "Employee",
        subjects: [
          { id: "emp-1", title: "Dana Lee" },
          { id: "emp-2", title: "Ari Cho" },
        ],
      }),
    ),
    message(Message.ClickedStart()),
    Command.expectNone(),
    model((current) =>
      expect(current.activity).toEqual({
        _tag: "Failed",
        error: "Choose an employee to run it for",
      }),
    ),
    message(Message.SelectedSubject({ subjectId: "emp-2" })),
    message(Message.ClickedStart()),
    Command.expectExact(StartRun({ ...requestArgs, maybeSubjectId: Option.some("emp-2") })),
    Command.resolve(StartRun, Message.SucceededStartRun({ revision: 0, runId: "run-1" })),
    Command.expectExact(
      LoadRun({ ...requestArgs, poll: 1, runId: "run-1" }),
      LoadRuns(requestArgs),
    ),
    model((current) => expect(current.runDetail).toEqual({ _tag: "Loading", runId: "run-1" })),
    Command.resolve(
      LoadRuns,
      Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(completed)] }),
    ),
    Command.resolve(LoadRun, Message.SucceededLoadRun({ revision: 0, poll: 1, run: completed })),
    Command.expectNone(),
    model((current) => expect(current.runDetail).toEqual({ _tag: "Loaded", run: completed })),
  );
});

test("a manual run without a subject sends no subject, and nothing runs before a save", () => {
  expect(update(loaded(), Message.ClickedStart()).model.activity).toEqual({
    _tag: "Failed",
    error: "Save the draft before running it",
  });
  story(
    update,
    given(update(loaded(), automationLoaded({ maybeSaved: Option.some(workflow) })).model),
    message(Message.ClickedStart()),
    Command.expectExact(StartRun({ ...requestArgs, maybeSubjectId: Option.none() })),
    Command.resolve(StartRun, Message.FailedRequest({ revision: 0, error: "Offline" })),
  );
});

test("the open run polls every 1.5 s while running, every 5 s while waiting, then stops", () => {
  const running = runOf({ status: "running" });
  const waiting = runOf({ status: "waiting" });
  const completed = runOf({ status: "completed" });
  story(
    update,
    given(loaded()),
    message(Message.ClickedRun({ runId: "run-1" })),
    Command.resolve(LoadRun, Message.SucceededLoadRun({ revision: 0, poll: 1, run: running })),
    Command.expectExact(
      PollRun({ ...requestArgs, poll: 1, runId: "run-1", delayMillis: 1500 }),
      LoadRuns(requestArgs),
    ),
    Command.resolve(
      LoadRuns,
      Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(running)] }),
    ),
    Command.resolve(PollRun, Message.SucceededLoadRun({ revision: 0, poll: 1, run: waiting })),
    Command.expectExact(
      PollRun({ ...requestArgs, poll: 1, runId: "run-1", delayMillis: 5000 }),
      LoadRuns(requestArgs),
    ),
    Command.resolve(
      LoadRuns,
      Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(waiting)] }),
    ),
    Command.resolve(PollRun, Message.SucceededLoadRun({ revision: 0, poll: 1, run: completed })),
    Command.expectExact(LoadRuns(requestArgs)),
    Command.resolve(
      LoadRuns,
      Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(completed)] }),
    ),
    Command.expectNone(),
  );
});

test("closing a run drops its late poll, and failing to load a run reports the error", () => {
  const opened = withOpenRun(loaded(), runOf({ status: "running" }));
  const closed = update(opened, Message.ClickedCloseRun()).model;
  expect(closed.runDetail._tag).toBe("Closed");
  const late = update(
    closed,
    Message.SucceededLoadRun({ revision: 0, poll: opened.runPoll, run: runOf({}) }),
  );
  expect(late.model).toBe(closed);
  expect(late.commands).toBeUndefined();

  const loading = update(loaded(), Message.ClickedRun({ runId: "run-9" })).model;
  const failed = update(
    loading,
    Message.FailedLoadRun({ revision: 0, poll: loading.runPoll, error: "Run not found" }),
  ).model;
  expect(failed.runDetail._tag).toBe("Closed");
  expect(failed.activity).toEqual({ _tag: "Failed", error: "Run not found" });
});

test("approving a task sends the answer, then reloads the run and the run list", () => {
  const waiting = runOf({ steps: { approve: { status: "waiting" } }, tasks: [approvalTask] });
  const approved = runOf({
    status: "completed",
    steps: { approve: { status: "done", record: { approved: true } } },
    tasks: [{ ...approvalTask, status: "closed" }],
  });
  const opened = update(
    withOpenRun(loaded(), waiting),
    Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(waiting)] }),
  ).model;
  story(
    update,
    given(opened),
    message(Message.ClickedApproveTask({ step: "approve" })),
    Command.expectExact(
      AnswerTask({ ...requestArgs, runId: "run-1", step: "approve", answer: { approved: true } }),
    ),
    model((current) => expect(current.activity._tag).toBe("Working")),
    Command.resolve(
      AnswerTask,
      Message.SucceededAnswerTask({ revision: 0, runId: "run-1", step: "approve" }),
    ),
    model((current) => {
      const stalePoll = update(
        current,
        Message.SucceededLoadRun({ revision: 0, poll: opened.runPoll, run: waiting }),
      );
      expect(stalePoll.model).toBe(current);
      expect(stalePoll.commands).toBeUndefined();
    }),
    Command.expectExact(
      LoadRun({ ...requestArgs, poll: opened.runPoll + 1, runId: "run-1" }),
      LoadRuns(requestArgs),
    ),
    Command.resolve(
      LoadRuns,
      Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(approved)] }),
    ),
    Command.resolve(
      LoadRun,
      Message.SucceededLoadRun({ revision: 0, poll: opened.runPoll + 1, run: approved }),
    ),
    Command.expectNone(),
    model((current) => {
      expect(current.runDetail).toEqual({ _tag: "Loaded", run: approved });
      expect(current.activity).toEqual({ _tag: "Ready", notice: "Answer sent." });
    }),
  );
});

test("rejecting sends approved: false, and approval buttons can't answer a form", () => {
  const opened = withOpenRun(loaded(), runOf({ tasks: [approvalTask, laptopTask] }));
  const rejected = update(opened, Message.ClickedRejectTask({ step: "approve" }));
  expect(rejected.commands?.map((command) => command.args)).toEqual([
    { ...requestArgs, runId: "run-1", step: "approve", answer: { approved: false } },
  ]);
  expect(update(opened, Message.ClickedApproveTask({ step: "laptop" })).model.activity).toEqual({
    _tag: "Failed",
    error: "Fill in the form to answer this task",
  });
});

test("a form task submits its prefilled defaults with the person's edits as typed values", () => {
  const waiting = runOf({ steps: { laptop: { status: "waiting" } }, tasks: [laptopTask] });
  const opened = update(
    withOpenRun(loaded(), waiting),
    Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(waiting)] }),
  ).model;

  const incomplete = update(opened, Message.SubmittedTaskForm({ step: "laptop" }));
  expect(incomplete.commands).toBeUndefined();
  expect(incomplete.model.activity).toEqual({ _tag: "Failed", error: "Fill in Budget" });

  story(
    update,
    given(incomplete.model),
    message(Message.UpdatedTaskField({ step: "laptop", field: "budget", value: "1800" })),
    message(Message.UpdatedTaskField({ step: "laptop", field: "remote", value: "true" })),
    message(Message.SubmittedTaskForm({ step: "laptop" })),
    Command.expectExact(
      AnswerTask({
        ...requestArgs,
        runId: "run-1",
        step: "laptop",
        answer: { values: { start_date: "2026-11-02", budget: 1800, remote: true } },
      }),
    ),
    Command.resolve(AnswerTask, Message.FailedRequest({ revision: 0, error: "Fill in Budget" })),
    model((current) => {
      expect(current.activity).toEqual({ _tag: "Failed", error: "Fill in Budget" });
      expect(current.taskEdits).toHaveLength(2);
    }),
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
    Command.expectExact(SendMessage({ ...requestArgs, message: longest })),
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

test("a URL change loads that automation, restores its conversation, and clears the open run", () => {
  story(
    update,
    given(withOpenRun(loaded(), runOf({ status: "completed" }))),
    message(Message.ChangedUrl({ url: studioUrl("automation=orders") })),
    Command.expectExact(LoadAutomation({ automationId: "orders", revision: 1 })),
    model((current) => {
      expect(current.automationId).toBe("orders");
      expect(current.activity._tag).toBe("Working");
      expect(current.runDetail._tag).toBe("Closed");
    }),
    Command.resolve(
      LoadAutomation,
      automationLoaded({
        revision: 1,
        maybeDraft: Option.some(workflow),
        maybeSaved: Option.some(workflow),
        conversation: [{ id: 0, prompt: "Summarize orders", reply: "Review these steps." }],
        runs: [summaryOf(runOf({ status: "completed" }))],
      }),
    ),
    model((current) => {
      expect(current.maybeDraft).toEqual(Option.some(workflow));
      expect(current.runs).toHaveLength(1);
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
