/** Checks agent-step prompts and decoding of structured agent answers and routing decisions. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { agentOutput, agentPrompt, decision } from "./agent-step.ts";
import type { AgentStep } from "./model.ts";
import { RunId } from "./run.ts";

const propose: AgentStep = {
  id: "propose",
  title: "Propose a 1:1 time",
  kind: "agent",
  instruction: "Pick the best weekly slot",
  output: {
    fields: [
      { name: "start", type: "datetime" },
      { name: "reason", type: "text" },
    ],
  },
};

describe("agent steps", () => {
  test("asks for the output fields and decodes a fenced answer", () => {
    const prompt = agentPrompt(propose, "Pick the best weekly slot", {
      runId: RunId.make("r"),
      subject: null,
      steps: {},
    });
    expect(prompt).toContain('"start" (datetime), "reason" (text)');
    expect(
      Effect.runSync(
        agentOutput(
          propose,
          '```json\n{"start":"2026-11-03T10:00:00Z","reason":"Both free","extra":1}\n```',
        ),
      ),
    ).toEqual({ start: "2026-11-03T10:00:00Z", reason: "Both free" });
  });

  test("rejects answers with missing or mistyped fields", () => {
    const error = Effect.runSync(
      agentOutput(propose, '{"start":"next Tuesday"}').pipe(Effect.flip),
    );
    expect(error.message).toContain("start (datetime), reason (text)");
  });

  test("keeps plain answers as text when the step asks for no fields", () => {
    const { output: _, ...plain } = propose;
    expect(Effect.runSync(agentOutput(plain, "Tuesday at 10"))).toBe("Tuesday at 10");
  });

  test("reads a decision", () => {
    expect(Effect.runSync(decision('{"choice":"escalate","confidence":0.8}'))).toEqual({
      choice: "escalate",
      confidence: 0.8,
      probabilities: { escalate: 0.8 },
    });
  });
});
