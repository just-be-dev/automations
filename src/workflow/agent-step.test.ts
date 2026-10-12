/** Checks agent-step prompts and decoding of structured agent answers and routing decisions. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { agentOutput, agentPrompt, decideRequest, decision } from "./agent-step.ts";
import type { AgentStep, DecideStep } from "./model.ts";
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
});

describe("decide steps", () => {
  const route: DecideStep = {
    id: "route",
    title: "Route the ticket",
    kind: "decide",
    model: "clef",
    question: "Which team?",
    options: [
      { id: "billing", description: "Charges and refunds", steps: [] },
      { id: "technical", description: "Outages and bugs", steps: [] },
    ],
  };

  test("asks the step's model one choice question about the run so far", () => {
    const state = {
      runId: RunId.make("run-1"),
      subject: null,
      event: { id: "t-1", name: "ticket.opened", data: { text: "Refund me" }, depth: 0 },
      steps: { triage: { output: "urgent" } },
    };
    expect(decideRequest(route, "Which team for t-1?", state)).toEqual({
      model: "clef",
      state: { subject: null, event: state.event, steps: state.steps },
      questions: {
        decision: {
          type: "choice",
          instructions: "Which team for t-1?",
          criteria: { billing: "Charges and refunds", technical: "Outages and bugs" },
        },
      },
    });
  });

  test("reads the classifier's decision with every option's probability", () => {
    const response = {
      model: "clef",
      answers: {
        decision: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.9, technical: 0.1 },
          confidence: 0.8,
        },
      },
    };
    expect(Effect.runSync(decision(response))).toEqual({
      choice: "billing",
      confidence: 0.8,
      probabilities: { billing: 0.9, technical: 0.1 },
    });
  });

  test("fails on a response without a decision", () => {
    const error = Effect.runSync(decision({ answers: {} }).pipe(Effect.flip));
    expect(error._tag).toBe("AgentAnswerError");
  });
});
