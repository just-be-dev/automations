/** Host namespace MUST be isolated by trusted owner + sessionId. Transactions serialize callers. */
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class AssistantError extends Schema.TaggedError<AssistantError>()("AssistantError", {
  message: Schema.String,
}) {}

export interface AssistantHost {
  readonly storage: {
    readonly get: (key: string) => Effect.Effect<unknown>;
    readonly put: (key: string, value: unknown) => Effect.Effect<void>;
    readonly delete: (key: string) => Effect.Effect<boolean>;
    readonly list: (options: {
      readonly prefix: string;
    }) => Effect.Effect<ReadonlyMap<string, unknown>>;
    /** Roll back storage AND scheduling on any failure/interruption. */
    readonly transaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | AssistantError, R>;
  };
  readonly jobs: {
    /** Durable at-least-once delivery; after is a delay in milliseconds. */
    readonly reply: (turnId: string, after?: number) => Effect.Effect<void>;
  };
}
