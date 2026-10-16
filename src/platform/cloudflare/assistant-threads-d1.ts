/** Implements the studio agent's thread directory on D1, capturing the host runtime in each provided layer. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  type AssistantThread,
  AssistantThreads,
  AssistantThreadsError,
} from "../../assistant/threads.ts";
import { failWith } from "./d1-failure.ts";
import { AutomationsDatabase } from "./database.ts";

const Row = Schema.Struct({
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
  archived: Schema.Finite,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const touch = `INSERT INTO assistant_threads (owner, id, title, created_at, updated_at, archived)
  VALUES (?, ?, NULL, ?, ?, 0)
  ON CONFLICT (owner, id) DO UPDATE SET updated_at = excluded.updated_at, archived = 0`;
const rename = "UPDATE assistant_threads SET title = ? WHERE owner = ? AND id = ?";
const archive = "UPDATE assistant_threads SET archived = ? WHERE owner = ? AND id = ?";
const remove = "DELETE FROM assistant_threads WHERE owner = ? AND id = ?";
const list = `SELECT id, title, created_at, updated_at, archived FROM assistant_threads
  WHERE owner = ? ORDER BY updated_at DESC`;

/** Bind D1 in the outer Effect, then provide the layer per request or Durable Object instance. */
export const AssistantThreadsD1 = Effect.gen(function* () {
  const db = yield* Cloudflare.D1.QueryDatabase(AutomationsDatabase);
  return Layer.effect(
    AssistantThreads,
    Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      const operation = <A, E>(name: string, effect: Effect.Effect<A, E, Alchemy.RuntimeContext>) =>
        effect.pipe(
          Effect.provideService(Alchemy.RuntimeContext, runtime),
          failWith(name, (message) => new AssistantThreadsError({ message })),
        );
      return AssistantThreads.of({
        touch: Effect.fn("AssistantThreads.touch")(function* (owner: string, id: string) {
          const now = yield* Clock.currentTimeMillis;
          yield* operation("touch", db.prepare(touch).bind(owner, id, now, now).run());
        }),
        rename: Effect.fn("AssistantThreads.rename")(function* (
          owner: string,
          id: string,
          title: string | undefined,
        ) {
          yield* operation(
            "rename",
            db
              .prepare(rename)
              .bind(title ?? null, owner, id)
              .run(),
          );
        }),
        archive: Effect.fn("AssistantThreads.archive")(function* (
          owner: string,
          id: string,
          archived: boolean,
        ) {
          yield* operation(
            "archive",
            db
              .prepare(archive)
              .bind(archived ? 1 : 0, owner, id)
              .run(),
          );
        }),
        remove: Effect.fn("AssistantThreads.remove")(function* (owner: string, id: string) {
          yield* operation("remove", db.prepare(remove).bind(owner, id).run());
        }),
        list: Effect.fn("AssistantThreads.list")(function* (owner: string) {
          const result = yield* operation("list", db.prepare(list).bind(owner).all());
          const rows = yield* operation("list", decodeRows(result.results ?? []));
          return rows.map((row): AssistantThread => ({
            id: row.id,
            ...(row.title === null ? {} : { title: row.title }),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            archived: row.archived !== 0,
          }));
        }),
      });
    }),
  );
});
