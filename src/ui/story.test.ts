/** Checks root app transitions for chat, saving, run polling, task answers, and navigation.
 * Exercises request freshness and recovery without executing browser or server effects. */
import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import type { Workflow } from "../workflow.ts";
import {
  AnswerTask,
  ApplyTheme,
  CreateAutomation,
  LoadAutomation,
  LoadAutomations,
  LoadRun,
  LoadRuns,
  LoadRunSubjects,
  LoadSubjects,
  NavigateInternal,
  PollAutomation,
  PollRun,
  ResumeNow,
  SendMessage,
  SaveDraft,
  StartRun,
  StartSavedRun,
} from "./command.ts";
import { init } from "./main.ts";
import { Message } from "./message.ts";
import {
  blankNewAutomation,
  messageInputOf,
  type Model,
  modifyMessageInput,
  NewAutomation,
} from "./model.ts";
import { Overview } from "./page/index.ts";
import { update } from "./update/index.ts";
import {
  approvalTask,
  laptopTask,
  onboarding,
  runOf,
  settleIn,
  settleResumesAt,
  studioUrl,
  summaryOf,
} from "./fixtures.ts";

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
  update(
    init({ theme: "System", shortcutModifier: "Meta" }, studioUrl(search)).model,
    automationLoaded(),
  ).model;

const typed = (current: Model, text: string) => modifyMessageInput(current, () => text);

const runUrl = (runId: string) => studioUrl(`automation=my-automation&run=${runId}`);

const employeesLoaded = (revision: number) =>
  Message.SucceededLoadRunSubjects({
    revision,
    runId: "run-1",
    entityType: "employee",
    label: "Employee",
    subjects: [
      { id: "emp-1", title: "Dana Lee" },
      { id: "emp-2", title: "Ari Cho" },
    ],
  });

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

const runLoaded = (fields: {
  revision: number;
  poll: number;
  run: ReturnType<typeof runOf>;
  resumesAt?: Record<string, number>;
}) =>
  Message.SucceededLoadRun({ resumesAt: {}, ...fields, maybeSubjectTitle: Option.some("Ari Cho") });

/** The run page as a link opens it: at revision 0, with its first load in flight as poll 1. */
const openingRun = (runId: string) =>
  init({ theme: "System", shortcutModifier: "Meta" }, runUrl(runId)).model;

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
  resumesAt: {},
});

