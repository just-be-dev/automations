import * as Schema from "effect/Schema";

/**
 * What an agent conversation recorded, oldest first, for the traces debug page: the prompts it
 * got, its reasoning, answers and tool calls, the tools' results, and changes to its system prompt.
 * Times are epoch milliseconds.
 */

export const TraceUsage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  /** In US dollars, as the provider prices it; zero when it doesn't. */
  cost: Schema.Finite,
});
export interface TraceUsage extends Schema.Schema.Type<typeof TraceUsage> {}

export const TraceToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The arguments as indented JSON. */
  arguments: Schema.String,
});
export interface TraceToolCall extends Schema.Schema.Type<typeof TraceToolCall> {}

/** A change to the system prompt: new instructions or sections, and tools offered or withdrawn. */
export const TraceInstructions = Schema.TaggedStruct("Instructions", {
  id: Schema.String,
  at: Schema.Finite,
  text: Schema.String,
  toolsAdded: Schema.Array(Schema.String),
  toolsRemoved: Schema.Array(Schema.String),
});

export const TracePrompt = Schema.TaggedStruct("Prompt", {
  id: Schema.String,
  at: Schema.Finite,
  text: Schema.String,
});

/** One model response: a final answer, or tool calls the next response continues from. */
export const TraceAnswer = Schema.TaggedStruct("Answer", {
  id: Schema.String,
  at: Schema.Finite,
  model: Schema.String,
  thinking: Schema.String,
  text: Schema.String,
  toolCalls: Schema.Array(TraceToolCall),
  stopReason: Schema.String,
  error: Schema.optionalKey(Schema.String),
  usage: TraceUsage,
});

export const TraceToolResult = Schema.TaggedStruct("ToolResult", {
  id: Schema.String,
  at: Schema.Finite,
  toolCallId: Schema.String,
  toolName: Schema.String,
  text: Schema.String,
  isError: Schema.Boolean,
});

/** The model's context started over here, carrying `text` forward when it isn't empty. */
export const TraceReset = Schema.TaggedStruct("Reset", {
  id: Schema.String,
  text: Schema.String,
});

/** Earlier entries were summarized into `text` to keep the context small. */
export const TraceCompaction = Schema.TaggedStruct("Compaction", {
  id: Schema.String,
  text: Schema.String,
});

export const TraceEvent = Schema.Union([
  TraceInstructions,
  TracePrompt,
  TraceAnswer,
  TraceToolResult,
  TraceReset,
  TraceCompaction,
]);
export type TraceEvent = typeof TraceEvent.Type;

export const Trace = Schema.Struct({
  events: Schema.Array(TraceEvent),
  /** The conversation is longer than a trace holds; `events` are its latest entries. */
  truncated: Schema.Boolean,
});
export interface Trace extends Schema.Schema.Type<typeof Trace> {}

export const emptyTrace: Trace = { events: [], truncated: false };
