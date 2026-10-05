import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AutomationsDatabase } from "./automation-index.ts";
import { EntityData, EntityType, type EntityRecord } from "./entities.ts";
import { EntityStore, EntityStoreError, makeEntityStore } from "./entity-store.ts";

/**
 * The `EntityStore` on D1, in the `entity_types`, `entities`, and `entity_subscriptions` tables
 * (see `migrations/`).
 */

const TypeRow = Schema.Struct({ definition: Schema.fromJsonString(EntityType) });
const EntityRow = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  data: Schema.fromJsonString(EntityData),
  updated_at: Schema.Finite,
});
const SubscriptionRow = Schema.Struct({ automation_id: Schema.String });

const toRecord = (row: typeof EntityRow.Type): EntityRecord => ({
  type: row.type,
  id: row.id,
  data: row.data,
  updatedAt: row.updated_at,
});

/**
 * Binds the database. Yield it in a Worker's or Durable Object's outer Effect; provide the layer
 * it returns where a `RuntimeContext` is available, per request or per instance.
 */
export const EntityStoreD1 = Effect.gen(function* () {
  const db = yield* Cloudflare.D1.QueryDatabase(AutomationsDatabase);

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
          Effect.catchCause((cause) =>
            Effect.fail(new EntityStoreError({ message: `${operation}: ${cause}` })),
          ),
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
              Schema.decodeUnknownEffect(Schema.Array(schema))(result.results ?? []),
            ),
          ),
        );

      return makeEntityStore({
        listTypes: rows(
          "listTypes",
          TypeRow,
          db.prepare("SELECT definition FROM entity_types ORDER BY name").all(),
        ).pipe(Effect.map((found) => found.map((row) => row.definition))),
        putType: (type) =>
          query(
            "putType",
            Effect.gen(function* () {
              const updatedAt = yield* Clock.currentTimeMillis;
              yield* db
                .prepare(
                  `INSERT INTO entity_types (name, definition, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT (name) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at`,
                )
                .bind(type.name, JSON.stringify(type), updatedAt)
                .run();
            }),
          ),
        deleteType: (name) =>
          query(
            "deleteType",
            db.prepare("DELETE FROM entity_types WHERE name = ?").bind(name).run(),
          ).pipe(Effect.asVoid),
        listEntities: (type) =>
          rows(
            "listEntities",
            EntityRow,
            db
              .prepare("SELECT type, id, data, updated_at FROM entities WHERE type = ? ORDER BY id")
              .bind(type)
              .all(),
          ).pipe(Effect.map((found) => found.map(toRecord))),
        getEntity: (type, id) =>
          rows(
            "getEntity",
            EntityRow,
            db
              .prepare("SELECT type, id, data, updated_at FROM entities WHERE type = ? AND id = ?")
              .bind(type, id)
              .all(),
          ).pipe(Effect.map(([row]) => (row === undefined ? undefined : toRecord(row)))),
        writeEntity: (record) =>
          query(
            "writeEntity",
            db
              .prepare(
                `INSERT INTO entities (type, id, data, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (type, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
              )
              .bind(record.type, record.id, JSON.stringify(record.data), record.updatedAt)
              .run(),
          ).pipe(Effect.asVoid),
        deleteEntity: (type, id) =>
          query(
            "deleteEntity",
            db.prepare("DELETE FROM entities WHERE type = ? AND id = ?").bind(type, id).run(),
          ).pipe(Effect.asVoid),
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
      });
    }),
  );
});
