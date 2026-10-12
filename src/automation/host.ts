/** Defines host persistence and durable jobs, which must commit or roll back in the same transaction. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ExecutionId } from "../workflow/execution.ts";

/** Decodes a stored value, or `undefined` when it is absent. One that doesn't decode is a defect. */
export const decodeStored = <A, I>(schema: Schema.Codec<A, I>) => {
  const decode = Schema.decodeUnknownEffect(Schema.UndefinedOr(schema));
  return (value: unknown) => decode(value).pipe(Effect.orDie);
};

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
      readonly planReply: (automationId: string, chatId: string) => Effect.Effect<void>;
      readonly advance: (executionId: ExecutionId) => Effect.Effect<void>;
      readonly clock: (
        executionId: ExecutionId,
        deferredName: string,
        at: number,
      ) => Effect.Effect<void>;
      /** Delivers the saved schedule's occurrence at `at`, replacing any pending one. */
      readonly tick: (at: number) => Effect.Effect<void>;
      /** Cancels the pending occurrence, if there is one. */
      readonly cancelTick: Effect.Effect<void>;
    };
  }
>()("automations/AutomationHost") {}