test("chat waits for the agent's reply, shows the draft, and saves that automation", () => {
  story(
    update,
    given(typed(loaded("automation=orders"), "Summarize orders")),
    message(Message.SubmittedMessage()),
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
      expect(messageInputOf(current)).toBe("");
      expect(current.maybePendingChat).toEqual(Option.some(working));
    }),
    Command.expectExact(PollAutomation({ automationId: "orders", revision: 0 })),
    Command.resolve(PollAutomation, automationLoaded({ maybePendingChat: Option.some(working) })),
    Command.expectExact(PollAutomation({ automationId: "orders", revision: 0 })),
    Command.resolve(
      PollAutomation,
      automationLoaded({
        maybeDraft: Option.some(workflow),
        conversation: [
          {
            id: 0,
            prompt: "Summarize orders",
            reply: "Review these steps.",
            asked: [],
          },
        ],
      }),
    ),
    Command.resolve(LoadAutomations, Message.SucceededLoadAutomations({ automations: [] })),
    model((current) => {
      expect(current.conversation).toEqual([
        {
          id: 0,
          prompt: "Summarize orders",
          reply: "Review these steps.",
          asked: [],
        },
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
    init({ theme: "System", shortcutModifier: "Meta" }, studioUrl("automation=orders")).model,
    automationLoaded({ maybePendingChat: Option.some(working) }),
  );
  expect(reopened.model.activity._tag).toBe("Working");
  expect(reopened.model.maybePendingChat).toEqual(Option.some(working));
  expect(reopened.commands?.map((command) => command.name)).toEqual(["PollAutomation"]);
});

test("a reply the agent couldn't write puts the prompt back in the composer", () => {
  const failed = { ...working, status: "failed", error: "Agent did not answer" } as const;
  const reopened = update(
    init({ theme: "System", shortcutModifier: "Meta" }, studioUrl("automation=orders")).model,
    automationLoaded({ maybePendingChat: Option.some(failed) }),
  );
  expect(messageInputOf(reopened.model)).toBe("Summarize orders");
  expect(reopened.model.activity).toEqual(
    expect.objectContaining({
      _tag: "Failed",
      error: "The agent couldn't finish its reply. Send your message again to retry.",
    }),
  );
  expect(reopened.commands ?? []).toEqual([]);
});

test("an unsent or failed message stays with its automation", () => {
  const failed = { ...working, status: "failed", error: "Agent did not answer" } as const;
  const restored = update(
    init({ theme: "System", shortcutModifier: "Meta" }, studioUrl("automation=orders")).model,
    automationLoaded({ maybePendingChat: Option.some(failed) }),
  ).model;
  const switched = update(
    restored,
    Message.ChangedUrl({ url: studioUrl("automation=other") }),
  ).model;
  expect(messageInputOf(switched)).toBe("");
  const typedOther = update(switched, Message.UpdatedMessageInput({ value: "Other idea" })).model;
  const back = update(
    typedOther,
    Message.ChangedUrl({ url: studioUrl("automation=orders") }),
  ).model;
  expect(messageInputOf(back)).toBe("Summarize orders");
  const again = update(back, Message.ChangedUrl({ url: studioUrl("automation=other") })).model;
  expect(messageInputOf(again)).toBe("Other idea");
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
  const current = typed(loaded(), "Next revision");
  const received = update(
    current,
    Message.SucceededSendMessage({
      revision: 0,
      sentMessage: "First prompt",
      pendingChat: working,
    }),
  );
  expect(messageInputOf(received.model)).toBe("Next revision");
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
          subjectChoices: { _tag: "NotNeeded" },
          maybeSubjectId: Option.none(),
          start: { _tag: "Idle" },
        },
      });
      expect(current.maybeDraft).toEqual(Option.none());
    }),
    Command.resolve(LoadRun, runLoaded({ revision: 1, poll: 1, run: completed })),
    Command.expectExact(LoadRunSubjects({ revision: 1, runId: "run-1", entityType: "employee" })),
    Command.resolve(LoadRunSubjects, employeesLoaded(1)),
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
    Command.expectExact(
      PollRun({ ...requestArgs, poll: 1, runId: "run-1", delayMillis: 1500 }),
      LoadRunSubjects({ revision: 0, runId: "run-1", entityType: "employee" }),
    ),
    Command.resolve(LoadRunSubjects, employeesLoaded(0)),
    Command.resolve(PollRun, runLoaded({ revision: 0, poll: 1, run: waiting })),
    Command.expectExact(PollRun({ ...requestArgs, poll: 1, runId: "run-1", delayMillis: 5000 })),
    Command.resolve(PollRun, runLoaded({ revision: 0, poll: 1, run: completed })),
    Command.expectNone(),
  );
});

test("resuming a wait in local development asks the server, then polls quickly until the step moves on", () => {
  const settling = runOf({ workflow: settleIn, steps: { settle: { status: "waiting" } } });
  const resumed = runOf({
    workflow: settleIn,
    steps: { settle: { status: "done", record: null }, check_in: { status: "waiting" } },
  });
  const opened = modifyFields(
    update(
      openingRun("run-1"),
      runLoaded({ revision: 0, poll: 1, run: settling, resumesAt: { settle: settleResumesAt } }),
    ).model,
    { isLocalDevelopment: () => true },
  );
  story(
    update,
    given(opened),
    message(Message.ClickedResumeNow({ step: "settle" })),
    Command.expectExact(ResumeNow({ ...requestArgs, runId: "run-1", step: "settle" })),
    model((current) => expect(noticeOf(current)).toEqual({ _tag: "Resuming" })),
    Command.resolve(
      ResumeNow,
      Message.SucceededResumeNow({ revision: 0, runId: "run-1", step: "settle" }),
    ),
    model((current) => expect(noticeOf(current)).toEqual({ _tag: "Resumed", step: "settle" })),
    Command.expectExact(LoadRun({ ...requestArgs, poll: 2, runId: "run-1" })),
    // The replay hasn't reached the step yet, so the run polls at the running pace.
    Command.resolve(LoadRun, runLoaded({ revision: 0, poll: 2, run: settling })),
    Command.expectExact(PollRun({ ...requestArgs, poll: 2, runId: "run-1", delayMillis: 1500 })),
    Command.resolve(PollRun, runLoaded({ revision: 0, poll: 2, run: resumed })),
    // Now the run waits on the manager, so it polls at the waiting pace.
    Command.expectExact(PollRun({ ...requestArgs, poll: 2, runId: "run-1", delayMillis: 5000 })),
    Command.resolve(
      PollRun,
      runLoaded({ revision: 0, poll: 2, run: { ...resumed, status: "completed" } }),
    ),
    Command.expectNone(),
  );
});

