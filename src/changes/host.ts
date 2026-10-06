import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

/** One persistent coordinator per tenant. Transactions only cover this storage, not EntityStore.
 * The host must route every Changes call to the same live instance (or serialize them externally).
 */
export interface ChangeStorage {
  readonly get: (key: string) => Effect.Effect<unknown | undefined, unknown>;
  /** Each put is atomic and durable before its Effect succeeds. */
  readonly put: (key: string, value: Schema.Json) => Effect.Effect<void, unknown>;
  /** Values (not keys) whose storage keys begin with prefix. */
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  /** Commit all coordinator writes together, or roll them back on failure/interruption. */
  readonly transaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | unknown>;
}
