/** Builds task DMs, picks who gets them, and sends each once over an in-memory automation host. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { answerHubLayer } from "../ai/ask-question/answer-hub.ts";
import { Classifier } from "../ai/classifier.ts";
import { approvalButtons } from "../channels/slack-approvals.ts";
import { taskActionOf } from "../channels/slack-interactivity.ts";
import { PiAgent } from "../ai/pi.ts";
import {
  SlackSendError,
  SlackSender,
  type SlackMessage,
  type SlackRecipient,
  type SlackSenderService,
  type SlackSent,
} from "../connections/slack.ts";
import type { EntityType } from "../entities/model.ts";
import { layerMemory } from "../entities/memory.ts";
import type { Template } from "../entities/templates.ts";
import { Events } from "../events/service.ts";
import { ExecutionId } from "../workflow/execution.ts";
import type { Workflow } from "../workflow/model.ts";
import { RunId, type HumanTask } from "../workflow/run.ts";
import { makeAutomation } from "./application.ts";
import { AutomationHost } from "./host.ts";
import { AutomationIndex } from "./index.ts";
import type { StoredRun } from "./run-store.ts";
import { ConfiguredStudioOrigin } from "./studio-link.ts";
import { makeTaskNotifier, taskMessage, taskRecipients } from "./task-notifications.ts";

const runId = RunId.make("run-7");
const link = { automationId: "first-week", origin: "https://studio.example.com" };

const approval: HumanTask = {
  step: "welcome",
  token: "token-welcome",
  title: "Send the right welcome email",
  prompt: "Send an email with the details below?",
  assignee: null,
  response: "approval",
  defaults: {},
  action: {
    use: "email.send",
    template: "Engineering welcome email",
    inputs: {
      to: { $title: "Ada Lovelace", email: "ada@example.com" },
      subject: "Welcome to engineering, Ada Lovelace",
      body: `Hi Ada Lovelace,\n\nWelcome to the engineering team! You start on 2026-11-02, and Grace Hopper will be your manager. ${"Bring a laptop. ".repeat(20)}`,
    },
  },
  approvers: {
    role: "people_ops",
    label: "People Ops",
    members: [
      { name: "Sam Rivera", email: "sam@example.com" },
      { name: "Pat Lee", email: "pat@example.com" },
      { name: "Sam again", email: "SAM@example.com" },
    ],
  },
  status: "open",
};

const checkIn: HumanTask = {
  step: "check-in",
  token: "token-check-in",
  title: "Ask the manager how it's going",
  prompt: "How is Ada settling in?\nPick a buddy if you haven't yet.",
  assignee: { $title: "Grace Hopper", email: "grace@example.com" },
  response: {
    fields: [
      { name: "buddy", label: "Buddy", type: "text" },
      { name: "help", label: "Help needed", type: "text" },
    ],
  },
  defaults: {},
  notify: "slack",
  status: "open",
};

describe("taskMessage", () => {
  test("an approval names the automation, the role and the recipient, and shows the exact email", () => {
    const message = taskMessage({
      automation: "Launch a great first week",
      runId,
      task: approval,
      subject: "Ada Lovelace",
      link,
    });
    expect(message.text).toBe(
      "Launch a great first week needs People Ops to approve an email before it goes to Ada Lovelace.",
    );
    const [headline, details, actions, ...rest] = message.blocks ?? [];
    expect(rest).toEqual([]);
    expect(headline).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Launch a great first week* needs People Ops to approve an email before it goes to Ada Lovelace.",
      },
    });
    const quote = details?.type === "section" ? details.text.text : "";
    const lines = quote.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      ">Template: Engineering welcome email",
      ">Subject: Welcome to engineering, Ada Lovelace",
    ]);
    // The body is one line, cut short; the recipient isn't repeated.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toStartWith(
      ">Body: Hi Ada Lovelace, Welcome to the engineering team! You start on 2026-11-02, and Grace Hopper",
    );
    expect(lines[2]).toEndWith("…");
    expect(lines[2]?.length).toBeLessThan(220);
    expect(actions).toEqual({
      type: "actions",
      block_id: "task-actions",
      elements: [
        {
          type: "button",
          action_id: "task.open",
          text: { type: "plain_text", text: "Open in Studio" },
          url: "https://studio.example.com/?automation=first-week&run=run-7",
        },
      ],
    });
  });

  test("extra buttons follow the link in the same actions block", () => {
    const approve = {
      type: "button" as const,
      action_id: "task.approve",
      text: { type: "plain_text" as const, text: "Approve" },
      value: "{}",
      style: "primary" as const,
    };
    const blocks = taskMessage({
      automation: "Onboarding",
      runId,
      task: approval,
      subject: null,
      link,
      actions: [approve],
    }).blocks;
    const last = blocks?.at(-1);
    expect(last?.type === "actions" ? last.elements.map((button) => button.action_id) : []).toEqual(
      ["task.open", "task.approve"],
    );
  });

  test("a human step says what it needs and for whom, quotes its prompt, and lists its fields", () => {
    const message = taskMessage({
      automation: "Launch a great first week",
      runId,
      task: checkIn,
      subject: "Ada Lovelace",
      link,
    });
    expect(message.text).toBe(
      "Launch a great first week needs your answers for Ada Lovelace: Ask the manager how it's going",
    );
    expect(message.blocks?.slice(1, 3)).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ">How is Ada settling in?\n>Pick a buddy if you haven't yet.",
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "You'll fill in: Buddy, Help needed" }],
      },
    ]);
  });

  test("escapes Slack markup from the run, and says where to answer without a studio link", () => {
    const message = taskMessage({
      automation: "R&D <alerts>",
      runId,
      task: { ...checkIn, response: "approval", prompt: "Ship <!channel> & go?" },
      subject: null,
      link: undefined,
    });
    const texts = (message.blocks ?? []).map((block) =>
      block.type === "section"
        ? block.text.text
        : block.type === "context"
          ? block.elements[0]?.text
          : "actions",
    );
    expect(texts).toEqual([
      "*R&amp;D &lt;alerts&gt;* needs your approval: *Ask the manager how it's going*",
      ">Ship &lt;!channel&gt; &amp; go?",
      "Answer it in the studio, on this run of R&amp;D &lt;alerts&gt;.",
    ]);
  });
});

describe("taskRecipients", () => {
  test("an approval goes to each member of its role once", () => {
    expect(taskRecipients(approval)).toEqual([
      { name: "Sam Rivera", email: "sam@example.com" },
      { name: "Pat Lee", email: "pat@example.com" },
    ]);
  });

  test("a human step goes to its assignee only when it notifies on Slack", () => {
    expect(taskRecipients(checkIn)).toEqual([{ name: "Grace Hopper", email: "grace@example.com" }]);
    expect(taskRecipients({ ...checkIn, assignee: "grace@example.com" })).toEqual([
      { name: "grace@example.com", email: "grace@example.com" },
    ]);
    expect(taskRecipients({ ...checkIn, notify: "email" })).toEqual([]);
    const { notify: _, ...silent } = checkIn;
    expect(taskRecipients(silent)).toEqual([]);
    expect(taskRecipients({ ...checkIn, assignee: { $title: "Grace Hopper" } })).toEqual([]);
  });
});

/** A Slack sender that records what it posts. Posting to `fail` fails; `posted` seeds history. */
const fakeSlack = (options: { fail?: string; posted?: Map<string, SlackSent> } = {}) => {
  const posts: Array<{ to: SlackRecipient; message: SlackMessage }> = [];
  const history = options.posted ?? new Map<string, SlackSent>();
  let count = 0;
  const sender: SlackSenderService = {
    send: (to, text) => sender.post(to, { text }),
    post: (to, message) =>
      Effect.suspend(() => {
        if (to.kind === "person" && to.email === options.fail) {
          return Effect.fail(
            new SlackSendError({
              message:
                "Slack users.lookupByEmail: no one in the Slack workspace has that email address",
              code: "users_not_found",
            }),
          );
        }
        posts.push({ to, message });
        count += 1;
        const sent = { channel: `D-${count}`, ts: `1700000000.00000${count}` };
        if (to.kind === "person" && message.key !== undefined) {
          history.set(`${to.email}|${message.key}`, sent);
        }
        return Effect.succeed(sent);
      }),
    findPosted: (email, key) => Effect.sync(() => history.get(`${email}|${key}`)),
  };
  return { sender, posts, history };
};

