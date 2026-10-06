import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PiError extends Schema.TaggedError<PiError>()("PiError", {
  message: Schema.String,
}) {}

/** A tool call the agent should correct, shown to it as an error result. */
export class AgentToolError extends Schema.TaggedError<AgentToolError>()("AgentToolError", {
  message: Schema.String,
}) {}

/** One call of a tool. */
export interface AgentToolCall {
  /** Stays the same when pi runs the call again after a restart. */
  readonly id: string;
}

/**
 * A tool the root conversation can call. pi may run a call again after a restart, so `execute`
 * must be idempotent. It decodes its own arguments; `parameters` is the JSON Schema the model sees.
 */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Schema.JsonObject;
  /** Resolves with the text the model reads. It may wait, for example for the person's answers. */
  readonly execute: (args: unknown, call: AgentToolCall) => Effect.Effect<string, AgentToolError>;
}

export interface PromptOptions {
  /** Defaults to the root conversation. */
  readonly conversation?: number;
  readonly text: string;
  /** Resubmitting the same ID waits for the original submission. */
  readonly requestId?: string;
}

/** The answer the root conversation is generating, as far as pi has committed it. */
export interface LiveAnswer {
  readonly requestId?: string;
  readonly thinking: string;
  readonly text: string;
  /** The tools of the current round that haven't finished, in call order. */
  readonly tools: ReadonlyArray<string>;
}

export class PiAgent extends Context.Service<
  PiAgent,
  {
    /** Creates an ownerless conversation with the root's model, without its instructions. */
    readonly createConversation: Effect.Effect<number, PiError>;
    readonly prompt: (options: PromptOptions) => Effect.Effect<string, PiError>;
    /** Sets the root's instructions for the next request; unchanged instructions aren't resent. */
    readonly instruct: (instructions: string) => Effect.Effect<void, PiError>;
    readonly liveAnswer: Effect.Effect<LiveAnswer | undefined, PiError>;
  }
>()("automations/PiAgent") {}
