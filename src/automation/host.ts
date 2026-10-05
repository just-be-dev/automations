import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class AutomationStorageError extends Schema.TaggedError<AutomationStorageError>()(
  "AutomationStorageError",
  { message: Schema.String },
) {}

/** Persistence and durable delivery share a transaction boundary, not just a lifetime. */
export class AutomationHost extends Context.Service<
  AutomationHost,
  {
    readonly storage: {
      readonly get: (key: string) => Effect.Effect<unknown>;
      readonly put: (key: string, value: unknown) => Effect.Effect<void>;
      readonly delete: (key: string) => Effect.Effect<boolean>;
      readonly list: (options: {
        readonly prefix: string;
      }) => Effect.Effect<ReadonlyMap<string, unknown>>;
      /** Rolls back writes and scheduled jobs together on failure, defect, or interruption. */
      readonly transaction: <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E | AutomationStorageError, R>;
    };
    readonly jobs: {
      readonly designReply: (automationId: string, chatId: string) => Effect.Effect<void>;
      readonly advance: (executionId: string) => Effect.Effect<void>;
      readonly clock: (
        executionId: string,
        deferredName: string,
        at: number,
      ) => Effect.Effect<void>;
    };
  }
>()("automations/AutomationHost") {}
