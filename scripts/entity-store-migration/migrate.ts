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
 * Without `--apply` it prints what it would write, checks every entity write against the planned
 * types in an in-memory entity-store, lists every failure, and changes nothing. With `--apply` it
 * creates and versions the types, checks every entity write against entity-store itself
 * (`POST /api/types/:type/entities/:id/check`), and writes no entity unless all pass. Entities and
 * roles are only created (`expectedRev: 0`): one that already exists in entity-store is skipped and
 * listed, never overwritten, so running it again creates only what's missing. It stops at the
 * first failed write. automations' own tables are left as they are.
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
import { checkLocally, describeStep, MIGRATION_META, planMigration, type Source } from "./plan.ts";

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
  /** The answer, or `{ refused }` with entity-store's `{ code, error }` when it says no. */
  const attempt = <A>(
    method: string,
    path: string,
    schema: Schema.Codec<A, unknown>,
    body?: unknown,
  ) =>
    fetchJson(`${method} ${path}`, new URL(path, origin).toString(), {
      method,
      headers: { ...access, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).pipe(
      Effect.flatMap(({ ok, status, json }) =>
        ok
          ? Schema.decodeUnknownEffect(schema)(json).pipe(
              Effect.map((value) => ({ value, refused: undefined })),
              Effect.mapError((error) => fail(`${method} ${path} answered ${error.message}`)),
            )
          : Schema.decodeUnknownEffect(Refusal)(json).pipe(
              Effect.map((refused) => ({ value: undefined, refused })),
              Effect.mapError(() =>
                fail(`${method} ${path} failed (${status}): ${JSON.stringify(json)}`),
              ),
            ),
      ),
    );
  const call = <A>(
    method: string,
    path: string,
    schema: Schema.Codec<A, unknown>,
    body?: unknown,
  ) =>
    attempt(method, path, schema, body).pipe(
      Effect.flatMap(({ value, refused }) =>
        refused === undefined
          ? Effect.succeed(value as A)
          : Effect.fail(fail(`${method} ${path} failed: ${refused.code}: ${refused.error}`)),
      ),
    );
  return { attempt, call };
});

const Refusal = Schema.Struct({ code: Schema.String, error: Schema.String });
const Created = Schema.Struct({ entity: Schema.Struct({ rev: Schema.Int }) });

const entityPath = (type: string, id: string) =>
  `/api/types/${type}/entities/${encodeURIComponent(id)}`;

const program = Effect.gen(function* () {
  const source = argument("source");
  const target = argument("target");
  const apply = process.argv.includes("--apply");
  if (source === undefined || target === undefined) {
    return yield* fail(
      "Usage: migrate.ts --source <export.json | d1:<account>/<database>> --target <entity-store URL> [--apply]",
    );
  }
  const { attempt, call } = yield* makeTarget(target);
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
  const local = yield* Effect.promise(() => checkLocally(plan, existing));
  if (local.length > 0) {
    return yield* fail(
      `entity-store would refuse these; fix them in automations first:\n  ${local.join("\n  ")}`,
    );
  }
  if (!apply) {
    for (const step of plan.steps) yield* Console.log(`would ${describeStep(step)}`);
    return yield* Console.log("Dry run: nothing was written. Add --apply to write.");
  }
  const types = plan.steps.filter(
    (step) => step.kind === "createType" || step.kind === "createVersion",
  );
  for (const step of types) {
    yield* Console.log(describeStep(step));
    if (step.kind === "createType") {
      yield* call("POST", "/api/types", Schema.Unknown, step.input);
    } else if (step.kind === "createVersion") {
      yield* call("POST", `/api/types/${step.type}/versions`, Schema.Unknown, {
        schema: step.schema,
        lens: step.lens,
        note: "Copied from automations",
      });
    }
  }
  // entity-store's own checks, before any entity is written. Refs are checked by the plan: their
  // targets are created first.
  const creates = plan.steps.flatMap((step) => (step.kind === "createEntity" ? [step] : []));
  const refused = (yield* Effect.forEach(creates, (step) =>
    attempt("POST", `${entityPath(step.type, step.id)}/check`, Schema.Unknown, {
      patch: step.patch,
    }).pipe(
      Effect.map(({ refused }) =>
        refused === undefined || refused.code === "EntityTypeMismatch"
          ? []
          : [`${describeStep(step)}: ${refused.error}`],
      ),
    ),
  )).flat();
  if (refused.length > 0) {
    return yield* fail(
      `entity-store refused these; no entity was written:\n  ${refused.join("\n  ")}`,
    );
  }
  const created = new Map<string, number>();
  const skipped: Array<string> = [];
  for (const step of plan.steps) {
    if (step.kind === "createEntity") {
      const answer = yield* attempt("PUT", entityPath(step.type, step.id), Created, {
        patch: step.patch,
        expectedRev: 0,
        meta: MIGRATION_META,
      });
      if (answer.refused === undefined) {
        created.set(step.id, answer.value.entity.rev);
        yield* Console.log(describeStep(step));
      } else if (
        answer.refused.code === "RevConflict" ||
        answer.refused.code === "EntityTypeMismatch"
      ) {
        skipped.push(
          answer.refused.code === "RevConflict"
            ? `${step.type} ${step.id}`
            : `${step.type} ${step.id}: the ID belongs to another type there`,
        );
      } else {
        return yield* fail(
          `${describeStep(step)} failed: ${answer.refused.code}: ${answer.refused.error}`,
        );
      }
    } else if (step.kind === "linkEntity") {
      const rev = created.get(step.id);
      if (rev === undefined) continue;
      const answer = yield* call("PUT", entityPath(step.type, step.id), Created, {
        patch: step.patch,
        expectedRev: rev,
        meta: MIGRATION_META,
      });
      created.set(step.id, answer.entity.rev);
      yield* Console.log(describeStep(step));
    }
  }
  if (skipped.length > 0) {
    yield* Console.log(`Already in entity-store, so left as they are:\n  ${skipped.join("\n  ")}`);
  }
  yield* Console.log("Done.");
});

program.pipe(BunRuntime.runMain);
