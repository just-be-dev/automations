import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PiError extends Schema.TaggedError<PiError>()("PiError", {
  message: Schema.String,
}) {}

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
