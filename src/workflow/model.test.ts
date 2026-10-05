import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  decodeWorkflow,
  holds,
  loneRef,
  renderTemplate,
  templateParts,
  workflowRefs,
} from "./model.ts";

const workflow = {
  name: "Welcome new hires",
  trigger: { kind: "entity", entity: "employee", fields: ["start_date"] },
  steps: [
    {
      id: "draft",
      title: "Draft a welcome for {{employee.name}}",
      kind: "agent",
      instruction: "Write a welcome note for {{employee.name}}",
    },
    {
      id: "send",
      title: "Send it",
      kind: "action",
      use: "email.send",
      with: { to: "{{employee}}", subject: "Welcome", body: "{{steps.draft.output}}" },
    },
  ],
};

const failure = (value: unknown) => Effect.runSync(decodeWorkflow(value).pipe(Effect.flip)).message;

describe("workflow schema", () => {
  test("decodes an object trigger and action steps", () => {
    const decoded = Effect.runSync(decodeWorkflow(workflow));
    expect(decoded.trigger).toEqual({ kind: "entity", entity: "employee", fields: ["start_date"] });
    expect(decoded.steps.map((step) => step.kind)).toEqual(["agent", "action"]);
  });

  test("rejects duplicate IDs, blank instructions, and empty workflows", () => {
    expect(failure({ ...workflow, steps: [workflow.steps[0], workflow.steps[0]] })).toContain(
      "unique",
    );
    expect(failure({ ...workflow, steps: [{ ...workflow.steps[0], instruction: " " }] })).toContain(
      "instruction",
    );
    expect(failure({ ...workflow, steps: [] })).toContain("1–20 steps");
  });

  test("rejects the removed event field and webhook steps", () => {
    expect(failure({ name: "Old", event: "order.created", steps: workflow.steps })).toContain(
      "trigger",
    );
    expect(
      failure({
        ...workflow,
        steps: [{ id: "hook", title: "Hook", kind: "webhook", url: "https://example.com" }],
      }),
    ).not.toBe("");
  });

  test("unwraps refs written as templates", () => {
    const decoded = Effect.runSync(
      decodeWorkflow({
        ...workflow,
        steps: [
          {
            id: "before",
            title: "Week before",
            kind: "wait",
            until: "{{ employee.start_date }}",
            offset: "-7 days",
          },
        ],
      }),
    );
    expect(decoded.steps[0]).toMatchObject({ until: "employee.start_date" });
    expect(
      failure({
        ...workflow,
        steps: [{ id: "w", title: "w", kind: "wait", until: "Start Date" }],
      }),
    ).toContain("dotted paths");
  });

  test("rejects malformed durations and nesting deeper than four levels", () => {
    expect(
      failure({ ...workflow, steps: [{ id: "w", title: "W", kind: "wait", duration: "soon" }] }),
    ).toContain("Durations");
    const agent = (id: string) => ({ id, title: id, kind: "agent", instruction: `Do ${id}` });
    const wrap = (id: string, inner: unknown) => ({
      id,
      title: id,
      kind: "parallel",
      branches: [[inner], [agent(`${id}-side`)]],
    });
    expect(
      failure({ ...workflow, steps: [wrap("a", wrap("b", wrap("c", wrap("d", agent("e")))))] }),
    ).toContain("nest");
  });
});

describe("templates", () => {
  test("splits text into literal parts and {{refs}}", () => {
    expect(templateParts("Badge for {{ employee.name }} from {{steps.order.output}}")).toEqual([
      { kind: "text", text: "Badge for " },
      { kind: "ref", ref: "employee.name" },
      { kind: "text", text: " from " },
      { kind: "ref", ref: "steps.order.output" },
    ]);
  });

  test("leaves other bracket styles as text", () => {
    const text = "Email [new hire] about {{Start Date}} and {single}";
    expect(templateParts(text)).toEqual([{ kind: "text", text }]);
  });

  test("renders objects by their title and leaves unknown refs in place", () => {
    const values = {
      "employee.manager": { $title: "Grace Hopper", email: "grace@example.com" },
      "employee.start_date": "2026-11-02",
    };
    expect(
      renderTemplate(
        "{{employee.manager}} welcomes you on {{employee.start_date}} at {{employee.desk}}",
        values,
      ),
    ).toBe("Grace Hopper welcomes you on 2026-11-02 at {{employee.desk}}");
  });

  test("recognizes a value that is exactly one ref", () => {
    expect(loneRef(" {{employee.manager}} ")).toBe("employee.manager");
    expect(loneRef("Hi {{employee.name}}")).toBeUndefined();
  });

  test("lists every ref the workflow reads, the trigger's condition first", () => {
    const decoded = Effect.runSync(
      decodeWorkflow({
        ...workflow,
        trigger: {
          ...workflow.trigger,
          when: { ref: "employee.start_date", op: "after", value: "now" },
        },
      }),
    );
    expect(workflowRefs(decoded)).toEqual([
      "employee.start_date",
      "employee.name",
      "employee",
      "steps.draft.output",
    ]);
  });
});

describe("conditions", () => {
  const values: Record<string, unknown> = {
    "employee.priority": "high",
    "employee.tags": ["vip"],
    "steps.route.confidence": 0.8,
    "employee.start_date": "2026-11-02",
  };
  const read = (ref: string) => values[ref];

  test("compares values", () => {
    expect(holds({ ref: "employee.priority", op: "equals", value: "high" }, read)).toBe(true);
    expect(holds({ ref: "steps.route.confidence", op: "greaterThan", value: 0.5 }, read)).toBe(
      true,
    );
    expect(holds({ ref: "employee.tags", op: "contains", value: "vip" }, read)).toBe(true);
    expect(holds({ ref: "employee.missing", op: "exists" }, read)).toBe(false);
    expect(holds({ ref: "steps.route.confidence", op: "lessThan", value: "10" }, read)).toBe(false);
  });

  test("compares dates with each other and with now", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    expect(holds({ ref: "employee.start_date", op: "after", value: "now" }, read, now)).toBe(true);
    expect(
      holds({ ref: "employee.start_date", op: "before", value: "2026-11-01" }, read, now),
    ).toBe(false);
    expect(holds({ ref: "employee.priority", op: "after", value: "now" }, read, now)).toBe(false);
  });

  test("combines checks with all, any, and not", () => {
    const high = { ref: "employee.priority", op: "equals", value: "high" } as const;
    const low = { ref: "employee.priority", op: "equals", value: "low" } as const;
    expect(holds({ all: [high, { not: low }] }, read)).toBe(true);
    expect(holds({ any: [low, { not: high }] }, read)).toBe(false);
  });
});
