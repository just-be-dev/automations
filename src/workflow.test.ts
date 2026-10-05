import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  decodeDraft,
  decodeWorkflow,
  graph,
  holds,
  renderTemplate,
  templateParts,
  workflowVariables,
  type RunState,
} from "./workflow.ts";

const workflow = {
  name: "Order notifications",
  event: "order.created",
  steps: [
    {
      id: "summarize",
      title: "Summarize order",
      kind: "agent",
      instruction: "Summarize the order",
    },
    { id: "notify", title: "Notify team", kind: "webhook", url: "https://example.com/hook" },
  ],
};

const failure = (value: unknown) => Effect.runSync(decodeWorkflow(value).pipe(Effect.flip)).message;

describe("workflow IR", () => {
  test("preserves asymmetric sequential edges and event trigger", () => {
    const result = graph(Effect.runSync(decodeWorkflow(workflow)));
    expect(result.edges).toEqual([
      { from: "trigger", to: "summarize" },
      { from: "summarize", to: "notify" },
    ]);
    expect(result.nodes[0]?.title).toBe("Event: order.created");
  });

  test("rejects duplicate IDs, private URLs, and missing executable instructions", () => {
    expect(failure({ ...workflow, steps: [workflow.steps[0], workflow.steps[0]] })).toContain(
      "unique",
    );
    expect(
      failure({ ...workflow, steps: [{ ...workflow.steps[1], url: "http://localhost/x" }] }),
    ).toContain("public HTTPS");
    expect(
      failure({ ...workflow, steps: [{ ...workflow.steps[1], url: "https://10.0.0.1/x" }] }),
    ).toContain("public HTTPS");
    expect(failure({ ...workflow, steps: [{ ...workflow.steps[0], instruction: " " }] })).toContain(
      "agent instruction",
    );
    expect(failure({ ...workflow, steps: [] })).toContain("1–20 steps");
  });

  test("parses the complete revised draft including fenced JSON", () => {
    const draft = Effect.runSync(
      decodeDraft(
        "```json\n" + JSON.stringify({ reply: "Added notification", workflow }) + "\n```",
      ),
    );
    expect(draft.reply).toBe("Added notification");
    expect(draft.workflow.steps.map((step) => step.id)).toEqual(["summarize", "notify"]);
  });

  test("qualifies bare input field names in references", () => {
    const decoded = Effect.runSync(
      decodeWorkflow({
        ...workflow,
        steps: [
          {
            id: "day-before",
            title: "Wait until the day before",
            kind: "wait",
            until: "start_date",
            offset: "-1 day",
          },
          {
            id: "check",
            title: "Check",
            kind: "if",
            cases: [
              { when: { ref: "{{ remote }}", op: "equals", value: true }, steps: [agent("ship")] },
            ],
          },
        ],
      }),
    );
    expect(decoded.steps[0]).toMatchObject({ until: "input.start_date" });
    expect(decoded.steps[1]).toMatchObject({ cases: [{ when: { ref: "input.remote" } }] });
    expect(
      failure({
        ...workflow,
        steps: [{ id: "w", title: "w", kind: "wait", until: "start.date" }],
      }),
    ).toContain("References start with input.");
  });

  test("rejects drafts that are not JSON or lack a reply", () => {
    const notJson = Effect.runSync(decodeDraft("Sure! Here you go.").pipe(Effect.flip));
    expect(notJson._tag).toBe("InvalidWorkflow");
    const noReply = Effect.runSync(
      decodeDraft(JSON.stringify({ reply: " ", workflow })).pipe(Effect.flip),
    );
    expect(noReply.message).toContain("reply");
  });
});

describe("variables", () => {
  test("splits text into literal parts and {{variables}}", () => {
    expect(templateParts("Badge for {{ new_hire }} on {{start_date}}")).toEqual([
      { kind: "text", text: "Badge for " },
      { kind: "variable", name: "new_hire" },
      { kind: "text", text: " on " },
      { kind: "variable", name: "start_date" },
    ]);
  });

  test("leaves other bracket styles as text", () => {
    const text = "Email [new hire] about {{Start Date}} and {single}";
    expect(templateParts(text)).toEqual([{ kind: "text", text }]);
  });

  test("lists each variable once, in order of first use", () => {
    const steps = [
      {
        id: "a",
        title: "Welcome {{new_hire}}",
        kind: "agent" as const,
        instruction: "Tell {{manager}} that {{new_hire}} starts {{start_date}}",
      },
      { id: "b", title: "Notify {{manager}}", kind: "webhook" as const, url: "https://x.dev" },
    ];
    expect(workflowVariables({ steps })).toEqual(["new_hire", "manager", "start_date"]);
  });
});

