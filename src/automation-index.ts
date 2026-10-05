import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AutomationSummary } from "./workflow.ts";

/**
 * The list of automations. Cloudflare can't enumerate Durable Object names, so the Api Worker
 * records each automation here when it is drafted or saved. The schema lives in `migrations/`.
 */
export const AutomationsDatabase = Cloudflare.D1.Database("AutomationsDatabase", {
  migrations: "./migrations",
});

export class AutomationIndexError extends Schema.TaggedError<AutomationIndexError>()(
  "AutomationIndexError",
  { message: Schema.String },
) {}

const Row = Schema.Struct({ id: Schema.String, name: Schema.String, updated_at: Schema.Finite });
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

// D1 executors report failures as defects, so give them a typed error the caller can ignore or map.
const indexOperation = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  Effect.catchCause(effect, (cause) =>
    Effect.fail(new AutomationIndexError({ message: `${operation}: ${cause}` })),
  );

const upsert = `INSERT INTO automations (id, name, updated_at) VALUES (?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`;
const insertIfMissing = `INSERT INTO automations (id, name, updated_at) VALUES (?, ?, ?)
  ON CONFLICT (id) DO NOTHING`;
const selectAll = "SELECT id, name, updated_at FROM automations ORDER BY updated_at DESC";

/** Binds the database. Call it in a Worker's outer Effect; the returned operations run per request. */
export const openAutomationIndex = Effect.gen(function* () {
  const db = yield* Cloudflare.D1.QueryDatabase(AutomationsDatabase);

  const write = (operation: string, statement: string, id: string, name: string) =>
    indexOperation(
      operation,
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((updatedAt) => db.prepare(statement).bind(id, name, updatedAt).run()),
        Effect.asVoid,
      ),
    );

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

  return { record, recordIfMissing, list };
});