/** One stored run with the task, through the run store's update shape. */
const runWith = (task: HumanTask) => {
  let run: StoredRun = {
    id: runId,
    workflow: { name: "Launch a great first week", trigger: { kind: "manual" }, steps: [] },
    subject: null,
    status: "waiting",
    steps: {},
    tasks: [task],
    startedAt: 0,
  };
  return {
    readRun: () => Effect.sync(() => run),
    updateRun: (_: RunId, change: (current: StoredRun) => StoredRun) =>
      Effect.sync(() => void (run = change(run))),
    current: () => run,
  };
};

const notifierFor = (store: ReturnType<typeof runWith>, sender: SlackSenderService | null) =>
  makeTaskNotifier({
    slack: sender,
    readRun: store.readRun,
    updateRun: store.updateRun,
    link: Effect.succeed(link),
    subjectTitle: () => Effect.succeed("Ada Lovelace"),
  });

describe("makeTaskNotifier", () => {
  test("sends each recipient one DM and records it, however often the task is opened", async () => {
    const store = runWith(approval);
    const slack = fakeSlack();
    const { notify } = notifierFor(store, slack.sender);
    await Effect.runPromise(Effect.all([notify(runId, "welcome"), notify(runId, "welcome")]));
    expect(slack.posts.map((post) => post.to)).toEqual([
      { kind: "person", email: "sam@example.com" },
      { kind: "person", email: "pat@example.com" },
    ]);
    expect(slack.posts[0]?.message.key).toBe("first-week/run-7/welcome");
    expect(store.current().tasks[0]?.notifications).toEqual([
      {
        via: "slack",
        to: "sam@example.com",
        name: "Sam Rivera",
        status: "sent",
        channel: "D-1",
        ts: "1700000000.000001",
      },
      {
        via: "slack",
        to: "pat@example.com",
        name: "Pat Lee",
        status: "sent",
        channel: "D-2",
        ts: "1700000000.000002",
      },
    ]);
  });

  test("an approval's DM has Approve and Reject after the link, and clicks name its task", async () => {
    const slack = fakeSlack();
    await Effect.runPromise(notifierFor(runWith(approval), slack.sender).notify(runId, "welcome"));
    await Effect.runPromise(notifierFor(runWith(checkIn), slack.sender).notify(runId, "check-in"));
    const buttons = (message: SlackMessage | undefined) =>
      message?.blocks?.flatMap((block) =>
        block.type === "actions" ? block.elements.map((element) => element.action_id) : [],
      );
    expect(buttons(slack.posts[0]?.message)).toEqual(["task.open", "task.approve", "task.reject"]);
    // Only a role's approval gets buttons; a check-in is answered in the studio.
    expect(buttons(slack.posts.at(-1)?.message)).toEqual(["task.open"]);
    // Slack hands the clicked button back with the message as JSON.
    const blocks = JSON.parse(JSON.stringify(slack.posts[0]?.message.blocks)) as unknown;
    const clicked = taskActionOf(
      new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          user: { id: "U-sam" },
          container: { channel_id: "D-1", message_ts: "1700000000.000001" },
          response_url: "https://hooks.slack.com/actions/1",
          message: { blocks },
          actions: [approvalButtons({ automation: "first-week", run: runId, step: "welcome" })[1]],
        }),
      }).toString(),
    );
    expect(Option.map(clicked, (action) => [action.task, action.approved])).toEqual(
      Option.some([{ automation: "first-week", run: "run-7", step: "welcome" }, false]),
    );
  });

  test("a delivery left sending finds the message it already posted instead of posting again", async () => {
    const sending = {
      via: "slack" as const,
      to: "grace@example.com",
      name: "Grace Hopper",
      status: "sending" as const,
    };
    const posted = new Map([
      ["grace@example.com|first-week/run-7/check-in", { channel: "D-9", ts: "1.9" }],
    ]);
    const found = runWith({ ...checkIn, notifications: [sending] });
    const already = fakeSlack({ posted });
    await Effect.runPromise(notifierFor(found, already.sender).notify(runId, "check-in"));
    expect(already.posts).toEqual([]);
    expect(found.current().tasks[0]?.notifications).toEqual([
      { ...sending, status: "sent", channel: "D-9", ts: "1.9" },
    ]);

    // Not in the DM: the earlier delivery never reached Slack, so this one posts.
    const missing = runWith({ ...checkIn, notifications: [sending] });
    const fresh = fakeSlack();
    await Effect.runPromise(notifierFor(missing, fresh.sender).notify(runId, "check-in"));
    expect(fresh.posts).toHaveLength(1);
    expect(missing.current().tasks[0]?.notifications?.[0]?.status).toBe("sent");
  });

  test("a recipient Slack refuses is recorded as failed, and the others still get it", async () => {
    const store = runWith(approval);
    const slack = fakeSlack({ fail: "sam@example.com" });
    const { notify } = notifierFor(store, slack.sender);
    await Effect.runPromise(notify(runId, "welcome"));
    await Effect.runPromise(notify(runId, "welcome"));
    expect(slack.posts.map((post) => post.to)).toEqual([
      { kind: "person", email: "pat@example.com" },
    ]);
    expect(
      store.current().tasks[0]?.notifications?.map(({ to, status, error }) => ({
        to,
        status,
        error,
      })),
    ).toEqual([
      {
        to: "sam@example.com",
        status: "failed",
        error: "Slack users.lookupByEmail: no one in the Slack workspace has that email address",
      },
      { to: "pat@example.com", status: "sent", error: undefined },
    ]);
  });

  test("sends nothing without Slack, for a closed task, or for email notify", async () => {
    const unconfigured = runWith(checkIn);
    await Effect.runPromise(notifierFor(unconfigured, null).notify(runId, "check-in"));
    expect(unconfigured.current().tasks[0]).toEqual(checkIn);

    const slack = fakeSlack();
    for (const task of [
      { ...checkIn, status: "closed" as const },
      { ...checkIn, notify: "email" as const },
    ]) {
      const store = runWith(task);
      await Effect.runPromise(notifierFor(store, slack.sender).notify(runId, "check-in"));
      expect(store.current().tasks[0]).toEqual(task);
    }
    expect(slack.posts).toEqual([]);
  });
});