const agent = (id: string, instruction = `Do ${id}`) => ({
  id,
  title: id,
  kind: "agent",
  instruction,
});

const nested = {
  name: "Onboarding",
  event: "new_hire.confirmed",
  steps: [
    {
      id: "prep",
      title: "Prep",
      kind: "parallel",
      branches: [
        [agent("laptop", "Order a laptop for {{new_hire}}")],
        [
          {
            id: "week-out",
            title: "One week out",
            kind: "wait",
            until: "input.start_date",
            offset: "-7 days",
          },
          {
            id: "route",
            title: "Route",
            kind: "decide",
            model: "clef",
            question: "Is {{manager}} available?",
            options: [
              { id: "yes", description: "Available", steps: [agent("schedule")] },
              {
                id: "no",
                description: "Away",
                steps: [
                  {
                    id: "ask",
                    title: "Ask",
                    kind: "human",
                    prompt: "Who covers for {{manager}}?",
                    response: { fields: [{ name: "cover", label: "Cover", type: "text" }] },
                    timeout: "2 days",
                  },
                ],
              },
            ],
          },
        ],
      ],
    },
    {
      id: "check",
      title: "Check",
      kind: "if",
      cases: [
        {
          when: { ref: "steps.route.choice", op: "equals", value: "no" },
          steps: [agent("escalate")],
        },
      ],
    },
  ],
};

describe("nested steps", () => {
  test("decodes a tree of parallel, wait, decide, human, and if steps", () => {
    const decoded = Effect.runSync(decodeWorkflow(nested));
    expect(decoded.steps.map((step) => step.kind)).toEqual(["parallel", "if"]);
    expect(workflowVariables(decoded)).toEqual(["new_hire", "start_date", "manager"]);
  });

  test("requires IDs to be unique across the whole tree", () => {
    expect(failure({ ...nested, steps: [...nested.steps, agent("schedule")] })).toContain("unique");
  });

  test("rejects references to steps that don't exist", () => {
    const check = {
      ...nested.steps[1],
      cases: [{ when: { ref: "steps.missing.choice", op: "exists" }, steps: [agent("x")] }],
    };
    expect(failure({ ...nested, steps: [nested.steps[0], check] })).toContain("must name a step");
  });

  test("rejects malformed durations and nesting deeper than four levels", () => {
    expect(
      failure({ ...workflow, steps: [{ id: "w", title: "W", kind: "wait", duration: "soon" }] }),
    ).toContain("Durations");
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

describe("conditions", () => {
  const state: RunState = {
    input: { priority: "high", tags: ["vip"], count: 3 },
    steps: { route: { choice: "no", confidence: 0.8 } },
  };

  test("compares values read from the input and from step results", () => {
    expect(holds({ ref: "input.priority", op: "equals", value: "high" }, state)).toBe(true);
    expect(holds({ ref: "steps.route.confidence", op: "greaterThan", value: 0.5 }, state)).toBe(
      true,
    );
    expect(holds({ ref: "input.tags", op: "contains", value: "vip" }, state)).toBe(true);
    expect(holds({ ref: "input.missing", op: "exists" }, state)).toBe(false);
    expect(holds({ ref: "input.count", op: "lessThan", value: "10" }, state)).toBe(false);
  });

  test("combines checks with all, any, and not", () => {
    const high = { ref: "input.priority", op: "equals", value: "high" } as const;
    const low = { ref: "input.priority", op: "equals", value: "low" } as const;
    expect(holds({ all: [high, { not: low }] }, state)).toBe(true);
    expect(holds({ any: [low, { not: high }] }, state)).toBe(false);
  });
});

test("renders variables from the input and leaves unknown ones in place", () => {
  expect(renderTemplate("Hi {{name}}, starting {{date}}", { name: "Ada" })).toBe(
    "Hi Ada, starting {{date}}",
  );
});
