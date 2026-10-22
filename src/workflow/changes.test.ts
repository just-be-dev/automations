/** Checks the step-by-ID workflow diff: nested lists, field-level old values, moves, and unsaved changes. */
import { describe, expect, test } from "bun:test";
import { diffWorkflows, isUnchanged, unsavedChanges } from "./changes.ts";
import type { Step, Workflow } from "./model.ts";

const post = (id: string, channel: string, title = `Post in ${channel}`): Step => ({
  id,
  title,
  kind: "action",
  use: "slack.sendMessage",
  with: { channel, text: "Say hi to {{employee.name}}" },
});

const agent = (id: string, instruction = "Write a note"): Step => ({
  id,
  title: `Agent ${id}`,
  kind: "agent",
  instruction,
});

const workflowOf = (steps: ReadonlyArray<Step>, extra: Partial<Workflow> = {}): Workflow => ({
  name: "Welcome new hires",
  trigger: { kind: "entity", entity: "employee" },
  steps,
  permissions: { "slack.sendMessage": "auto" },
  ...extra,
});

describe("diffWorkflows", () => {
  test("finds nothing between equal workflows, whatever their key order", () => {
    const before = workflowOf([post("welcome", "#general")]);
    const after = workflowOf([
      {
        with: { text: "Say hi to {{employee.name}}", channel: "#general" },
        use: "slack.sendMessage",
        kind: "action",
        title: "Post in #general",
        id: "welcome",
      },
    ]);
    expect(isUnchanged(diffWorkflows(before, after))).toBe(true);
  });

  test("records a changed input with its old value", () => {
    const changes = diffWorkflows(
      workflowOf([agent("draft"), post("welcome", "#general", "Welcome them")]),
      workflowOf([agent("draft"), post("welcome", "#eng-team", "Welcome them")]),
    );
    expect(changes.steps).toEqual([
      {
        kind: "changed",
        id: "welcome",
        fields: [{ path: "with.channel", before: "#general" }],
        moved: false,
      },
    ]);
  });

  test("records new and removed fields, lists as one value, and an object that became text", () => {
    const before: Step = {
      id: "ask",
      title: "Ask the manager",
      kind: "human",
      prompt: "Approve?",
      assignee: "employee.manager",
      response: "approval",
    };
    const after: Step = {
      id: "ask",
      title: "Ask the manager",
      kind: "human",
      prompt: "Approve?",
      timeout: "3 days",
      response: { fields: [{ name: "note", label: "Note", type: "text" }] },
    };
    const changes = diffWorkflows(workflowOf([before]), workflowOf([after]));
    expect(changes.steps).toEqual([
      {
        kind: "changed",
        id: "ask",
        fields: [
          { path: "assignee", before: "employee.manager" },
          { path: "response", before: "approval" },
          { path: "timeout" },
        ],
        moved: false,
      },
    ]);
    const recipients = diffWorkflows(
      workflowOf([
        {
          id: "mail",
          title: "Mail",
          kind: "action",
          use: "email.send",
          with: { to: ["a"], body: "x" },
        },
      ]),
      workflowOf([
        {
          id: "mail",
          title: "Mail",
          kind: "action",
          use: "email.send",
          with: { to: ["a", "b"], body: "x" },
        },
      ]),
    );
    expect(recipients.steps).toEqual([
      { kind: "changed", id: "mail", fields: [{ path: "with.to", before: ["a"] }], moved: false },
    ]);
  });

  test("finds added, changed, and removed steps inside parallel branches", () => {
    const parallel = (branches: ReadonlyArray<ReadonlyArray<Step>>): Step => ({
      id: "fan",
      title: "Tell everyone",
      kind: "parallel",
      branches,
    });
    const changes = diffWorkflows(
      workflowOf([parallel([[post("general", "#general")], [agent("note")], [agent("gone")]])]),
      workflowOf([
        parallel([
          [post("general", "#eng-team", "Post in #general")],
          [agent("note"), agent("new")],
        ]),
      ]),
    );
    expect(changes.steps).toEqual([
      {
        kind: "changed",
        id: "fan",
        fields: [{ path: "branches", before: 3 }],
        moved: false,
      },
      {
        kind: "changed",
        id: "general",
        fields: [{ path: "with.channel", before: "#general" }],
        moved: false,
      },
      { kind: "added", id: "new" },
      { kind: "removed", id: "gone", title: "Agent gone" },
    ]);
  });

  test("reports an if step's own condition apart from the steps in its cases", () => {
    const branching = (
      value: string,
      steps: ReadonlyArray<Step>,
      otherwise?: ReadonlyArray<Step>,
    ) =>
      ({
        id: "check",
        title: "Engineers only",
        kind: "if",
        cases: [{ when: { ref: "employee.role", op: "contains", value }, steps }],
        ...(otherwise === undefined ? {} : { otherwise }),
      }) satisfies Step;
    const changes = diffWorkflows(
      workflowOf([branching("engineer", [post("welcome", "#general")], [agent("skip")])]),
      workflowOf([branching("Engineer", [post("welcome", "#eng-team", "Post in #general")])]),
    );
    expect(changes.steps).toEqual([
      {
        kind: "changed",
        id: "check",
        fields: [
          {
            path: "cases.0.when",
            before: { ref: "employee.role", op: "contains", value: "engineer" },
          },
        ],
        moved: false,
      },
      {
        kind: "changed",
        id: "welcome",
        fields: [{ path: "with.channel", before: "#general" }],
        moved: false,
      },
      { kind: "removed", id: "skip", title: "Agent skip" },
    ]);
  });

  test("reports a decide step's options and the steps nested in them", () => {
    const decide = (description: string, yes: ReadonlyArray<Step>): Step => ({
      id: "route",
      title: "Route it",
      kind: "decide",
      model: "clef",
      question: "Is it urgent?",
      options: [
        { id: "yes", description, steps: yes },
        { id: "no", description: "It can wait", steps: [agent("later")] },
      ],
    });
    const changes = diffWorkflows(
      workflowOf([decide("It's urgent", [agent("now")])]),
      workflowOf([decide("It needs an answer today", [agent("now", "Answer it"), agent("page")])]),
    );
    expect(changes.steps).toEqual([
      {
        kind: "changed",
        id: "route",
        fields: [{ path: "options.0.description", before: "It's urgent" }],
        moved: false,
      },
      {
        kind: "changed",
        id: "now",
        fields: [{ path: "instruction", before: "Write a note" }],
        moved: false,
      },
      { kind: "added", id: "page" },
    ]);
  });

  test("lists only the outermost step of a removed container", () => {
    const changes = diffWorkflows(
      workflowOf([
        agent("keep"),
        { id: "fan", title: "Fan out", kind: "parallel", branches: [[agent("a")], [agent("b")]] },
      ]),
      workflowOf([agent("keep")]),
    );
    expect(changes.steps).toEqual([{ kind: "removed", id: "fan", title: "Fan out" }]);
  });

  test("marks moved steps, but not the siblings of an inserted or removed step", () => {
    const inserted = diffWorkflows(
      workflowOf([agent("a"), agent("b"), agent("c")]),
      workflowOf([agent("new"), agent("a"), agent("c")]),
    );
    expect(inserted.steps).toEqual([
      { kind: "added", id: "new" },
      { kind: "removed", id: "b", title: "Agent b" },
    ]);
    const swapped = diffWorkflows(
      workflowOf([agent("a"), agent("b"), agent("c")]),
      workflowOf([agent("c"), agent("a"), agent("b")]),
    );
    expect(swapped.steps).toEqual([{ kind: "changed", id: "c", fields: [], moved: true }]);
    const intoBranch = diffWorkflows(
      workflowOf([
        agent("a"),
        { id: "fan", title: "Fan out", kind: "parallel", branches: [[agent("b")], [agent("c")]] },
      ]),
      workflowOf([
        {
          id: "fan",
          title: "Fan out",
          kind: "parallel",
          branches: [[agent("b"), agent("a")], [agent("c")]],
        },
      ]),
    );
    expect(intoBranch.steps).toEqual([{ kind: "changed", id: "a", fields: [], moved: true }]);
  });

  test("records the old name, trigger, and permissions", () => {
    const changes = diffWorkflows(
      workflowOf([post("welcome", "#general")]),
      workflowOf([post("welcome", "#general")], {
        name: "Welcome engineers",
        trigger: { kind: "entity", entity: "employee", fields: ["start_date"] },
        permissions: { "slack.sendMessage": "ask", "email.send": "auto" },
      }),
    );
    expect(changes).toEqual({
      name: { before: "Welcome new hires" },
      trigger: { before: { kind: "entity", entity: "employee" } },
      steps: [],
      permissions: [
        { operation: "slack.sendMessage", before: "auto" },
        { operation: "email.send" },
      ],
    });
  });

  test("drops old values when they would make the changes too large to store", () => {
    const long = "x".repeat(3_900);
    const steps = (count: number, instruction: string) =>
      workflowOf(Array.from({ length: count }, (_, index) => agent(`a${index}`, instruction)));
    const changes = diffWorkflows(steps(5, long), steps(5, `${long}!`));
    expect(changes.steps).toHaveLength(5);
    expect(changes.steps[0]).toEqual({
      kind: "changed",
      id: "a0",
      fields: [{ path: "instruction", before: long }],
      moved: false,
    });
    const tooLarge = diffWorkflows(steps(20, long), steps(20, `${long}!`));
    expect(tooLarge.steps[0]).toEqual({
      kind: "changed",
      id: "a0",
      fields: [{ path: "instruction" }],
      moved: false,
    });
  });
});

