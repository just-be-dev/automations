import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import type { HumanTask, Run, RunStep, Step } from "../../workflow.ts";
import { permissionTask, runOf } from "../fixtures.ts";
import { recipientName, shownLaneIndexes, stepProgress } from "./step-summary.ts";

process.env.TZ = "UTC";

const action = (use: string, title: string, inputs: Record<string, string> = {}): Step => ({
  id: "act",
  kind: "action",
  title,
  use,
  with: inputs,
});

const runWith = (step: Step, runStep: RunStep | undefined, overrides: Partial<Run> = {}): Run =>
  runOf({
    workflow: { name: "Onboarding", trigger: { kind: "manual" }, steps: [step] },
    status: "waiting",
    steps: runStep === undefined ? {} : { [step.id]: runStep },
    ...overrides,
  });

const summaryOf = (
  step: Step,
  runStep: RunStep | undefined,
  overrides: Partial<Run> = {},
  resumesAt: Record<string, number> = {},
) => {
  const progress = stepProgress(step, runWith(step, runStep, overrides), resumesAt);
  return { mark: progress.mark, summary: Option.getOrUndefined(progress.maybeSummary) };
};

const done = (record: RunStep["record"]): RunStep =>
  record === undefined ? { status: "done" } : { status: "done", record };

describe("finished actions say what they did", () => {
  test("finding times counts the open times", () => {
    const step = action("calendar.findTimes", "Find time for a manager welcome");
    const times = ["2026-11-03T10:00:00Z", "2026-11-03T14:00:00Z", "2026-11-04T10:00:00Z"];
    expect(summaryOf(step, done({ simulated: true, times: [...times, times[0] ?? ""] }))).toEqual({
      mark: "done",
      summary: "4 open times",
    });
    expect(summaryOf(step, done({ times: [times[0] ?? ""] })).summary).toBe("1 open time");
    expect(summaryOf(step, done({ times: [] })).summary).toBe("No open times");
  });

  test("an email names who it went to by first name", () => {
    const step = action("email.send", "Give the manager a heads-up");
    expect(summaryOf(step, done({ simulated: true, to: "grace@example.com" })).summary).toBe(
      "Sent to Grace",
    );
    expect(summaryOf(step, done({ to: "Grace Hopper <ghopper@example.com>" })).summary).toBe(
      "Sent to Grace",
    );
    expect(summaryOf(step, done({ messageId: "m-1" })).summary).toBe("Sent");
  });

  test("a Slack message posts to a channel or reaches a person", () => {
    const channel = action("slack.sendMessage", "Welcome them in #eng-team", { to: "#eng-team" });
    expect(summaryOf(channel, done({ channel: "#eng-team", ts: "1" })).summary).toBe("Posted");
    const untitled = action("slack.sendMessage", "Welcome them", { to: "#eng-team" });
    expect(summaryOf(untitled, done({ channel: "#eng-team", ts: "1" })).summary).toBe(
      "Posted in #eng-team",
    );
    expect(summaryOf(untitled, done({ channel: "C0123", ts: "1" })).summary).toBe(
      "Posted in #eng-team",
    );
    const direct = action("slack.sendMessage", "Tell the manager", { to: "{{employee.manager}}" });
    expect(summaryOf(direct, done({ channel: "@grace@example.com", ts: "1" })).summary).toBe(
      "Sent to Grace",
    );
    expect(summaryOf(direct, done({ channel: "D0123", ts: "1" })).summary).toBe("Sent");
  });

  test("a calendar event says when it was booked", () => {
    const step = action("calendar.createEvent", "Book their first conversation");
    expect(summaryOf(step, done({ start: "2026-11-02T10:00:00.000Z" })).summary).toBe(
      "Booked Mon, Nov 2 at 10:00 AM",
    );
  });

  test("webhooks and events read as delivered and sent", () => {
    expect(summaryOf(action("http.post", "Tell HR"), done({ status: 200, body: "" })).summary).toBe(
      "Delivered",
    );
    const emit = action("events.emit", "Announce it");
    expect(summaryOf(emit, done({ eventId: "e-1", name: "onboarding.completed" })).summary).toBe(
      "Sent the onboarding.completed event",
    );
    expect(summaryOf(emit, done({ eventId: "e-2", name: "entity.put" })).summary).toBe(
      "Requested a record update",
    );
  });

  test("an operation the studio doesn't know reads as done", () => {
    expect(summaryOf(action("crm.sync", "Sync"), done({ id: 1 })).summary).toBe("Done");
  });
});

