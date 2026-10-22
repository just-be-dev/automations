/** One tenant-wide Durable Object serializes confirmed mutations and persists their receipts. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { makeChanges } from "../../changes/application.ts";
import { ChangeAction } from "../../changes/model.ts";
import { Changes } from "../../changes/service.ts";
import Automation from "./automation.ts";
import { automationsLayer } from "./automations.ts";
import { AutomationIndexD1 } from "./automation-index-d1.ts";
import { EntityStoreLive } from "./entity-store.ts";
import { EntityPut, Event, MAX_EVENT_DEPTH } from "../../events/model.ts";
import { EventError } from "../../events/service.ts";

export default class ChangeCoordinator extends Cloudflare.DurableObject<ChangeCoordinator>()(
  "ChangeCoordinator",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const namespace = yield* Automation;
    const index = yield* AutomationIndexD1;
    const entities = yield* EntityStoreLive;
    const automations = automationsLayer(namespace);

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
        applyEvent: Effect.fn("Changes.applyEvent")(function* (input: unknown) {
          const event = yield* Schema.decodeUnknownEffect(Event)(input);
          if (event.name !== "entity.put" || event.depth >= MAX_EVENT_DEPTH) {
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
          const receipt = yield* changes.decide(owner, proposal.id, true);
          // A command entity-store refused can't apply; fail so the queue retries it into the
          // dead letters, as it does a command that fails its checks when prepared.
          if (receipt.status !== "applied") {
            const refused = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))(
              receipt.result,
            );
            return yield* new EventError({
              message: refused._tag === "Some" ? refused.value.error : "The command was refused",
            });
          }
        }),
        prepare: (owner: string, action: unknown, requestId?: string) =>
          Schema.decodeUnknownEffect(ChangeAction)(action).pipe(
            Effect.flatMap((decoded) => changes.prepare(owner, decoded, requestId)),
          ),
        decide: (owner: string, proposalId: string, approved: boolean) =>
          changes.decide(owner, proposalId, approved),
      };
    }).pipe(Effect.provide(Layer.mergeAll(index, entities, automations)));
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
        prepare: (owner, action, requestId) => remote(stub.prepare(owner, action, requestId)),
        decide: (...args) => remote(stub.decide(...args)),
      });
    }),
  );
