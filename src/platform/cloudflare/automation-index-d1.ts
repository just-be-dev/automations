/** Implements the automation directory on D1, capturing the host runtime in each provided service layer. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AutomationSummary } from "../../automation/model.ts";
import { AutomationsDatabase } from "./database.ts";
import { failWith } from "./d1-failure.ts";
import { AutomationIndex, AutomationIndexError } from "../../automation/index.ts";

const Row = Schema.Struct({ id: Schema.String, name: Schema.String, updated_at: Schema.Finite });
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const upsert = `INSERT INTO automations (id, name, updated_at) VALUES (?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`;
const insertIfMissing = `INSERT INTO automations (id, name, updated_at) VALUES (?, ?, ?)
  ON CONFLICT (id) DO NOTHING RETURNING id`;
const selectAll = "SELECT id, name, updated_at FROM automations ORDER BY updated_at DESC";

/** Bind D1 in the outer Effect, then provide the layer per request or Durable Object instance. */
export const AutomationIndexD1 = Effect.gen(function* () {
  const db = yield* Cloudflare.D1.QueryDatabase(AutomationsDatabase);
  return Layer.effect(
    AutomationIndex,
    Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      // D1 reports failures as defects. The directory's callers can ignore or map this typed error.
      const indexOperation = <A, E>(
        operation: string,
        effect: Effect.Effect<A, E, Alchemy.RuntimeContext>,
      ) =>
        effect.pipe(
          Effect.provideService(Alchemy.RuntimeContext, runtime),
          failWith(operation, (message) => new AutomationIndexError({ message })),
        );

      // Says whether a row was inserted; only `insertIfMissing` returns one.
      const write = (operation: string, statement: string, id: string, name: string) =>
        indexOperation(
          operation,
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((updatedAt) => db.prepare(statement).bind(id, name, updatedAt).all()),
            Effect.map((result) => (result.results ?? []).length > 0),
          ),
        );

      const create = Effect.fn("AutomationIndex.create")(function* (id: string, name: string) {
        return yield* write("create", insertIfMissing, id, name);
      });

      const record = Effect.fn("AutomationIndex.record")(function* (id: string, name: string) {
        yield* write("record", upsert, id, name);
      });

      // Adds automations created before the index without moving them up the list.
      const recordIfMissing = Effect.fn("AutomationIndex.recordIfMissing")(function* (
        id: string,
        name: string,
      ) {
        yield* write("recordIfMissing", insertIfMissing, id, name);
      });

      const list = Effect.fn("AutomationIndex.list")(function* () {
        const result = yield* indexOperation("list", db.prepare(selectAll).all());
        const rows = yield* indexOperation("list", decodeRows(result.results ?? []));
        return rows.map((row): AutomationSummary => ({
          id: row.id,
          name: row.name,
          updatedAt: row.updated_at,
        }));
      });

      return AutomationIndex.of({ create, record, recordIfMissing, list: list() });
    }),
  );
});
