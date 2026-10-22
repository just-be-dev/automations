/**
 * The entity store on Cloudflare: entity types, entities and roles in entity-store, reached over a
 * service binding to its API Worker's default entrypoint, and templates and trigger subscriptions
 * in automations' D1. Also the queue of entity-store's changes, which the Api consumes. Under
 * `alchemy dev` a local stand-in (`entity-store-dev.ts`) takes entity-store's place.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AutomationsDatabase } from "./database.ts";
import { failWith } from "./d1-failure.ts";
import EntityStoreDev, { LocalEntityStoreChanges } from "./entity-store-dev.ts";
import { localDevelopment } from "./local-development.ts";
import {
  EntityStoreApi,
  makeEntityStoreApi,
  type EntityStoreRpc,
} from "../../entities/entity-store-api.ts";
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

/** An `EntityStoreRpc` whose every method calls `invoke` with its name and arguments. */
const rpcOf = (
  invoke: (method: keyof EntityStoreRpc, args: ReadonlyArray<unknown>) => Promise<unknown>,
): EntityStoreRpc => ({
  listTypes: () => invoke("listTypes", []),
  getType: (...args) => invoke("getType", args),
  createType: (...args) => invoke("createType", args),
  checkVersion: (...args) => invoke("checkVersion", args),
  createVersion: (...args) => invoke("createVersion", args),
  deleteType: (...args) => invoke("deleteType", args),
  listEntities: (...args) => invoke("listEntities", args),
  getEntity: (...args) => invoke("getEntity", args),
  upsertEntity: (...args) => invoke("upsertEntity", args),
  deleteEntity: (...args) => invoke("deleteEntity", args),
  getChange: (...args) => invoke("getChange", args),
});

/**
 * Binds entity-store's API Worker in the same stage. Its RPC methods are on the default
 * entrypoint, which isn't routed publicly: having the binding is the authorization. Alchemy's
 * typed service bindings don't take a Worker from another stack, so this registers the raw
 * binding, as Alchemy's own bindings do. The methods never throw for a domain error; they answer
 * with a `Result`, which `EntityStoreApi` decodes.
 */
const deployedRpc = Effect.gen(function* () {
  const env: Record<string, unknown> = yield* Cloudflare.WorkerEnvironment;
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const api = yield* Cloudflare.Worker.ref("Api", { stack: ENTITY_STORE_STACK });
    yield* (yield* Cloudflare.Worker).bind`${BINDING}`({
      bindings: [{ type: "service", name: BINDING, service: api.workerName }],
    });
  }
  return (_runtime: Alchemy.RuntimeContext["Service"]): EntityStoreRpc =>
    rpcOf((method, args) => {
      const stub = env[BINDING];
      const call: unknown =
        typeof stub === "object" && stub !== null ? Reflect.get(stub, method) : undefined;
      return typeof call === "function"
        ? // A method read off an RPC stub must be called on the stub.
          Promise.resolve(Reflect.apply(call, stub, args))
        : Promise.reject(new Error("entity-store isn't bound to this Worker"));
    });
});

/** The local stand-in, one object for the whole studio. */
const localRpc = Effect.gen(function* () {
  const namespace = yield* EntityStoreDev;
  return (runtime: Alchemy.RuntimeContext["Service"]): EntityStoreRpc => {
    const stub = namespace.getByName("local");
    const run = (effect: Effect.Effect<unknown, unknown, Alchemy.RuntimeContext>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(Alchemy.RuntimeContext, runtime)));
    return {
      listTypes: () => run(stub.listTypes()),
      getType: (name) => run(stub.getType(name)),
      createType: (input) => run(stub.createType(input)),
      checkVersion: (type, input) => run(stub.checkVersion(type, input)),
      createVersion: (type, input) => run(stub.createVersion(type, input)),
      deleteType: (name) => run(stub.deleteType(name)),
      listEntities: (type, options) => run(stub.listEntities(type, options)),
      getEntity: (id) => run(stub.getEntity(id)),
      upsertEntity: (type, id, input) => run(stub.upsertEntity(type, id, input)),
      deleteEntity: (id, options) => run(stub.deleteEntity(id, options)),
      getChange: (id, rev) => run(stub.getChange(id, rev)),
    };
  };
});

/**
 * entity-store's change queue. Deployed, it is entity-store's own queue, by reference. Under
 * `alchemy dev` it is the local stand-in's queue.
 */
export const EntityStoreChangesQueue = (local: boolean) =>
  local
    ? LocalEntityStoreChanges
    : Cloudflare.Queues.Queue.ref("Changes", { stack: ENTITY_STORE_STACK });

const TemplateRow = Schema.Struct({ definition: Schema.fromJsonString(Template) });
const SubscriptionRow = Schema.Struct({ automation_id: Schema.String });

/**
 * Binds the database and entity-store. Yield it in a Worker's or Durable Object's outer Effect;
 * provide the layer it returns where a `RuntimeContext` is available, per request or per instance.
 * The layer provides `EntityStore`, and `EntityStoreApi` for what must reach entity-store itself.
 */
export const EntityStoreLive = Effect.gen(function* () {
  const db = yield* Cloudflare.D1.QueryDatabase(AutomationsDatabase);
  const rpc = (yield* localDevelopment) ? yield* localRpc : yield* deployedRpc;
  // Shared by every request this isolate serves; type versions never change.
  const cache: TypeCache = new Map();

  const api = Layer.effect(
    EntityStoreApi,
    Effect.gen(function* () {
      return makeEntityStoreApi(rpc(yield* Alchemy.RuntimeContext));
    }),
  );
  const store = Layer.effect(
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

      return makeEntityStore(
        yield* EntityStoreApi,
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
  return store.pipe(Layer.provideMerge(api));
});
