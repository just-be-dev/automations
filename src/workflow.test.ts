import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { decodeDraft, decodeWorkflow, graph } from "./workflow.ts";

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

  test("rejects drafts that are not JSON or lack a reply", () => {
    const notJson = Effect.runSync(decodeDraft("Sure! Here you go.").pipe(Effect.flip));
    expect(notJson._tag).toBe("InvalidWorkflow");
    const noReply = Effect.runSync(
      decodeDraft(JSON.stringify({ reply: " ", workflow })).pipe(Effect.flip),
    );
    expect(noReply.message).toContain("reply");
  });
});