describe("other finished steps", () => {
  test("an agent's short answer shows; a long one doesn't", () => {
    const step: Step = { id: "a", kind: "agent", title: "Pick a tone", instruction: "Pick" };
    expect(summaryOf(step, done({ output: "Warm and brief" })).summary).toBe("Warm and brief");
    expect(summaryOf(step, done({ output: "A long answer ".repeat(10) })).summary).toBe("Answered");
    expect(summaryOf(step, done({ output: { tone: "warm" } })).summary).toBe("Answered");
  });

  test("a human step says how it was answered", () => {
    const approval: Step = {
      id: "h",
      kind: "human",
      title: "Approve",
      prompt: "OK?",
      response: "approval",
    };
    expect(summaryOf(approval, done({ approved: true, timedOut: false })).summary).toBe("Approved");
    expect(
      summaryOf(approval, done({ approved: false, respondedBy: "grace@example.com" })).summary,
    ).toBe("Rejected by Grace");
    expect(summaryOf(approval, done({ timedOut: true })).summary).toBe("Timed out");
    const form: Step = {
      id: "f",
      kind: "human",
      title: "Order",
      prompt: "Order it",
      response: { fields: [{ name: "budget", label: "Budget", type: "number" }] },
    };
    expect(summaryOf(form, done({ values: { budget: 1 }, timedOut: false })).summary).toBe(
      "Answered",
    );
    expect(summaryOf(form, done({ values: { budget: 1 }, timedOut: true })).summary).toBe(
      "Timed out, kept the defaults",
    );
  });

  test("waits, decisions, conditions, and stops", () => {
    const pause: Step = { id: "w", kind: "wait", title: "Settle in", duration: "3 days" };
    expect(summaryOf(pause, done(null)).summary).toBe("Waited 3 days");
    const until: Step = { id: "u", kind: "wait", title: "Start", until: "employee.start_date" };
    expect(summaryOf(until, done(null)).summary).toBe("Waited until start date");
    const decide: Step = {
      id: "d",
      kind: "decide",
      title: "Route",
      question: "Which?",
      model: "clef-flash",
      options: [{ id: "high_priority", description: "Urgent", steps: [] }],
    };
    expect(summaryOf(decide, done({ choice: "high_priority", confidence: 1 })).summary).toBe(
      "Chose “High priority”",
    );
    const check: Step = {
      id: "i",
      kind: "if",
      title: "Remote?",
      cases: [{ when: { ref: "employee.remote", op: "equals", value: true }, steps: [] }],
    };
    expect(summaryOf(check, done({ matched: 0 })).summary).toBe("Condition met");
    expect(summaryOf(check, done({ matched: null })).summary).toBe("Condition not met");
    const stop: Step = { id: "s", kind: "stop", title: "Halt", reason: "Withdrew" };
    expect(summaryOf(stop, done({ reason: "Withdrew" })).summary).toBe("Ended the run");
  });
});

