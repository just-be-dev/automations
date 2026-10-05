import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  decodeDraft,
  decodeWorkflow,
  holds,
  loneRef,
  renderTemplate,
  scanBrackets,
  templateParts,
  workflowRefs,
} from "./workflow.ts";

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

  test("parses a fenced draft and rejects one without a reply", () => {
    const draft = Effect.runSync(
      decodeDraft("```json\n" + JSON.stringify({ reply: "Added email", workflow }) + "\n```"),
    );
    expect(draft.workflow.steps.map((step) => step.id)).toEqual(["draft", "send"]);
    const notJson = Effect.runSync(decodeDraft("Sure! Here you go.").pipe(Effect.flip));
    expect(notJson._tag).toBe("InvalidWorkflow");
    const noReply = Effect.runSync(
      decodeDraft(JSON.stringify({ reply: " ", workflow })).pipe(Effect.flip),
    );
    expect(noReply.message).toContain("reply");
  });

  // A reply shaped like one Kimi sent: the if step's last list, then a stray "}" before "]".
  const nested = JSON.stringify({
    reply: "Reminds everyone who hasn't finished",
    workflow: {
      name: "Training reminder",
      trigger: { kind: "entity", entity: "employee", fields: ["start_date"] },
      steps: [
        {
          id: "check",
          title: "Anyone left?",
          kind: "if",
          cases: [
            {
              when: { ref: "employee.start_date", op: "exists" },
              steps: [{ id: "email", title: "Email them", kind: "agent", instruction: "Email" }],
            },
          ],
          otherwise: [{ id: "log", title: "Log it", kind: "agent", instruction: "Log {x}" }],
        },
      ],
    },
  });

  test("repairs a closing bracket out of order", () => {
    expect(nested.endsWith('"}]}]}}')).toBe(true);
    const slipped = `${nested.slice(0, -'"}]}]}}'.length)}"}]}}]}}`;
    const draft = Effect.runSync(decodeDraft(slipped));
    expect(draft.workflow.steps[0]).toMatchObject({ otherwise: [{ id: "log" }] });
  });

  test("closes brackets the reply left open", () => {
    const draft = Effect.runSync(decodeDraft(nested.slice(0, -3)));
    expect(draft.workflow.name).toBe("Training reminder");
  });

  test("leaves brackets inside strings alone", () => {
    expect(scanBrackets('{"a":"}]","b":"\\"}]"}')).toEqual({
      balanced: '{"a":"}]","b":"\\"}]"}',
      missing: "",
      endsInString: false,
    });
    expect(scanBrackets('{"a":["}"}')).toEqual({
      balanced: '{"a":["}"]}',
      mismatch: { at: 9, found: "}", expected: "]" },
      missing: "]}",
      endsInString: false,
    });
  });

  test("tells the agent which bracket is wrong when the repair doesn't parse", () => {
    const error = Effect.runSync(
      decodeDraft('{"reply":"Hi","workflow":{"steps":[1,}]}').pipe(Effect.flip),
    );
    expect(error.message).toStartWith("The reply is not valid JSON: ");
    expect(error.message).toContain(
      `The "}" at the end of "…{"reply":"Hi","workflow":{"steps":[1,}" is wrong: the innermost open bracket there needs "]".`,
    );
  });

  test("tells the agent when the reply was cut off inside a string", () => {
    const error = Effect.runSync(
      decodeDraft('{"reply":"Hi","workflow":{"name":"Rem').pipe(Effect.flip),
    );
    expect(error.message).toContain("It ends inside a string");
  });

  test("leaves prose to the parser's error", () => {
    const error = Effect.runSync(decodeDraft("Sure! Here you go.").pipe(Effect.flip));
    expect(error.message).toStartWith("The reply is not valid JSON: ");
    expect(error.message).not.toContain("bracket");
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
