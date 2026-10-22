/**
 * A stand-in for entity-store under `alchemy dev`: one Durable Object runs the in-memory
 * entity-store behind the same RPC methods, keeps it in its storage, and sends each committed
 * change to a local queue the Api consumes, as entity-store's change queue does. A reference to
 * another stack resolves through this stack's own Alchemy state, so `alchemy dev` can't bind a
 * real entity-store from another checkout. Deployed stages never bind this object.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { EntityStoreRpc, WriteMeta } from "../../entities/entity-store-api.ts";
import { FakeState, makeFakeEntityStore } from "../../entities/entity-store-fake.ts";

/** The local change queue: what entity-store's `Changes` queue is to a deployed stage. */
export const LocalEntityStoreChanges = Cloudflare.Queues.Queue("EntityStoreChanges");

/** The store and how far its change log has been sent to the queue. */
const Saved = Schema.Struct({ state: FakeState, sent: Schema.Int });
const KEY = "entity-store";

export default class EntityStoreDev extends Cloudflare.DurableObject<EntityStoreDev>()(
  "EntityStoreDev",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const queue = yield* Cloudflare.Queues.WriteQueue(yield* LocalEntityStoreChanges);

    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      const remote = <A, E, R>(effect: Effect.Effect<A, E, R | Alchemy.RuntimeContext>) =>
        Effect.provideService(effect, Alchemy.RuntimeContext, runtime);
      const saved = yield* remote(state.storage.get(KEY)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.UndefinedOr(Saved))),
        Effect.orDie,
      );
      const store = makeFakeEntityStore({
        ...(saved === undefined ? {} : { state: saved.state }),
        now: Date.now,
      });
      let sent = saved?.sent ?? 0;

      /**
       * Answers a call, then saves the store and sends what it hasn't sent yet. A send that fails
       * is sent again after the next call, so delivery is at least once, as entity-store's is.
       */
      const call = <A extends ReadonlyArray<unknown>>(
        invoke: (...args: A) => Promise<unknown>,
        writes: boolean,
      ) =>
        Effect.fn(function* (...args: A) {
          const result = yield* Effect.promise(() => invoke(...args));
          if (writes) {
            const pending = store.changes().filter((change) => change.seq > sent);
            yield* remote(state.storage.put(KEY, { state: store.snapshot(), sent }));
            for (const change of pending) {
              yield* remote(queue.send(change)).pipe(Effect.orDie);
              sent = change.seq;
            }
            yield* remote(state.storage.put(KEY, { state: store.snapshot(), sent }));
          }
          return result;
        });

      return {
        listTypes: call(() => store.listTypes(), false),
        getType: call((name: string) => store.getType(name), false),
        createType: call(
          (input: Parameters<EntityStoreRpc["createType"]>[0]) => store.createType(input),
          true,
        ),
        checkVersion: call(
          (type: string, input: Parameters<EntityStoreRpc["checkVersion"]>[1]) =>
            store.checkVersion(type, input),
          false,
        ),
        createVersion: call(
          (type: string, input: Parameters<EntityStoreRpc["createVersion"]>[1]) =>
            store.createVersion(type, input),
          true,
        ),
        deleteType: call((name: string) => store.deleteType(name), true),
        listEntities: call(
          (type: string, options?: Parameters<EntityStoreRpc["listEntities"]>[1]) =>
            store.listEntities(type, options),
          false,
        ),
        getEntity: call((id: string) => store.getEntity(id), false),
        upsertEntity: call(
          (type: string, id: string, input: Parameters<EntityStoreRpc["upsertEntity"]>[2]) =>
            store.upsertEntity(type, id, input),
          true,
        ),
        deleteEntity: call(
          (id: string, options?: { readonly expectedRev?: number; readonly meta?: WriteMeta }) =>
            store.deleteEntity(id, options),
          true,
        ),
        getChange: call((id: string, rev: number) => store.getChange(id, rev), false),
        checkEntity: call(
          (type: string, id: string, input: Parameters<EntityStoreRpc["checkEntity"]>[2]) =>
            store.checkEntity(type, id, input),
          false,
        ),
        getBacklinks: call(
          (id: string, options?: Parameters<EntityStoreRpc["getBacklinks"]>[1]) =>
            store.getBacklinks(id, options),
          false,
        ),
      };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
) {}