test("outside local development, or on a step not waiting on a clock, resuming does nothing but say so", () => {
  const settling = runOf({ workflow: settleIn, steps: { settle: { status: "waiting" } } });
  const deployed = update(
    openingRun("run-1"),
    runLoaded({ revision: 0, poll: 1, run: settling, resumesAt: { settle: settleResumesAt } }),
  ).model;
  const refused = update(deployed, Message.ClickedResumeNow({ step: "settle" }));
  expect(refused.commands).toBeUndefined();
  expect(noticeOf(refused.model)).toEqual({
    _tag: "Failed",
    error: "That step isn't waiting on a clock",
  });
  const local = modifyFields(deployed, { isLocalDevelopment: () => true });
  const notWaiting = update(local, Message.ClickedResumeNow({ step: "check_in" }));
  expect(notWaiting.commands).toBeUndefined();
  const failed = update(
    update(local, Message.ClickedResumeNow({ step: "settle" })).model,
    Message.FailedResumeNow({ revision: 0, runId: "run-1", error: "Not found" }),
  );
  expect(noticeOf(failed.model)).toEqual({ _tag: "Failed", error: "Not found" });
});

test("the studio learns whether it runs in local development, and assumes not until told", () => {
  const opened = openingRun("run-1");
  expect(opened.isLocalDevelopment).toBe(false);
  expect(
    update(opened, Message.SucceededLoadDevelopment({ isLocal: true })).model.isLocalDevelopment,
  ).toBe(true);
  expect(update(opened, Message.FailedLoadDevelopment({ error: "Offline" })).model).toBe(opened);
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
      LoadRunSubjects({ revision: 0, runId: "run-1", entityType: "employee" }),
    ),
    Command.resolve(LoadRunSubjects, employeesLoaded(0)),
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
    init({ theme: "System", shortcutModifier: "Meta" }, studioUrl()).model,
    clickedLink("automation=orders&run=run-1"),
  );
  expect(clicked.model.page._tag).toBe("Overview");
  expect(clicked.commands?.map((command) => command.args)).toEqual([
    { automationId: "orders", revision: 0, poll: 1, runId: "run-1" },
  ]);
  const opened = update(clicked.model, runLoaded({ revision: 0, poll: 1, run: waiting }));
  expect(opened.commands?.map((command) => command.name)).toEqual(["PollRun", "LoadRunSubjects"]);
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
  const sending = update(typed(loaded(), "Hello"), Message.SubmittedMessage());
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
  const invalid = typed(modifyFields(loaded(), { automationId: () => "orders/bad" }), "Hello");
  expect(update(invalid, Message.SubmittedMessage()).commands).toBeUndefined();
  expect(update(invalid, Message.SubmittedMessage()).model.activity._tag).toBe("Failed");
  expect(update(loaded(), Message.ClickedSave()).model.activity).toEqual({
    _tag: "Failed",
    error: "Create a draft first",
  });
});

test("messages up to 10,000 characters are sent and longer ones are rejected", () => {
  const longest = "a".repeat(10_000);
  const withInput = (messageInput: string) => typed(loaded(), messageInput);

  story(
    update,
    given(withInput(longest)),
    message(Message.SubmittedMessage()),
    Command.expectExact(SendMessage({ ...requestArgs, message: longest })),
    Command.resolve(SendMessage, Message.FailedRequest({ revision: 0, error: "Offline" })),
  );

  const rejected = update(withInput(`${longest}a`), Message.SubmittedMessage());
  expect(rejected.model.activity).toEqual(
    expect.objectContaining({ _tag: "Failed", error: "Message must be 1–10,000 characters" }),
  );
  expect(rejected.commands).toBeUndefined();
});

test("the URL picks which automation opens and loads it with the automation list and roles", () => {
  const opened = init(
    { theme: "System", shortcutModifier: "Meta" },
    studioUrl("automation=orders"),
  );
  expect(opened.model.automationId).toBe("orders");
  expect(opened.model.activity._tag).toBe("Working");
  expect(opened.commands?.map((command) => command.name)).toEqual([
    "LoadAutomation",
    "LoadAutomations",
    "LoadRoles",
    "LoadConnections",
    "LoadDevelopment",
    "RestoreAssistant",
  ]);

  const overview = init({ theme: "System", shortcutModifier: "Meta" }, studioUrl());
  expect(overview.model.page._tag).toBe("Overview");
  expect(overview.commands?.map((command) => command.name)).toEqual([
    "LoadOverview",
    "LoadAutomations",
    "LoadRoles",
    "LoadConnections",
    "LoadDevelopment",
    "RestoreAssistant",
  ]);
  expect(
    init({ theme: "System", shortcutModifier: "Meta" }, studioUrl("automation=bad%2Fid")).model
      .activity._tag,
  ).toBe("Failed");
});

