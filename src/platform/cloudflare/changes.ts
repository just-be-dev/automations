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
import { EventsQueue } from "./events.ts";
import { EntityPut, Event } from "../../events/model.ts";
import { Events, EventError } from "../../events/service.ts";

export default class ChangeCoordinator extends Cloudflare.DurableObject<ChangeCoordinator>()(
  "ChangeCoordinator",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const namespace = yield* Automation;
    const index = yield* AutomationIndexD1;
    const entities = yield* EntityStoreD1;
    const events = yield* EventsQueue;
    const automations = automationsLayer(namespace);
    const subscribers = Layer.unwrap(
      Automations.use((service) =>
        Effect.succeed(
          EntitySubscribers.layer((id, change, key, event) =>
            service.get(id).entityChanged(change.before, change.after, key, event),
          ),
        ),
      ),
    ).pipe(Layer.provideMerge(Layer.merge(entities, automations)));

    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      const remote = <A, E, R>(effect: Effect.Effect<A, E, R | Alchemy.RuntimeContext>) =>
        Effect.provideService(effect, Alchemy.RuntimeContext, runtime);
      const publisher = yield* Events;
      const changes = yield* makeChanges(
        {
          get: (key) => remote(state.storage.get(key)),
          put: (key, value) => remote(state.storage.put(key, value)),
          list: (prefix) =>
            remote(state.storage.list({ prefix })).pipe(
              Effect.map((values) => [...values.values()]),
            ),
          transaction: (effect) => remote(state.storage.transaction(effect)),
        },
        publisher,
      );
      return {
        applyEvent: Effect.fn("Changes.applyEvent")(function* (input: unknown) {
          const event = yield* Schema.decodeUnknownEffect(Event)(input);
          if (event.name !== "entity.put" || event.depth === 16) {
            return yield* new EventError({ message: "Not an accepted entity command" });
          }
          const command = yield* Schema.decodeUnknownEffect(EntityPut)(event.data);
          const owner = `event:${event.id}`;
          const proposal = yield* changes.prepare(
            owner,
            { kind: "putEntity", ...command },
            event.id,
            event,
          );
          yield* changes.decide(owner, proposal.id, true);
        }),
        prepare: (owner: string, action: unknown, requestId?: string) =>
          Schema.decodeUnknownEffect(ChangeAction)(action).pipe(
            Effect.flatMap((decoded) => changes.prepare(owner, decoded, requestId)),
          ),
        decide: (owner: string, proposalId: string, approved: boolean) =>
          changes.decide(owner, proposalId, approved),
      };
    }).pipe(Effect.provide(Layer.mergeAll(index, subscribers, events)));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Queues.WriteQueueBinding,
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
        prepare: (owner, action, requestId) => remote(stub.prepare(owner, action, requestId)),
        decide: (...args) => remote(stub.decide(...args)),
      });
    }),
  );
