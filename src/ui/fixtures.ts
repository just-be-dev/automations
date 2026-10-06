/** Supplies shared onboarding workflows, human tasks, and runs for studio and run interaction tests. */
import * as Option from "effect/Option";
import type { Url } from "foldkit/url";
import type { HumanTask, Run, RunSummary, Workflow } from "../workflow.ts";

export const studioUrl = (search?: string): Url => ({
  protocol: "http:",
  host: "localhost:1338",
  port: Option.some("1338"),
  pathname: "/",
  search: search === undefined ? Option.none() : Option.some(search),
  hash: Option.none(),
});

export const onboarding: Workflow = {
  name: "Manager onboarding",
  trigger: { kind: "manual", subject: "employee" },
  steps: [
    {
      id: "approve",
      kind: "human",
      title: "Approve the plan",
      prompt: "Approve onboarding for {{employee.name}}?",
      assignee: "employee.manager",
      notify: "slack",
      response: "approval",
    },
    {
      id: "laptop",
      kind: "human",
      title: "Order a laptop",
      prompt: "Confirm the laptop order for {{employee.name}}.",
      response: {
        fields: [
          {
            name: "start_date",
            label: "Start date",
            type: "date",
            default: "{{employee.start_date}}",
          },
          { name: "budget", label: "Budget", type: "number" },
          { name: "remote", label: "Works remotely", type: "boolean", default: "false" },
        ],
      },
    },
    {
      id: "notify",
      kind: "action",
      title: "Tell the manager",
      use: "slack.sendMessage",
      with: {
        to: "{{employee.manager}}",
        text: "{{employee.name}} starts on {{employee.start_date}}",
      },
    },
  ],
};

export const approvalTask: HumanTask = {
  step: "approve",
  token: "token-approve",
  title: "Approve the plan",
  prompt: "Approve onboarding for Ari Cho?",
  assignee: { $title: "Sam Park", email: "sam@example.com" },
  response: "approval",
  defaults: {},
  notify: "slack",
  status: "open",
};

export const laptopTask: HumanTask = {
  step: "laptop",
  token: "token-laptop",
  title: "Order a laptop",
  prompt: "Confirm the laptop order for Ari Cho.",
  assignee: null,
  response: {
    fields: [
      { name: "start_date", label: "Start date", type: "date", default: "{{employee.start_date}}" },
      { name: "budget", label: "Budget", type: "number" },
      { name: "remote", label: "Works remotely", type: "boolean", default: "false" },
    ],
  },
  defaults: { start_date: "2026-11-02", remote: "false" },
  status: "open",
};

export const runOf = (overrides: Partial<Run>): Run => ({
  id: "run-1",
  workflow: onboarding,
  subject: { type: "employee", id: "emp-2", data: { name: "Ari Cho", start_date: "2026-11-02" } },
  status: "waiting",
  steps: {},
  tasks: [],
  startedAt: Date.UTC(2026, 9, 5, 9),
  ...overrides,
});

export const summaryOf = (run: Run): RunSummary => ({
  id: run.id,
  status: run.status,
  startedAt: run.startedAt,
  subject: "Ari Cho",
  openTasks: run.tasks.filter((task) => task.status === "open").length,
});

export const permissionTask: HumanTask = {
  step: "notify",
  token: "token-notify",
  title: "Tell the manager",
  prompt:
    "Send a Slack message with the details below? Rejecting skips this step and the steps that need its result.",
  assignee: null,
  response: "approval",
  defaults: {},
  action: {
    use: "slack.sendMessage",
    inputs: {
      to: { $title: "Sam Park", email: "sam@example.com" },
      text: "Ari Cho starts on 2026-11-02",
    },
  },
  approvers: {
    role: "people_ops",
    label: "People Ops",
    members: [{ name: "Grace Hopper", email: "grace@example.com" }],
  },
  status: "open",
};
