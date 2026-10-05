import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ExecutionId } from "../workflow/execution.ts";

// Workflows and runs from before entity-based triggers were discarded on purpose.
export const decodeOrDrop =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (value: unknown) =>
    value === undefined
      ? Effect.succeed(undefined)
      : Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.map((decoded): A | undefined => decoded),
          Effect.orElseSucceed(() => undefined),
        );

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
      readonly advance: (executionId: ExecutionId) => Effect.Effect<void>;
      readonly clock: (
        executionId: ExecutionId,
        deferredName: string,
        at: number,
      ) => Effect.Effect<void>;
    };
  }
>()("automations/AutomationHost") {}
