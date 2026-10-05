import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { UrlRequest } from "foldkit/navigation";
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
import * as Overview from "./overview.ts";
import { LoadOverview } from "./overview.ts";
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

const loaded = (search = "automation=my-automation") =>
  update(init({ theme: "System" }, studioUrl(search)).model, automationLoaded()).model;

const runUrl = (runId: string) => studioUrl(`automation=my-automation&run=${runId}`);

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

const runLoaded = (fields: { revision: number; poll: number; run: ReturnType<typeof runOf> }) =>
  Message.SucceededLoadRun({ ...fields, maybeSubjectTitle: Option.some("Ari Cho") });

/** The run page as a link opens it: at revision 0, with its first load in flight as poll 1. */
const openingRun = (runId: string) => init({ theme: "System" }, runUrl(runId)).model;

const withOpenRun = (run: ReturnType<typeof runOf>) =>
  update(openingRun(run.id), runLoaded({ revision: 0, poll: 1, run })).model;

const openRunOf = (current: Model) =>
  current.page._tag === "Run" ? Option.some(current.page.openRun) : current.maybeRunPanel;

const runDetailOf = (current: Model) =>
  Option.getOrNull(Option.map(openRunOf(current), (openRun) => openRun.detail));

const noticeOf = (current: Model) =>
  Option.getOrNull(Option.map(openRunOf(current), (openRun) => openRun.notice));

const taskEditsOf = (current: Model) =>
  Option.match(openRunOf(current), { onNone: () => [], onSome: (openRun) => openRun.taskEdits });

const loadedRun = (run: ReturnType<typeof runOf>) => ({
  _tag: "Loaded" as const,
  run,
  maybeSubjectTitle: Option.some("Ari Cho"),
});

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
    Command.expectExact(NavigateInternal({ url: "/?automation=my-automation&run=run-1" })),
    Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
    message(Message.ChangedUrl({ url: runUrl("run-1") })),
    Command.expectExact(
      LoadRun({ automationId: "my-automation", revision: 1, poll: 1, runId: "run-1" }),
    ),
    model((current) => {
      expect(current.page).toEqual({
        _tag: "Run",
        openRun: {
          automationId: "my-automation",
          runId: "run-1",
          detail: { _tag: "Loading" },
          taskEdits: [],
          notice: { _tag: "Idle" },
        },
      });
      expect(current.maybeDraft).toEqual(Option.none());
    }),
    Command.resolve(LoadRun, runLoaded({ revision: 1, poll: 1, run: completed })),
    Command.expectNone(),
    model((current) => expect(runDetailOf(current)).toEqual(loadedRun(completed))),
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
    given(openingRun("run-1")),
    message(runLoaded({ revision: 0, poll: 1, run: running })),
    Command.expectExact(PollRun({ ...requestArgs, poll: 1, runId: "run-1", delayMillis: 1500 })),
    Command.resolve(PollRun, runLoaded({ revision: 0, poll: 1, run: waiting })),
    Command.expectExact(PollRun({ ...requestArgs, poll: 1, runId: "run-1", delayMillis: 5000 })),
    Command.resolve(PollRun, runLoaded({ revision: 0, poll: 1, run: completed })),
    Command.expectNone(),
  );
});

const clickedLink = (search: string) =>
  Message.ClickedLink({ request: UrlRequest.Internal({ url: studioUrl(search) }) });

test("a run link in the studio opens the run beside the draft, which follows its progress", () => {
  const running = runOf({ status: "running" });
  const completed = runOf({ status: "completed" });
  const editing = update(loaded(), automationLoaded({ maybeDraft: Option.some(onboarding) })).model;
  story(
    update,
    given(editing),
    message(clickedLink("automation=my-automation&run=run-1")),
    Command.expectExact(LoadRun({ ...requestArgs, poll: 1, runId: "run-1" })),
    model((current) => {
      expect(current.page._tag).toBe("Studio");
      expect(current.maybeDraft).toEqual(Option.some(onboarding));
      expect(runDetailOf(current)).toEqual({ _tag: "Loading" });
    }),
    Command.resolve(LoadRun, runLoaded({ revision: 0, poll: 1, run: running })),
    Command.expectExact(
      PollRun({ ...requestArgs, poll: 1, runId: "run-1", delayMillis: 1500 }),
      LoadRuns(requestArgs),
    ),
    Command.resolve(
      LoadRuns,
      Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(running)] }),
    ),
    Command.resolve(PollRun, runLoaded({ revision: 0, poll: 1, run: completed })),
    Command.expectExact(LoadRuns(requestArgs)),
    Command.resolve(
      LoadRuns,
      Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(completed)] }),
    ),
    message(Message.ClickedExpandRunPanel()),
    Command.expectExact(NavigateInternal({ url: "/?automation=my-automation&run=run-1" })),
    Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
    message(Message.ClickedCloseRunPanel()),
    model((current) => {
      expect(current.maybeRunPanel).toEqual(Option.none());
      const late = update(current, runLoaded({ revision: 0, poll: 1, run: running }));
      expect(late.model).toBe(current);
      expect(late.commands).toBeUndefined();
    }),
  );
});