test("each new automation starts from a blank description and is created once", () => {
  const opened = update(
    modifyFields(loaded(), {
      newAutomation: () =>
        NewAutomation.Editing({ description: "Earlier", maybeError: Option.some("Earlier error") }),
    }),
    Message.ClickedNewAutomation(),
  );
  expect(opened.model.newAutomationDialog.isOpen).toBe(true);
  expect(opened.model.newAutomation).toEqual(blankNewAutomation);
  expect(opened.commands?.map((command) => command.name)).toContain("ShowDialog");

  const tooLong = "x".repeat(10_001);
  story(
    update,
    given(modifyFields(loaded(), { newAutomation: () => blankNewAutomation })),
    message(Message.UpdatedNewAutomationDescription({ value: tooLong })),
    message(Message.SubmittedNewAutomation()),
    model((current) =>
      expect(current.newAutomation).toEqual(
        NewAutomation.Editing({
          description: tooLong,
          maybeError: Option.some("Keep the description to 10,000 characters"),
        }),
      ),
    ),
    message(Message.UpdatedNewAutomationDescription({ value: "Summarize orders" })),
    message(Message.SubmittedNewAutomation()),
    Command.expectExact(CreateAutomation({ description: "Summarize orders" })),
    model((current) => {
      expect(current.newAutomation).toEqual(
        NewAutomation.Creating({ description: "Summarize orders" }),
      );
      expect(update(current, Message.SubmittedNewAutomation()).commands).toBeUndefined();
      const edited = update(current, Message.UpdatedNewAutomationDescription({ value: "Edit" }));
      expect(edited.model).toBe(current);
    }),
    Command.resolve(CreateAutomation, Message.FailedCreateAutomation({ error: "Offline" })),
    model((current) =>
      expect(current.newAutomation).toEqual(
        NewAutomation.Editing({
          description: "Summarize orders",
          maybeError: Option.some("Offline"),
        }),
      ),
    ),
  );
});

