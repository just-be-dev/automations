/** Checks replay-safe edits and assembly of the planner's flat working copy into a workflow tree. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { decodeWorkflow, type Workflow } from "../../workflow/model.ts";
import {
  assemblePlan,
  changeWorkflow,
  layoutProblems,
  planOf,
  planYaml,
  putSteps,
  removeSteps,
  samePlan,
  setPermissions,
} from "./plan.ts";

const workflow: Workflow = Effect.runSync(
  decodeWorkflow({
    name: "Onboarding",
    trigger: { kind: "entity", entity: "employee", fields: ["start_date"] },
    steps: [
      { id: "wait", title: "Wait", kind: "wait", until: "employee.start_date", offset: "-7 days" },
      {
        id: "prepare",
        title: "Prepare",
        kind: "parallel",
        branches: [
          [{ id: "laptop", title: "Order a laptop", kind: "agent", instruction: "Pick one" }],
          [
            {
              id: "ready",
              title: "Ready?",
              kind: "if",
              cases: [
                {
                  when: { ref: "employee.start_date", op: "exists" },
                  steps: [
                    {
                      id: "welcome",
                      title: "Welcome",
                      kind: "action",
                      use: "email.send",
                      with: {
                        to: "{{employee}}",
                        subject: "Hi",
                        body: "Welcome {{employee.name}}",
                      },
                    },
                  ],
                },
              ],
              otherwise: [{ id: "halt", title: "Halt", kind: "stop", reason: "No date" }],
            },
          ],
        ],
      },
    ],
    permissions: { "email.send": "auto" },
  }),
);

describe("the planner's working copy", () => {
  test("keeps every step once, with nested lists naming IDs, and rebuilds the same tree", () => {
    const plan = planOf(workflow);
    expect(plan.steps).toEqual(["wait", "prepare"]);
    expect(Object.keys(plan.stepsById).toSorted()).toEqual(
      ["halt", "laptop", "prepare", "ready", "wait", "welcome"].toSorted(),
    );
    expect(plan.stepsById["prepare"]).toMatchObject({ branches: [["laptop"], ["ready"]] });
    expect(plan.stepsById["ready"]).toMatchObject({
      cases: [{ steps: ["welcome"] }],
      otherwise: ["halt"],
    });
    expect(Effect.runSync(assemblePlan(plan))).toEqual(workflow);
  });

  test("starts empty without a draft, and says what's missing", () => {
    const error = Effect.runSync(assemblePlan(planOf(undefined)).pipe(Effect.flip));
    expect(error.message).toContain("no name yet");
    expect(error.message).toContain("no trigger yet");
  });

  test("reports steps no list names, IDs no step has, and steps listed twice", () => {
    const plan = putSteps(
      changeWorkflow(planOf(workflow), { steps: ["wait", "prepare", "gone", "wait"] }),
      [{ id: "extra", title: "Extra", kind: "stop", reason: "Unused" }],
    );
    expect(layoutProblems(plan)).toEqual([
      "A list names step gone, which doesn't exist: put it, or take it out",
      "Step wait is in more than one list; a step belongs to exactly one",
      "Step extra isn't in any list, so it would never run: list it, or remove it",
    ]);
    expect(Effect.runSync(assemblePlan(plan).pipe(Effect.flip)).message).toContain("Step extra");
  });

  test("replacing a step by ID keeps its place", () => {
    const plan = putSteps(planOf(workflow), [
      { id: "wait", title: "Wait three days", kind: "wait", duration: "3 days" },
    ]);
    const assembled = Effect.runSync(assemblePlan(plan));
    expect(assembled.steps[0]).toEqual({
      id: "wait",
      title: "Wait three days",
      kind: "wait",
      duration: "3 days",
    });
  });

  test("removing a step removes the steps nested in it and takes it out of every list", () => {
    const plan = removeSteps(planOf(workflow), ["ready"]);
    expect(Object.keys(plan.stepsById).toSorted()).toEqual(["laptop", "prepare", "wait"]);
    expect(plan.stepsById["prepare"]).toMatchObject({ branches: [["laptop"], []] });
    // An emptied branch is left for the planner to fix; decoding the tree reports it.
    expect(Effect.runSync(assemblePlan(plan).pipe(Effect.flip)).message).toContain(
      "A branch needs 1–20 steps",
    );
  });

  test("merges permissions", () => {
    const plan = setPermissions(planOf(workflow), { "slack.sendMessage": { ask: "ops" } });
    expect(plan.permissions).toEqual({ "email.send": "auto", "slack.sendMessage": { ask: "ops" } });
  });

  test("compares working copies by value, whatever their key order", () => {
    const plan = planOf(workflow);
    const reordered = {
      permissions: plan.permissions,
      stepsById: plan.stepsById,
      steps: plan.steps,
      trigger: plan.trigger,
      name: plan.name,
    };
    expect(samePlan(plan, reordered)).toBe(true);
    expect(samePlan(plan, changeWorkflow(plan, { name: "Other" }))).toBe(false);
  });

  test("reads as YAML with nested steps in place, quoted refs, and no aliases", () => {
    const yaml = planYaml(planOf(workflow));
    expect(yaml).toStartWith("name: Onboarding\ntrigger:\n  kind: entity");
    expect(yaml).toContain('to: "{{employee}}"');
    expect(yaml).toContain("- id: welcome");
    expect(yaml).toContain("email.send: auto");
    expect(yaml).not.toContain("*a");
    expect(yaml).not.toContain('{"');
  });
});
