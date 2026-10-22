/**
 * Copies automations' entity types, entities and roles into entity-store. Dry run by default:
 *
 *   bun scripts/entity-store-migration/migrate.ts --source <export.json | d1:<account>/<database>> \
 *     --target <entity-store URL> [--apply]
 *
 * The source is automations' D1: a JSON export, or the database itself through Cloudflare's D1
 * API with `CLOUDFLARE_API_TOKEN` (read-only queries). The target is entity-store's HTTP API; a
 * deployed one sits behind Access, so set `ENTITY_STORE_ACCESS_CLIENT_ID` and
 * `ENTITY_STORE_ACCESS_CLIENT_SECRET` to its service token.
 *
 * It first looks up every entity and role ID on the target (`GET /api/entities/:id`). entity-store's
 * IDs are unique across types, so an ID held there by another type, live or deleted, is a clash;
 * one held by the same type already exists and is left as it is. Without `--apply` it lists
 * clashes, entities that exist, the writes it would make, and every write the in-memory
 * entity-store refuses against the planned types, and changes nothing. With `--apply`, any clash
 * or refusal stops it before it creates or versions a single type, so it never leaves half a
 * copy; then it creates and versions the types, checks every entity write against entity-store
 * itself (`POST /api/types/:type/entities/:id/check`), and writes no entity unless all pass.
 * Entities and roles are only created (`expectedRev: 0`), never overwritten, so running it again
 * creates only what's missing. It stops at the first failed write. automations' own tables are
 * left as they are. The migration itself is in `run.ts`.
 *
 * An export is `{ "entity_types": [{ "definition" }], "entities": [{ "type", "id", "data" }],
 * "roles": [{ "definition" }] }`, with `definition` and `data` as the JSON strings D1 holds.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { messageOf } from "../../src/error.ts";
import { EntityData, EntityType, Role } from "../../src/entities/model.ts";
import type { Source } from "./plan.ts";
import { fail, migrate, Refusal, type Answer, type Target } from "./run.ts";

const Rows = Schema.Struct({
  entity_types: Schema.Array(Schema.Struct({ definition: Schema.fromJsonString(EntityType) })),
  entities: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      id: Schema.String,
      data: Schema.fromJsonString(EntityData),
    }),
  ),
  roles: Schema.Array(Schema.Struct({ definition: Schema.fromJsonString(Role) })),
});

const toSource = (rows: typeof Rows.Type): Source => ({
  types: rows.entity_types.map((row) => row.definition),
  entities: rows.entities,
  roles: rows.roles.map((row) => row.definition),
});

const argument = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const fetchJson = (label: string, url: string, init: RequestInit) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }),
      catch: (cause) => fail(`${label}: ${messageOf(cause)}`),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => fail(`${label}: ${messageOf(cause)}`),
    });
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => fail(`${label} answered ${response.status} with ${text.slice(0, 200)}`),
    });
    return { status: response.status, ok: response.ok, json };
  });

/** automations' rows through Cloudflare's D1 query API. */
const readD1 = Effect.fn("Migration.readD1")(function* (account: string, database: string) {
  const token = yield* Config.String("CLOUDFLARE_API_TOKEN").pipe(
    Effect.mapError(() => fail("Set CLOUDFLARE_API_TOKEN to read D1")),
  );
  const query = (sql: string) =>
    fetchJson(
      sql,
      `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ sql }),
      },
    ).pipe(
      Effect.flatMap(({ ok, json }) =>
        Schema.decodeUnknownEffect(
          Schema.Struct({
            result: Schema.Array(Schema.Struct({ results: Schema.Array(Schema.Unknown) })),
          }),
        )(json).pipe(
          Effect.mapError(() => fail(`${sql} failed: ${JSON.stringify(json).slice(0, 300)}`)),
          Effect.flatMap((decoded) =>
            ok
              ? Effect.succeed(decoded.result[0]?.results ?? [])
              : Effect.fail(fail(`${sql} failed`)),
          ),
        ),
      ),
    );
  return yield* Schema.decodeUnknownEffect(Rows)({
    entity_types: yield* query("SELECT definition FROM entity_types ORDER BY name"),
    entities: yield* query("SELECT type, id, data FROM entities ORDER BY type, id"),
    roles: yield* query("SELECT definition FROM roles ORDER BY name"),
  });
});

const readSource = Effect.fn("Migration.readSource")(function* (source: string) {
  const d1 = /^d1:([^/]+)\/(.+)$/.exec(source);
  if (d1 !== null) {
    return toSource(yield* readD1(d1[1] ?? "", d1[2] ?? ""));
  }
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(source).text(),
    catch: () => fail(`Can't read ${source}`),
  });
  return toSource(yield* Schema.decodeEffect(Schema.fromJsonString(Rows))(text));
});

/** entity-store's HTTP API: its answer, or the `{ code, error }` it refuses with. */
const makeTarget = Effect.fn("Migration.target")(function* (origin: string) {
  const clientId = yield* Config.option(Config.String("ENTITY_STORE_ACCESS_CLIENT_ID"));
  const clientSecret = yield* Config.option(Config.String("ENTITY_STORE_ACCESS_CLIENT_SECRET"));
  const access = Option.all({ clientId, clientSecret }).pipe(
    Option.map(({ clientId, clientSecret }) => ({
      "cf-access-client-id": clientId,
      "cf-access-client-secret": clientSecret,
    })),
    Option.getOrElse(() => ({})),
  );
  const target: Target = {
    attempt: <A>(method: string, path: string, schema: Schema.Codec<A, unknown>, body?: unknown) =>
      fetchJson(`${method} ${path}`, new URL(path, origin).toString(), {
        method,
        headers: {
          ...access,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).pipe(
        Effect.flatMap(({ ok, status, json }) =>
          ok
            ? Schema.decodeUnknownEffect(schema)(json).pipe(
                Effect.map((value): Answer<A> => ({ value, refused: undefined })),
                Effect.mapError((error) => fail(`${method} ${path} answered ${error.message}`)),
              )
            : Schema.decodeUnknownEffect(Refusal)(json).pipe(
                Effect.map((refused): Answer<A> => ({ value: undefined, refused })),
                Effect.mapError(() =>
                  fail(`${method} ${path} failed (${status}): ${JSON.stringify(json)}`),
                ),
              ),
        ),
      ),
  };
  return target;
});

const program = Effect.gen(function* () {
  const source = argument("source");
  const target = argument("target");
  if (source === undefined || target === undefined) {
    return yield* fail(
      "Usage: migrate.ts --source <export.json | d1:<account>/<database>> --target <entity-store URL> [--apply]",
    );
  }
  yield* migrate(
    yield* makeTarget(target),
    yield* readSource(source),
    process.argv.includes("--apply"),
  );
});

program.pipe(BunRuntime.runMain);
