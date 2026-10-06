/** Notifies automations watching an entity change and returns each started run or failure to the writer. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { messageOf } from "../error.ts";
import { EntityStore, type EntityChange, type EntityStoreError } from "./store.ts";

/** A run an entity write started, or why an automation watching the type couldn't start one. */
export const Triggered = Schema.Struct({
  automation: Schema.String,
  runId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type Triggered = typeof Triggered.Type;

/** Shared by HTTP and MCP writes; the host supplies how to notify one automation. */
export class EntitySubscribers extends Context.Service<
  EntitySubscribers,
  {
    readonly notify: (
      change: EntityChange,
    ) => Effect.Effect<ReadonlyArray<Triggered>, EntityStoreError>;
  }
>()("automations/EntitySubscribers") {
  static readonly layer = (
    notify: (
      automationId: string,
      change: EntityChange,
    ) => Effect.Effect<{ readonly runId: string | null }, unknown>,
  ) =>
    Layer.effect(
      EntitySubscribers,
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        return EntitySubscribers.of({
          notify: Effect.fn("Api.notifySubscribers")(function* (change: EntityChange) {
            const subscribers = yield* entities.subscribers(change.after.type);
            return yield* Effect.forEach(subscribers, (automationId) =>
              notify(automationId, change).pipe(
                Effect.map(({ runId }) => ({ automation: automationId, runId, error: null })),
                Effect.catch((error: unknown) =>
                  Effect.succeed({
                    automation: automationId,
                    runId: null,
                    error: messageOf(error),
                  }),
                ),
              ),
            );
          }),
        });
      }),
    );
}
