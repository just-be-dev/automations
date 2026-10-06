/**
 * Carries out an agent step, as a run does: the step's prompt in a fresh conversation, and the
 * record `agentOutput` makes of the answer.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { agentOutput, agentPrompt } from "../../src/workflow/agent-step.ts";
import { ExecutionValues } from "../../src/workflow/execution.ts";
import { AgentStep, ValueType } from "../../src/workflow/model.ts";
import type { Call } from "../framework/call.ts";
import { openPi } from "../framework/models.ts";

export const AgentInput = Schema.Struct({
  title: Schema.String,
  /** As the run sends it, with its refs filled in. */
  instruction: Schema.String,
  /** The fields the step asks for, by name; without them the step records text. */
  fields: Schema.optionalKey(Schema.Record(Schema.String, ValueType)),
  state: ExecutionValues,
});
export type AgentInput = typeof AgentInput.Type;

export const AgentOutput = Schema.Struct({
  answer: Schema.String,
  /** What the step records: the answer's text, or its fields. */
  result: Schema.optionalKey(Schema.Json),
  /** Why the answer couldn't be recorded. */
  problem: Schema.optionalKey(Schema.String),
});
export type AgentOutput = typeof AgentOutput.Type;

const stepOf = (input: AgentInput) =>
  Schema.decodeEffect(AgentStep)({
    id: "step",
    title: input.title,
    kind: "agent",
    instruction: input.instruction,
    ...(input.fields === undefined
      ? {}
      : {
          output: {
            fields: Object.entries(input.fields).map(([name, type]) => ({ name, type })),
          },
        }),
  });

export const agent: Call<AgentInput, AgentOutput> = {
  name: "agent",
  input: AgentInput,
  output: AgentOutput,
  timeout: "2 minutes",
  run: (input) =>
    Effect.gen(function* () {
      const step = yield* stepOf(input);
      const pi = yield* openPi();
      const conversation = yield* pi.createConversation;
      const answer = yield* pi.prompt({
        conversation,
        text: agentPrompt(step, step.instruction, input.state),
      });
      const recorded = yield* agentOutput(step, answer).pipe(Effect.result);
      return recorded._tag === "Success"
        ? { answer, result: recorded.success }
        : { answer, problem: recorded.failure.message };
    }),
};