test("a run link on the overview opens that automation's run beside it", () => {
  const waiting = runOf({ steps: { approve: { status: "waiting" } }, tasks: [approvalTask] });
  const clicked = update(
    init({ theme: "System" }, studioUrl()).model,
    clickedLink("automation=orders&run=run-1"),
  );
  expect(clicked.model.page._tag).toBe("Overview");
  expect(clicked.commands?.map((command) => command.args)).toEqual([
    { automationId: "orders", revision: 0, poll: 1, runId: "run-1" },
  ]);
  const opened = update(clicked.model, runLoaded({ revision: 0, poll: 1, run: waiting }));
  expect(opened.commands?.map((command) => command.name)).toEqual(["PollRun"]);
  story(
    update,
    given(opened.model),
    message(Message.ClickedApproveTask({ step: "approve" })),
    Command.expectExact(
      AnswerTask({
        automationId: "orders",
        revision: 0,
        runId: "run-1",
        step: "approve",
        answer: { approved: true },
      }),
    ),
    Command.resolve(
      AnswerTask,
      Message.SucceededAnswerTask({ revision: 0, runId: "run-1", step: "approve" }),
    ),
    Command.expectExact(LoadRun({ automationId: "orders", revision: 0, poll: 2, runId: "run-1" })),
    Command.resolve(
      LoadRun,
      runLoaded({ revision: 0, poll: 2, run: runOf({ status: "completed" }) }),
    ),
  );
  const editLink = update(opened.model, clickedLink("automation=orders"));
  expect(editLink.commands?.map((command) => command.name)).toEqual(["NavigateInternal"]);
});

test("leaving a run for the editor drops its late poll, and a run that won't load says so", () => {
  const opened = withOpenRun(runOf({ status: "running" }));
  const editing = update(
    opened,
    Message.ChangedUrl({ url: studioUrl("automation=my-automation") }),
  );
  expect(editing.model.page._tag).toBe("Studio");
  expect(editing.commands?.map((command) => command.name)).toEqual(["LoadAutomation"]);
  const late = update(
    editing.model,
    runLoaded({ revision: 0, poll: opened.runPoll, run: runOf({}) }),
  );
  expect(late.model).toBe(editing.model);
  expect(late.commands).toBeUndefined();

  const failed = update(
    openingRun("run-9"),
    Message.FailedLoadRun({ revision: 0, poll: 1, error: "Run not found" }),
  ).model;
  expect(runDetailOf(failed)).toEqual({ _tag: "Unavailable", error: "Run not found" });

  const pollFailed = update(
    opened,
    Message.FailedLoadRun({ revision: 0, poll: 1, error: "Offline" }),
  ).model;
  expect(runDetailOf(pollFailed)?._tag).toBe("Loaded");
  expect(noticeOf(pollFailed)).toEqual({ _tag: "Failed", error: "Offline" });
});

test("approving a task sends the answer, then reloads the run", () => {
  const waiting = runOf({ steps: { approve: { status: "waiting" } }, tasks: [approvalTask] });
  const approved = runOf({
    status: "completed",
    steps: { approve: { status: "done", record: { approved: true } } },
    tasks: [{ ...approvalTask, status: "closed" }],
  });
  const opened = update(
    withOpenRun(waiting),
    Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(waiting)] }),
  ).model;
  story(
    update,
    given(opened),
    message(Message.ClickedApproveTask({ step: "approve" })),
    Command.expectExact(
      AnswerTask({ ...requestArgs, runId: "run-1", step: "approve", answer: { approved: true } }),
    ),
    model((current) => expect(noticeOf(current)).toEqual({ _tag: "Sending" })),
    Command.resolve(
      AnswerTask,
      Message.SucceededAnswerTask({ revision: 0, runId: "run-1", step: "approve" }),
    ),
    model((current) => {
      const stalePoll = update(
        current,
        runLoaded({ revision: 0, poll: opened.runPoll, run: waiting }),
      );
      expect(stalePoll.model).toBe(current);
      expect(stalePoll.commands).toBeUndefined();
    }),
    Command.expectExact(LoadRun({ ...requestArgs, poll: opened.runPoll + 1, runId: "run-1" })),
    Command.resolve(LoadRun, runLoaded({ revision: 0, poll: opened.runPoll + 1, run: approved })),
    Command.expectNone(),
    model((current) => {
      expect(runDetailOf(current)).toEqual(loadedRun(approved));
      expect(noticeOf(current)).toEqual({ _tag: "Sent" });
    }),
  );
});