describe("unsavedChanges", () => {
  const before = workflowOf([agent("draft"), post("welcome", "#general", "Welcome them")]);
  const after = workflowOf(
    [agent("draft", "Write a warm note"), post("welcome", "#eng-team", "Welcome them")],
    {
      permissions: { "slack.sendMessage": "ask" },
    },
  );
  const changes = diffWorkflows(before, after);

  test("keeps everything when nothing is saved, or the saved version predates the reply", () => {
    expect(unsavedChanges(changes, undefined, after)).toEqual(changes);
    expect(unsavedChanges(changes, before, after)).toEqual(changes);
  });

  test("keeps nothing once the draft is saved", () => {
    expect(isUnchanged(unsavedChanges(changes, after, after))).toBe(true);
  });

  test("keeps only the parts that still differ from the saved version", () => {
    const partlySaved = workflowOf([
      agent("draft", "Write a warm note"),
      post("welcome", "#general", "Welcome them"),
    ]);
    expect(unsavedChanges(changes, partlySaved, after)).toEqual({
      steps: [
        {
          kind: "changed",
          id: "welcome",
          fields: [{ path: "with.channel", before: "#general" }],
          moved: false,
        },
      ],
      permissions: [{ operation: "slack.sendMessage", before: "auto" }],
    });
  });
});
