import { test } from "bun:test";
import * as Option from "effect/Option";
import { modifyFields } from "foldkit/struct";
import {
  Command,
  change,
  click,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
} from "foldkit/scene";
import {
  AnswerTask,
  LoadAutomations,
  LoadRun,
  LoadRuns,
  Message,
  PollAutomation,
  SendMessage,
  StartRun,
  init,
  update,
  view,
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
    runs: [],
    ...fields,
  });

const loaded = update(init({ theme: "System" }, studioUrl()).model, automationLoaded()).model;

const withDraft = (draft: Workflow) =>
  modifyFields(loaded, { maybeDraft: () => Option.some(draft) });

const requestArgs = { automationId: "my-automation", revision: 0 };

const applied = (start: Model, messages: ReadonlyArray<Message>) =>
  messages.reduce((current, next) => update(current, next).model, start);

const withOpenRun = (run: ReturnType<typeof runOf>) =>
  applied(loaded, [
    automationLoaded({ maybeDraft: Option.some(onboarding), runs: [summaryOf(run)] }),
    Message.ClickedRun({ runId: run.id }),
    Message.SucceededLoadRun({ revision: 0, poll: 1, run }),
  ]);

test("the accessible message input drives chat and safely renders the workflow", () => {
  scene(
    { update, view },
    given(loaded),
    expect(label("Automation ID")).toHaveValue("my-automation"),
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
        conversation: [{ id: 0, prompt: "Summarize orders", reply: "Ready to review." }],
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

test("picking an employee and running the saved version opens the new run", () => {
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
    expect(text("Loading the run…")).toExist(),
    Command.resolve(
      LoadRuns,
      Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(completed)] }),
    ),
    Command.resolve(LoadRun, Message.SucceededLoadRun({ revision: 0, poll: 1, run: completed })),
    expect(text("Completed")).toExist(),
    expect(text("Ari Cho")).toExist(),
    expect(role("button", { name: /Tell the manager.*Done/ })).toExist(),
    expect(label("Tell the manager record")).toContainText('"channel": "D-sam"'),
    expect(text("Simulated: nothing was sent. It would have recorded")).toExist(),
    click(role("button", { name: "Back to draft" })),
    expect(role("list", { name: "Recent runs" })).toContainText("Ari Cho"),
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
    Command.resolve(
      LoadRuns,
      Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(approved)] }),
    ),
    Command.resolve(LoadRun, Message.SucceededLoadRun({ revision: 0, poll: 2, run: approved })),
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
    Command.resolve(
      LoadRuns,
      Message.SucceededLoadRuns({ revision: 0, runs: [summaryOf(answered)] }),
    ),
    Command.resolve(LoadRun, Message.SucceededLoadRun({ revision: 0, poll: 2, run: answered })),
    expect(role("form", { name: "Order a laptop" })).not.toExist(),
  );
});