test("rejecting sends approved: false, and approval buttons can't answer a form", () => {
  const opened = withOpenRun(runOf({ tasks: [approvalTask, laptopTask] }));
  const rejected = update(opened, Message.ClickedRejectTask({ step: "approve" }));
  expect(rejected.commands?.map((command) => command.args)).toEqual([
    { ...requestArgs, runId: "run-1", step: "approve", answer: { approved: false } },
  ]);
  expect(noticeOf(update(opened, Message.ClickedApproveTask({ step: "laptop" })).model)).toEqual({
    _tag: "Failed",
    error: "Fill in the form to answer this task",
  });
});

test("a form task submits its prefilled defaults with the person's edits as typed values", () => {
  const waiting = runOf({ steps: { laptop: { status: "waiting" } }, tasks: [laptopTask] });
  const opened = update(
    withOpenRun(waiting),
    Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(waiting)] }),
  ).model;

  const incomplete = update(opened, Message.SubmittedTaskForm({ step: "laptop" }));
  expect(incomplete.commands).toBeUndefined();
  expect(noticeOf(incomplete.model)).toEqual({ _tag: "Failed", error: "Fill in Budget" });

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
    Command.resolve(
      AnswerTask,
      Message.FailedAnswerTask({ revision: 0, runId: "run-1", error: "Fill in Budget" }),
    ),
    model((current) => {
      expect(noticeOf(current)).toEqual({ _tag: "Failed", error: "Fill in Budget" });
      expect(taskEditsOf(current)).toHaveLength(2);
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

  const overview = init({ theme: "System" }, studioUrl());
  expect(overview.model.page._tag).toBe("Overview");
  expect(overview.commands?.map((command) => command.name)).toEqual([
    "LoadOverview",
    "LoadAutomations",
  ]);
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

test("a URL change loads that automation, restores its conversation, and leaves the run", () => {
  story(
    update,
    given(withOpenRun(runOf({ status: "completed" }))),
    message(Message.ChangedUrl({ url: studioUrl("automation=orders") })),
    Command.expectExact(LoadAutomation({ automationId: "orders", revision: 1 })),
    model((current) => {
      expect(current.automationId).toBe("orders");
      expect(current.activity._tag).toBe("Working");
      expect(current.page._tag).toBe("Studio");
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

test("the overview drops the studio's late replies, and a run link from it opens that run", () => {
  const sending = update(
    modifyFields(loaded(), { messageInput: () => "Hello" }),
    Message.ClickedSend(),
  ).model;
  story(
    update,
    given(sending),
    message(Message.ChangedUrl({ url: studioUrl() })),
    Command.expectExact(LoadOverview({ session: 1, poll: 0 })),
    model((current) => {
      expect(current.page._tag).toBe("Overview");
      expect(current.automationIdInput).toBe("");
      const late = update(current, Message.FailedRequest({ revision: 0, error: "Old error" }));
      expect(late.model).toBe(current);
    }),
    Command.resolve(
      LoadOverview,
      Overview.Message.SucceededLoadOverview({ session: 1, poll: 0, automations: [] }),
    ),
    model((current) =>
      expect(current.page).toEqual(
        expect.objectContaining({
          overview: expect.objectContaining({ listing: { _tag: "Ready", automations: [] } }),
        }),
      ),
    ),
    message(Message.ChangedUrl({ url: studioUrl("automation=orders&run=run-1") })),
    Command.expectExact(LoadRun({ automationId: "orders", revision: 2, poll: 1, runId: "run-1" })),
    model((current) => {
      expect(current.automationId).toBe("orders");
      expect(runDetailOf(current)).toEqual({ _tag: "Loading" });
    }),
    Command.resolve(
      LoadRun,
      runLoaded({ revision: 2, poll: 1, run: runOf({ status: "completed" }) }),
    ),
  );
});