describe("steps in flight and steps that didn't run", () => {
  const notify = action("slack.sendMessage", "Tell the manager", { to: "{{employee.manager}}" });
  const notifyTask: HumanTask = { ...permissionTask, step: "act" };

  test("an action waiting on approval names the role", () => {
    expect(summaryOf(notify, { status: "waiting" }, { tasks: [notifyTask] })).toEqual({
      mark: "waiting",
      summary: "Waiting for People Ops",
    });
  });

  test("a human step waiting on someone names them", () => {
    const step: Step = {
      id: "h",
      kind: "human",
      title: "Approve",
      prompt: "OK?",
      response: "approval",
    };
    const task: HumanTask = {
      ...permissionTask,
      step: "h",
      assignee: { $title: "Grace Hopper", email: "grace@example.com" },
    };
    const { approvers: _approvers, ...unassigned } = { ...task, assignee: null };
    expect(summaryOf(step, { status: "waiting" }, { tasks: [task] }).summary).toBe(
      "Waiting for People Ops",
    );
    const { approvers: _ignored, ...assigned } = task;
    expect(summaryOf(step, { status: "waiting" }, { tasks: [assigned] }).summary).toBe(
      "Waiting for Grace",
    );
    expect(summaryOf(step, { status: "waiting" }, { tasks: [unassigned] }).summary).toBe(
      "Waiting for approval",
    );
  });

  test("a human step names who answered as their task knows them", () => {
    const form: Step = {
      id: "f",
      kind: "human",
      title: "Check in",
      prompt: "How is it going?",
      response: { fields: [{ name: "buddy", label: "Buddy", type: "text" }] },
    };
    const answered = done({ values: { buddy: "Katherine" }, respondedBy: "Me@Studio.dev" });
    const { approvers: _approvers, ...checkIn } = {
      ...permissionTask,
      step: "f",
      status: "closed" as const,
      assignee: { $title: "Grace Hopper", email: "me@studio.dev" },
    };
    expect(summaryOf(form, answered, { tasks: [checkIn] }).summary).toBe("Answered by Grace");
    const approval: Step = { ...form, response: "approval" };
    const approved = done({ approved: true, respondedBy: "me@studio.dev" });
    const byRole: HumanTask = {
      ...permissionTask,
      step: "f",
      status: "closed",
      approvers: {
        role: "people_ops",
        label: "People Ops",
        members: [{ name: "Mary Jackson", email: "me@studio.dev" }],
      },
    };
    expect(summaryOf(approval, approved, { tasks: [byRole] }).summary).toBe("Approved by Mary");
    expect(summaryOf(form, answered).summary).toBe("Answered by Me");
  });

  test("a wait says when it resumes", () => {
    const pause: Step = { id: "w", kind: "wait", title: "Settle in", duration: "3 days" };
    const waiting: RunStep = { status: "waiting" };
    expect(summaryOf(pause, waiting, {}, { w: Date.UTC(2026, 10, 5) }).summary).toBe(
      "Resumes Thu, Nov 5",
    );
    expect(summaryOf(pause, waiting, {}, { w: Date.UTC(2026, 10, 5, 15, 30) }).summary).toBe(
      "Resumes Thu, Nov 5 at 3:30 PM",
    );
    expect(summaryOf(pause, { status: "waiting" }).summary).toBe("Waiting");
  });

  test("declined, skipped, running, and unreached steps", () => {
    expect(
      summaryOf(notify, { status: "declined" }, { tasks: [{ ...notifyTask, status: "closed" }] }),
    ).toEqual({
      mark: "declined",
      summary: "Declined by People Ops",
    });
    expect(summaryOf(notify, { status: "skipped" })).toEqual({
      mark: "skipped",
      summary: "Skipped",
    });
    expect(summaryOf(notify, { status: "running" }, { status: "running" })).toEqual({
      mark: "running",
      summary: "Running…",
    });
    expect(summaryOf(notify, undefined)).toEqual({ mark: "pending", summary: undefined });
    const together: Step = { id: "p", kind: "parallel", title: "Notify", branches: [[], []] };
    expect(summaryOf(together, { status: "running" }, { status: "waiting" })).toEqual({
      mark: "running",
      summary: undefined,
    });
  });

  test("a step the run ended under fails or doesn't finish", () => {
    expect(summaryOf(notify, { status: "running" }, { status: "failed" })).toEqual({
      mark: "failed",
      summary: "Failed",
    });
    expect(summaryOf(notify, { status: "waiting" }, { status: "stopped" })).toEqual({
      mark: "interrupted",
      summary: "Didn't finish",
    });
  });
});

test("recipient names come from a display name, an address, or a channel", () => {
  expect(recipientName("Grace Hopper <grace@example.com>")).toBe("Grace");
  expect(recipientName("ada.lovelace@example.com")).toBe("Ada");
  expect(recipientName("@sam@example.com")).toBe("Sam");
  expect(recipientName("#general")).toBe("#general");
});

describe("branch lanes", () => {
  const branch: Step = {
    id: "i",
    kind: "if",
    title: "Remote?",
    cases: [
      { when: { ref: "employee.remote", op: "equals", value: true }, steps: [] },
      { when: { ref: "employee.remote", op: "equals", value: false }, steps: [] },
    ],
    otherwise: [{ id: "o", kind: "stop", title: "Halt", reason: "No" }],
  };

  test("every lane shows until the step chooses, then only the one it took", () => {
    expect(shownLaneIndexes(branch, runWith(branch, undefined), 3)).toEqual([0, 1, 2]);
    expect(shownLaneIndexes(branch, runWith(branch, done({ matched: 1 })), 3)).toEqual([1]);
    expect(shownLaneIndexes(branch, runWith(branch, done({ matched: null })), 3)).toEqual([2]);
  });

  test("a decision shows the option it chose", () => {
    const decide: Step = {
      id: "d",
      kind: "decide",
      title: "Route",
      question: "Which?",
      model: "clef-flash",
      options: [
        { id: "low", description: "Later", steps: [] },
        { id: "high", description: "Now", steps: [] },
      ],
    };
    expect(shownLaneIndexes(decide, runWith(decide, done({ choice: "high" })), 2)).toEqual([1]);
  });
});