describe("task notifications in a run", () => {
  const employee: EntityType = {
    name: "employee",
    label: "Employee",
    title: "name",
    fields: [
      { name: "name", label: "Name", type: "text" },
      { name: "email", label: "Email", type: "text" },
      { name: "manager", label: "Manager", type: "ref", to: "employee" },
    ],
  };
  const welcome: Template = {
    name: "engineering_welcome",
    label: "Engineering welcome email",
    description: "Welcomes new engineers.",
    slots: [{ name: "hire", label: "New hire", type: "ref", to: "employee" }],
    content: {
      subject: "Welcome to engineering, {{hire.name}}",
      body: "Hi {{hire.name}}, welcome to the engineering team! {{hire.manager.name}} will be your manager.",
    },
  };
  const saved: Workflow = {
    name: "Launch a great first week",
    trigger: { kind: "manual", subject: "employee" },
    permissions: { "email.send": { ask: "people_ops" } },
    steps: [
      {
        id: "welcome",
        title: "Send the right welcome email",
        kind: "action",
        use: "email.send",
        with: { to: "{{employee}}" },
        template: { use: "engineering_welcome", with: { hire: "{{employee}}" } },
      },
      {
        id: "check-in",
        title: "Ask the manager how it's going",
        kind: "human",
        prompt: "How is {{employee.name}} settling in?",
        assignee: "employee.manager",
        notify: "slack",
        response: { fields: [{ name: "buddy", label: "Buddy", type: "text" }] },
      },
    ],
  };

  /** A transactional in-memory host: writes and scheduled advances roll back together. */
  const harness = (slack: SlackSenderService | null, configuredOrigin: string | null = null) => {
    let data = new Map<string, unknown>();
    const advances: Array<string> = [];
    const lock = Semaphore.makeUnsafe(1);
    const host = AutomationHost.of({
      storage: {
        get: (key) => Effect.sync(() => structuredClone(data.get(key))),
        put: (key, value) => Effect.sync(() => void data.set(key, structuredClone(value))),
        delete: (key) => Effect.sync(() => data.delete(key)),
        list: ({ prefix }) =>
          Effect.sync(() => new Map([...data].filter(([key]) => key.startsWith(prefix)))),
        transaction: (effect) =>
          lock.withPermit(
            Effect.gen(function* () {
              const before = new Map(data);
              const count = advances.length;
              const result = yield* Effect.exit(effect);
              if (Exit.isFailure(result)) {
                data = before;
                advances.length = count;
              }
              return yield* result;
            }),
          ),
      },
      jobs: {
        planReply: () => Effect.die("No chat in these tests"),
        advance: (executionId) => Effect.sync(() => void advances.push(executionId)),
        clock: () => Effect.die("No clocks in these tests"),
        tick: () => Effect.void,
        cancelTick: Effect.void,
      },
      erase: Effect.die("No removal in these tests"),
    });
    const unused = () => Effect.die("Not used by runs without agent steps");
    const layer = Layer.mergeAll(
      answerHubLayer,
      Layer.succeed(Events, { publish: unused }),
      Layer.succeed(Classifier, Classifier.of({ classify: unused })),
      Layer.succeed(
        PiAgent,
        PiAgent.of({
          createConversation: unused(),
          instruct: unused,
          abort: Effect.void,
          liveAnswer: Effect.succeed(undefined),
          transcript: unused,
          prompt: unused,
        }),
      ),
      Layer.succeed(
        AutomationIndex,
        AutomationIndex.of({
          list: Effect.succeed([]),
          create: () => Effect.succeed(true),
          record: () => Effect.void,
          recordIfMissing: () => Effect.void,
          remove: () => Effect.void,
        }),
      ),
      layerMemory({
        types: [employee],
        entities: [
          {
            type: "employee",
            id: "ada",
            data: { name: "Ada Lovelace", email: "ada@example.com", manager: "grace" },
            updatedAt: 0,
          },
          {
            type: "employee",
            id: "grace",
            data: { name: "Grace Hopper", email: "grace@example.com" },
            updatedAt: 0,
          },
          {
            type: "employee",
            id: "sam",
            data: { name: "Sam Rivera", email: "sam@example.com" },
            updatedAt: 0,
          },
        ],
        templates: [welcome],
        roles: [
          { name: "people_ops", label: "People Ops", members: [{ type: "employee", id: "sam" }] },
        ],
      }),
      Layer.succeed(AutomationHost, host),
      Layer.succeed(SlackSender, slack),
      Layer.succeed(ConfiguredStudioOrigin, configuredOrigin),
    );
    return { host, layer, advances, data: () => data };
  };

  const execution = (advances: ReadonlyArray<string>) =>
    Schema.decodeUnknownEffect(ExecutionId)(advances[0]);

  test("an approval and a check-in each DM their people once, linked to the run", async () => {
    const slack = fakeSlack();
    const h = harness(slack.sender);
    const run = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("draft", saved);
        const app = yield* makeAutomation();
        yield* app.save("first-week", "https://studio.example.com");
        const started = yield* app.start("ada");
        const executionId = yield* execution(h.advances);
        yield* app.callbacks.advance({ executionId });

        // A crash before the request Activity's exit was journaled makes the replay open the
        // task again; it must not send it again.
        const journaled = [...h.data().keys()].filter((key) =>
          key.includes(":activity:welcome/approval-request:"),
        );
        expect(journaled).toHaveLength(1);
        for (const key of journaled) yield* h.host.storage.delete(key);
        yield* app.callbacks.advance({ executionId });
        expect(slack.posts).toHaveLength(1);

        yield* app.respond(started.id, "welcome", { approved: true }, "sam@example.com");
        yield* app.callbacks.advance({ executionId });
        return yield* app.run(started.id);
      }).pipe(Effect.provide(h.layer)),
    );
    expect(run?.status).toBe("waiting");
    expect(slack.posts.map(({ to, message }) => [to, message.text])).toEqual([
      [
        { kind: "person", email: "sam@example.com" },
        "Launch a great first week needs People Ops to approve an email before it goes to Ada Lovelace.",
      ],
      [
        { kind: "person", email: "grace@example.com" },
        "Launch a great first week needs your answers for Ada Lovelace: Ask the manager how it's going",
      ],
    ]);
    const details = slack.posts[0]?.message.blocks?.[1];
    expect(details?.type === "section" ? details.text.text : "").toBe(
      [
        ">Template: Engineering welcome email",
        ">Subject: Welcome to engineering, Ada Lovelace",
        ">Body: Hi Ada Lovelace, welcome to the engineering team! Grace Hopper will be your manager.",
      ].join("\n"),
    );
    const button = slack.posts[1]?.message.blocks?.at(-1);
    expect(button?.type === "actions" ? button.elements[0]?.url : undefined).toBe(
      `https://studio.example.com/?automation=first-week&run=${run?.id}`,
    );
    expect(
      run?.tasks.map((task) => task.notifications?.map(({ to, status }) => [to, status])),
    ).toEqual([[["sam@example.com", "sent"]], [["grace@example.com", "sent"]]]);
    expect(run?.tasks[0]?.action?.template).toBe("Engineering welcome email");
  });

  test("a configured studio URL wins over the one the save recorded", async () => {
    const slack = fakeSlack();
    const h = harness(slack.sender, "https://automations.example.org");
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("draft", saved);
        const app = yield* makeAutomation();
        yield* app.save("first-week", "http://localhost:5173");
        // A save that doesn't know the studio keeps the automation's ID and earlier origin.
        yield* app.save("first-week");
        expect(yield* h.host.storage.get("studio")).toEqual({
          automationId: "first-week",
          origin: "http://localhost:5173",
        });
        yield* app.start("ada");
        yield* app.callbacks.advance({ executionId: yield* execution(h.advances) });
      }).pipe(Effect.provide(h.layer)),
    );
    const button = slack.posts[0]?.message.blocks?.at(-1);
    expect(button?.type === "actions" ? button.elements[0]?.url : undefined).toStartWith(
      "https://automations.example.org/?automation=first-week&run=",
    );
  });

  test("without Slack, tasks only record what they would notify, as before", async () => {
    const h = harness(null);
    const run = await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.host.storage.put("draft", saved);
        const app = yield* makeAutomation();
        yield* app.save("first-week", "https://studio.example.com");
        const started = yield* app.start("ada");
        const executionId = yield* execution(h.advances);
        yield* app.callbacks.advance({ executionId });
        yield* app.respond(started.id, "welcome", { approved: true }, undefined);
        yield* app.callbacks.advance({ executionId });
        return yield* app.run(started.id);
      }).pipe(Effect.provide(h.layer)),
    );
    expect(run?.tasks.map((task) => [task.step, task.notify, task.notifications])).toEqual([
      ["welcome", undefined, undefined],
      ["check-in", "slack", undefined],
    ]);
  });
});
