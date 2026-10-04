import { describe, expect, test } from "bun:test";
import { graph, parseDraft, parseWorkflow } from "./workflow.ts";

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

describe("workflow IR", () => {
  test("preserves asymmetric sequential edges and event trigger", () => {
    const result = graph(parseWorkflow(workflow));
    expect(result.edges).toEqual([
      { from: "trigger", to: "summarize" },
      { from: "summarize", to: "notify" },
    ]);
    expect(result.nodes[0]?.title).toBe("Event: order.created");
  });

  test("rejects duplicate IDs, private URLs, and missing executable instructions", () => {
    expect(() =>
      parseWorkflow({ ...workflow, steps: [workflow.steps[0], workflow.steps[0]] }),
    ).toThrow("unique");
    expect(() =>
      parseWorkflow({ ...workflow, steps: [{ ...workflow.steps[1], url: "http://localhost/x" }] }),
    ).toThrow("public HTTPS");
    expect(() =>
      parseWorkflow({ ...workflow, steps: [{ ...workflow.steps[0], instruction: " " }] }),
    ).toThrow("agent instruction");
  });

  test("parses the complete revised draft including fenced JSON", () => {
    const draft = parseDraft(
      "```json\n" + JSON.stringify({ reply: "Added notification", workflow }) + "\n```",
    );
    expect(draft.reply).toBe("Added notification");
    expect(draft.workflow.steps.map((step) => step.id)).toEqual(["summarize", "notify"]);
  });
});