test("a description that couldn't be sent waits in the new automation's composer", () => {
  const creating = modifyFields(loaded(), {
    newAutomation: () => NewAutomation.Creating({ description: "Summarize orders" }),
  });
  const automation = { id: "summarize-orders", name: "Summarize orders" };
  const unsent = update(
    creating,
    Message.SucceededCreateAutomation({ automation, wasDescriptionSent: false }),
  );
  expect(unsent.model.messageInputs["summarize-orders"]).toBe("Summarize orders");
  expect(unsent.model.newAutomation).toEqual(blankNewAutomation);
  expect(unsent.commands?.map((command) => command.name)).toContain("NavigateInternal");

  const sent = update(
    creating,
    Message.SucceededCreateAutomation({ automation, wasDescriptionSent: true }),
  );
  expect(sent.model.messageInputs["summarize-orders"]).toBeUndefined();
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
        conversation: [
          {
            id: 0,
            prompt: "Summarize orders",
            reply: "Review these steps.",
            asked: [],
          },
        ],
        runs: [summaryOf(runOf({ status: "completed" }))],
      }),
    ),
    model((current) => {
      expect(current.maybeDraft).toEqual(Option.some(workflow));
      expect(current.runs).toHaveLength(1);
      expect(current.conversation).toEqual([
        {
          id: 0,
          prompt: "Summarize orders",
          reply: "Review these steps.",
          asked: [],
        },
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
  expect(init({ theme: "Dark", shortcutModifier: "Meta" }, studioUrl()).model.theme).toBe("Dark");
});

test("the overview drops the studio's late replies, and a run link from it opens that run", () => {
  const sending = update(typed(loaded(), "Hello"), Message.SubmittedMessage()).model;
  story(
    update,
    given(sending),
    message(Message.ChangedUrl({ url: studioUrl() })),
    Command.expectExact(Overview.LoadOverview({ session: 1, poll: 0 })),
    model((current) => {
      expect(current.page._tag).toBe("Overview");
      const late = update(current, Message.FailedRequest({ revision: 0, error: "Old error" }));
      expect(late.model).toBe(current);
    }),
    Command.resolve(
      Overview.LoadOverview,
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
    Command.resolve(LoadRunSubjects, employeesLoaded(2)),
  );
});

const footerOf = (current: Model) =>
  Option.map(openRunOf(current), ({ subjectChoices, maybeSubjectId, start }) => ({
    subjectChoices: subjectChoices._tag,
    maybeSubjectId,
    start,
  }));

test("a run page's footer runs the saved version again for the run's subject by default", () => {
  const completed = runOf({ status: "completed" });
  story(
    update,
    given(openingRun("run-1")),
    message(runLoaded({ revision: 0, poll: 1, run: completed })),
    Command.expectExact(LoadRunSubjects({ revision: 0, runId: "run-1", entityType: "employee" })),
    model((current) =>
      expect(footerOf(current)).toEqual(
        Option.some({
          subjectChoices: "Loading",
          maybeSubjectId: Option.some("emp-2"),
          start: { _tag: "Idle" },
        }),
      ),
    ),
    Command.resolve(LoadRunSubjects, employeesLoaded(0)),
    message(Message.SelectedRunSubject({ subjectId: "emp-1" })),
    message(Message.ClickedRunSavedVersion()),
    Command.expectExact(
      StartSavedRun({
        ...requestArgs,
        fromRunId: "run-1",
        maybeSubjectId: Option.some("emp-1"),
      }),
    ),
    model((current) =>
      expect(Option.map(footerOf(current), (footer) => footer.start)).toEqual(
        Option.some({ _tag: "Starting" }),
      ),
    ),
    Command.resolve(
      StartSavedRun,
      Message.SucceededStartSavedRun({ revision: 0, fromRunId: "run-1", runId: "run-2" }),
    ),
    Command.expectExact(NavigateInternal({ url: "/?automation=my-automation&run=run-2" })),
    Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
  );
});

test("the footer asks for a subject first, and says why a start failed", () => {
  const completed = runOf({ status: "completed", subject: null });
  story(
    update,
    given(update(openingRun("run-1"), runLoaded({ revision: 0, poll: 1, run: completed })).model),
    message(Message.ClickedRunSavedVersion()),
    Command.expectNone(),
    model((current) =>
      expect(Option.map(footerOf(current), (footer) => footer.start)).toEqual(
        Option.some({ _tag: "Failed", error: "Choose an employee to run it for" }),
      ),
    ),
    message(Message.SelectedRunSubject({ subjectId: "emp-2" })),
    message(Message.ClickedRunSavedVersion()),
    Command.resolve(
      StartSavedRun,
      Message.FailedStartSavedRun({ revision: 0, fromRunId: "run-1", error: "Save it first" }),
    ),
    model((current) =>
      expect(Option.map(footerOf(current), (footer) => footer.start)).toEqual(
        Option.some({ _tag: "Failed", error: "Save it first" }),
      ),
    ),
  );
});

test("the panel's footer opens the new run in the panel", () => {
  const completed = runOf({ status: "completed" });
  const started = runOf({ id: "run-2", status: "completed" });
  const editing = update(loaded(), automationLoaded({ maybeDraft: Option.some(onboarding) })).model;
  const panel = [
    clickedLink("automation=my-automation&run=run-1"),
    runLoaded({ revision: 0, poll: 1, run: completed }),
    employeesLoaded(0),
  ].reduce((current, next) => update(current, next).model, editing);
  story(
    update,
    given(panel),
    message(Message.ClickedRunSavedVersion()),
    Command.expectExact(
      StartSavedRun({ ...requestArgs, fromRunId: "run-1", maybeSubjectId: Option.some("emp-2") }),
    ),
    Command.resolve(
      StartSavedRun,
      Message.SucceededStartSavedRun({ revision: 0, fromRunId: "run-1", runId: "run-2" }),
    ),
    Command.expectExact(LoadRun({ ...requestArgs, poll: 2, runId: "run-2" })),
    model((current) => {
      expect(current.page._tag).toBe("Studio");
      expect(Option.map(current.maybeRunPanel, (openRun) => openRun.runId)).toEqual(
        Option.some("run-2"),
      );
    }),
    Command.resolve(LoadRun, runLoaded({ revision: 0, poll: 2, run: started })),
    Command.resolveAll(
      [LoadRuns, Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(started)] })],
      [
        LoadRunSubjects,
        Message.SucceededLoadRunSubjects({ ...employeesLoaded(0), runId: "run-2" }),
      ],
    ),
  );
});
