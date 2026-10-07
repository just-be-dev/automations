/** One tenant-wide Durable Object serializes confirmed mutations and persists their receipts. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Automations } from "../../automation/service.ts";
import { makeChanges } from "../../changes/application.ts";
import { ChangeAction } from "../../changes/model.ts";
import { Changes } from "../../changes/service.ts";
import { EntitySubscribers } from "../../entities/subscribers.ts";
import Automation from "./automation.ts";
import { automationsLayer } from "./automations.ts";
import { AutomationIndexD1 } from "./automation-index-d1.ts";
import { EntityStoreD1 } from "./entity-store-d1.ts";

export default class ChangeCoordinator extends Cloudflare.DurableObject<ChangeCoordinator>()(
  "ChangeCoordinator",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const namespace = yield* Automation;
    const index = yield* AutomationIndexD1;
    const entities = yield* EntityStoreD1;
    const automations = automationsLayer(namespace);
    const subscribers = Layer.unwrap(
      Automations.use((service) =>
        Effect.succeed(
          EntitySubscribers.layer((id, change, key) =>
            service.get(id).entityChanged(change.before, change.after, key),
          ),
        ),
      ),
    ).pipe(Layer.provideMerge(Layer.merge(entities, automations)));

    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      const remote = <A, E, R>(effect: Effect.Effect<A, E, R | Alchemy.RuntimeContext>) =>
        Effect.provideService(effect, Alchemy.RuntimeContext, runtime);
      const changes = yield* makeChanges({
        get: (key) => remote(state.storage.get(key)),
        put: (key, value) => remote(state.storage.put(key, value)),
        list: (prefix) =>
          remote(state.storage.list({ prefix })).pipe(Effect.map((values) => [...values.values()])),
        transaction: (effect) => remote(state.storage.transaction(effect)),
      });
      return {
        prepare: (owner: string, action: unknown, requestId?: string) =>
          Schema.decodeUnknownEffect(ChangeAction)(action).pipe(
            Effect.flatMap((decoded) => changes.prepare(owner, decoded, requestId)),
          ),
        decide: (owner: string, proposalId: string, approved: boolean) =>
          changes.decide(owner, proposalId, approved),
      };
    }).pipe(Effect.provide(Layer.merge(index, subscribers)));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
) {}

export const changesLayer = (namespace: Effect.Success<typeof ChangeCoordinator>) =>
  Layer.effect(
    Changes,
    Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      const stub = namespace.getByName("studio");
      const remote = <A, E>(effect: Effect.Effect<A, E, Alchemy.RuntimeContext>) =>
        Effect.provideService(effect, Alchemy.RuntimeContext, runtime);
      return Changes.of({
        prepare: (...args) => remote(stub.prepare(...args)),
        decide: (...args) => remote(stub.decide(...args)),
      });
    }),
  );
