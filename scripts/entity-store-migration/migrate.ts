/**
 * Copies automations' entity types, entities and roles into entity-store. Dry run by default:
 *
 *   bun scripts/entity-store-migration/migrate.ts --source <export.json | d1:<account>/<database>> \
 *     --target <entity-store URL> [--apply]
 *
 * The source is automations' D1: a JSON export, or the database itself through Cloudflare's D1
 * API with `CLOUDFLARE_API_TOKEN` (read-only queries). The target is entity-store's HTTP API; a
 * deployed one sits behind Access, so set `ENTITY_STORE_ACCESS_CLIENT_ID` and
 * `ENTITY_STORE_ACCESS_CLIENT_SECRET` to its service token. Without `--apply` it prints what it
 * would write and changes nothing. It stops at the first failed write; running it again repeats
 * the writes, which is safe. automations' own tables are left as they are.
 *
 * An export is `{ "entity_types": [{ "definition" }], "entities": [{ "type", "id", "data" }],
 * "roles": [{ "definition" }] }`, with `definition` and `data` as the JSON strings D1 holds.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { messageOf } from "../../src/error.ts";
import { TypeInfo, TypeSummary } from "../../src/entities/entity-store-api.ts";
import { EntityData, EntityType, Role } from "../../src/entities/model.ts";
import { MIGRATION_META, planMigration, type Source, type Step } from "./plan.ts";

class MigrationError extends Schema.TaggedError<MigrationError>()("MigrationError", {
  message: Schema.String,
}) {}
const fail = (message: string) => new MigrationError({ message });

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

/** entity-store's HTTP API, failing with the `{ error, code }` it returns. */
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
  return <A>(method: string, path: string, schema: Schema.Codec<A, unknown>, body?: unknown) =>
    fetchJson(`${method} ${path}`, new URL(path, origin).toString(), {
      method,
      headers: { ...access, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).pipe(
      Effect.flatMap(({ ok, status, json }) =>
        ok
          ? Schema.decodeUnknownEffect(schema)(json).pipe(
              Effect.mapError((error) => fail(`${method} ${path} answered ${error.message}`)),
            )
          : Effect.fail(fail(`${method} ${path} failed (${status}): ${JSON.stringify(json)}`)),
      ),
    );
});

const describe = (step: Step) =>
  step.kind === "createType"
    ? `create type ${step.input.name}`
    : step.kind === "createVersion"
      ? `add a version of ${step.type}: ${step.lens.ops.map((op) => `${String(op["op"])} ${String(op["field"])}`).join(", ")}`
      : `write ${step.type} ${step.id}: ${Object.keys(step.patch).join(", ") || "(no values)"}`;

const program = Effect.gen(function* () {
  const source = argument("source");
  const target = argument("target");
  const apply = process.argv.includes("--apply");
  if (source === undefined || target === undefined) {
    return yield* fail(
      "Usage: migrate.ts --source <export.json | d1:<account>/<database>> --target <entity-store URL> [--apply]",
    );
  }
  const call = yield* makeTarget(target);
  const rows = yield* readSource(source);
  const { items } = yield* call(
    "GET",
    "/api/types",
    Schema.Struct({ items: Schema.Array(TypeSummary) }),
  );
  const existing = yield* Effect.forEach(items, (summary) =>
    call("GET", `/api/types/${summary.name}`, TypeInfo),
  );
  const plan = planMigration(rows, existing);
  yield* Console.log(
    `${rows.types.length} types, ${rows.entities.length} entities and ${rows.roles.length} roles; ${plan.steps.length} writes.`,
  );
  for (const note of plan.notes) yield* Console.log(`  note: ${note}`);
  if (plan.problems.length > 0) {
    return yield* fail(`Fix these in automations first:\n  ${plan.problems.join("\n  ")}`);
  }
  for (const step of plan.steps) {
    yield* Console.log(`${apply ? "" : "would "}${describe(step)}`);
    if (!apply) continue;
    if (step.kind === "createType") {
      yield* call("POST", "/api/types", Schema.Unknown, step.input);
    } else if (step.kind === "createVersion") {
      yield* call("POST", `/api/types/${step.type}/versions`, Schema.Unknown, {
        schema: step.schema,
        lens: step.lens,
        note: "Copied from automations",
      });
    } else {
      yield* call(
        "PUT",
        `/api/types/${step.type}/entities/${encodeURIComponent(step.id)}`,
        Schema.Unknown,
        { patch: step.patch, meta: MIGRATION_META },
      );
    }
  }
  yield* Console.log(apply ? "Done." : "Dry run: nothing was written. Add --apply to write.");
});

program.pipe(BunRuntime.runMain);
