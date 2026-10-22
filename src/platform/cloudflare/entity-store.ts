/**
 * The entity store on Cloudflare: entity types, entities and roles in entity-store, reached over a
 * service binding to its `EntityStoreRpc` entrypoint, and templates and trigger subscriptions in
 * automations' D1. Also the queue of entity-store's changes, which the Api consumes.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AutomationsDatabase } from "./database.ts";
import { failWith } from "./d1-failure.ts";
import { makeEntityStoreApi, type EntityStoreRpc } from "../../entities/entity-store-api.ts";
import {
  EntityStore,
  EntityStoreError,
  makeEntityStore,
  type TypeCache,
} from "../../entities/store.ts";
import { Template } from "../../entities/templates.ts";

/**
 * The Alchemy stack that owns entity-store. A constant, because the queue ref below must be built
 * the same way at plan time and at cold start, where no configuration is read.
 */
export const ENTITY_STORE_STACK = "entity-store";
const BINDING = "ENTITY_STORE";

/**
 * Binds entity-store's API Worker, by its `EntityStoreRpc` entrypoint, in the same stage. Having
 * the binding is the authorization: the entrypoint isn't routed publicly. Alchemy's typed service
 * bindings don't take a Worker from another stack, so this registers the raw binding, as Alchemy's
 * own bindings do. Yield it in an outer Effect; the accessor it returns reads the binding when
 * called, per request or instance.
 */
export const EntityStoreRpcBinding = Effect.gen(function* () {
  const env = yield* Cloudflare.WorkerEnvironment;
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const api = yield* Cloudflare.Worker.ref("Api", { stack: ENTITY_STORE_STACK });
    yield* (yield* Cloudflare.Worker).bind`${BINDING}`({
      bindings: [
        { type: "service", name: BINDING, service: api.workerName, entrypoint: "EntityStoreRpc" },
      ],
    });
  }
  // @effect-diagnostics-next-line returnEffectInGen:off
  return Effect.sync((): EntityStoreRpc => {
    const stub = (env as Record<string, unknown>)[BINDING] as
      | Record<string, (...args: ReadonlyArray<unknown>) => Promise<unknown>>
      | undefined;
    const method =
      (name: keyof EntityStoreRpc) =>
      (...args: ReadonlyArray<unknown>) => {
        const call = stub?.[name];
        return call === undefined
          ? Promise.reject(new Error("entity-store isn't bound to this Worker"))
          : // A method read off an RPC stub must be called on the stub.
            Promise.resolve(Reflect.apply(call, stub, args));
      };
    return {
      listTypes: method("listTypes"),
      getType: method("getType"),
      createType: method("createType"),
      checkVersion: method("checkVersion"),
      createVersion: method("createVersion"),
      deleteType: method("deleteType"),
      listEntities: method("listEntities"),
      getEntity: method("getEntity"),
      upsertEntity: method("upsertEntity"),
      deleteEntity: method("deleteEntity"),
      getChange: method("getChange"),
    };
  });
});

/**
 * entity-store's change queue. Deployed, it is entity-store's own queue, by reference. Under
 * `alchemy dev` a reference can't reach a queue another `alchemy dev` serves, so this declares a
 * local queue with the same name; entity-store's local producer delivers to whichever process
 * consumes that name. Props are read at plan time only: cold start has no stage.
 */
export const EntityStoreChangesQueue = (local: boolean) =>
  local
    ? Cloudflare.Queues.Queue(
        "EntityStoreChanges",
        globalThis.__ALCHEMY_RUNTIME__
          ? Effect.succeed({})
          : Effect.map(Alchemy.Stage, (stage) => ({ name: `entity-store-${stage}-changes` })),
      )
    : Cloudflare.Queues.Queue.ref("Changes", { stack: ENTITY_STORE_STACK });

const TemplateRow = Schema.Struct({ definition: Schema.fromJsonString(Template) });
const SubscriptionRow = Schema.Struct({ automation_id: Schema.String });

/**
 * Binds the database and entity-store. Yield it in a Worker's or Durable Object's outer Effect;
 * provide the layer it returns where a `RuntimeContext` is available, per request or per instance.
 */
export const EntityStoreLive = Effect.gen(function* () {
  const db = yield* Cloudflare.D1.QueryDatabase(AutomationsDatabase);
  const rpc = yield* EntityStoreRpcBinding;
  // Shared by every request this isolate serves; type versions never change.
  const cache: TypeCache = new Map();

  return Layer.effect(
    EntityStore,
    Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;

      // D1 executors report failures as defects, so give them a typed error callers can map.
      const query = <A, E>(
        operation: string,
        effect: Effect.Effect<A, E, Alchemy.RuntimeContext>,
      ): Effect.Effect<A, EntityStoreError> =>
        effect.pipe(
          Effect.provideService(Alchemy.RuntimeContext, runtime),
          failWith(operation, (message) => new EntityStoreError({ message })),
        );

      const rows = <A>(
        operation: string,
        schema: Schema.Codec<A, unknown>,
        statement: Effect.Effect<
          { readonly results?: ReadonlyArray<unknown> },
          never,
          Alchemy.RuntimeContext
        >,
      ) =>
        query(
          operation,
          statement.pipe(
            Effect.flatMap((result) =>
              Schema.decodeEffect(Schema.Array(schema))(result.results ?? []),
            ),
          ),
        );

      const api = makeEntityStoreApi(
        yield* rpc.pipe(Effect.provideService(Alchemy.RuntimeContext, runtime)),
      );

      return makeEntityStore(
        api,
        {
          subscribe: (automationId, type) =>
            query(
              "subscribe",
              type === undefined
                ? db
                    .prepare("DELETE FROM entity_subscriptions WHERE automation_id = ?")
                    .bind(automationId)
                    .run()
                : db
                    .prepare(
                      `INSERT INTO entity_subscriptions (automation_id, entity_type) VALUES (?, ?)
                       ON CONFLICT (automation_id) DO UPDATE SET entity_type = excluded.entity_type`,
                    )
                    .bind(automationId, type)
                    .run(),
            ).pipe(Effect.asVoid),
          subscribers: (type) =>
            rows(
              "subscribers",
              SubscriptionRow,
              db
                .prepare("SELECT automation_id FROM entity_subscriptions WHERE entity_type = ?")
                .bind(type)
                .all(),
            ).pipe(Effect.map((found) => found.map((row) => row.automation_id))),
          listTemplates: rows(
            "listTemplates",
            TemplateRow,
            db.prepare("SELECT definition FROM templates ORDER BY name").all(),
          ).pipe(Effect.map((found) => found.map((row) => row.definition))),
          writeTemplate: (template) =>
            query(
              "writeTemplate",
              Effect.gen(function* () {
                const updatedAt = yield* Clock.currentTimeMillis;
                yield* db
                  .prepare(
                    `INSERT INTO templates (name, definition, updated_at) VALUES (?, ?, ?)
                     ON CONFLICT (name) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at`,
                  )
                  .bind(template.name, JSON.stringify(template), updatedAt)
                  .run();
              }),
            ),
          deleteTemplate: (name) =>
            query(
              "deleteTemplate",
              db.prepare("DELETE FROM templates WHERE name = ?").bind(name).run(),
            ).pipe(Effect.asVoid),
        },
        cache,
      );
    }),
  );
});
