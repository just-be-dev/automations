/**
 * The migration itself, over any entity-store target: looks for ID clashes, plans, checks, and
 * (with `apply`) writes. `migrate.ts` gives it the command line, the source rows and the HTTP
 * target; tests give it an in-memory one.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TypeInfo, TypeSummary } from "../../src/entities/entity-store-api.ts";
import { ROLE_TYPE } from "../../src/entities/entity-store-types.ts";
import { checkLocally, describeStep, MIGRATION_META, planMigration, type Source } from "./plan.ts";

export class MigrationError extends Schema.TaggedError<MigrationError>()("MigrationError", {
  message: Schema.String,
}) {}
export const fail = (message: string) => new MigrationError({ message });

/** entity-store's `{ code, error }` answer to a request it refuses. */
export const Refusal = Schema.Struct({
  code: Schema.String,
  error: Schema.String,
  /** `EntityDeleted`: the revision that deleted it. */
  rev: Schema.optionalKey(Schema.Int),
});
export type Refusal = typeof Refusal.Type;

export type Answer<A> =
  | { readonly value: A; readonly refused: undefined }
  | { readonly value: undefined; readonly refused: Refusal };

/** entity-store's HTTP API: an answer, or the refusal it sends instead. */
export interface Target {
  readonly attempt: <A>(
    method: string,
    path: string,
    schema: Schema.Codec<A, unknown>,
    body?: unknown,
  ) => Effect.Effect<Answer<A>, MigrationError>;
}

/** Like `attempt`, but a refusal fails. */
const call = <A>(
  target: Target,
  method: string,
  path: string,
  schema: Schema.Codec<A, unknown>,
  body?: unknown,
) =>
  target
    .attempt(method, path, schema, body)
    .pipe(
      Effect.flatMap((answer) =>
        answer.refused === undefined
          ? Effect.succeed(answer.value)
          : Effect.fail(
              fail(`${method} ${path} failed: ${answer.refused.code}: ${answer.refused.error}`),
            ),
      ),
    );

const Created = Schema.Struct({ entity: Schema.Struct({ rev: Schema.Int }) });
const Found = Schema.Struct({ type: Schema.String });

const entityPath = (type: string, id: string) =>
  `/api/types/${type}/entities/${encodeURIComponent(id)}`;

/** What the target already holds under the IDs the copy would create. */
export interface Occupied {
  /** IDs held by an entity of another type: the copy can't create these. */
  readonly clashes: ReadonlyArray<string>;
  /** IDs held by a live entity of the same type: the copy leaves them as they are. */
  readonly existing: ReadonlyArray<{ readonly type: string; readonly id: string }>;
}

/**
 * Looks up every entity and role ID the copy would create. entity-store's IDs are unique across
 * types, so one held by another type can never be created. A deleted entity (410) can only be
 * created again as its own type, which the revision before its deletion names.
 */
export const findOccupied = Effect.fn("Migration.findOccupied")(function* (
  target: Target,
  source: Source,
) {
  const wanted = [
    ...source.entities.map((entity) => ({ type: entity.type, id: entity.id })),
    ...source.roles.map((role) => ({ type: ROLE_TYPE, id: role.name })),
  ];
  const lookUp = (id: string, rev?: number) =>
    target.attempt(
      "GET",
      `/api/entities/${encodeURIComponent(id)}${rev === undefined ? "" : `?rev=${rev}`}`,
      Found,
    );
  const found = yield* Effect.forEach(
    wanted,
    (want) =>
      Effect.gen(function* () {
        const answer = yield* lookUp(want.id);
        const deletedAt = answer.refused?.code === "EntityDeleted" ? answer.refused.rev : undefined;
        if (deletedAt === undefined || deletedAt < 2) return { want, answer, deleted: false };
        // Deleted: what it was, so the copy knows whether it may create it again.
        return { want, answer: yield* lookUp(want.id, deletedAt - 1), deleted: true };
      }),
    { concurrency: 8 },
  );
  const clashes: Array<string> = [];
  const existing: Array<{ readonly type: string; readonly id: string }> = [];
  for (const { want, answer, deleted } of found) {
    if (answer.refused !== undefined) {
      if (answer.refused.code === "EntityNotFound" || answer.refused.code === "EntityDeleted") {
        continue;
      }
      return yield* fail(
        `Couldn't look up ${want.id}: ${answer.refused.code}: ${answer.refused.error}`,
      );
    }
    if (answer.value.type !== want.type) {
      clashes.push(
        `${want.type} ${want.id}: entity-store ${deleted ? "had" : "has"} ${answer.value.type} ${want.id}${deleted ? ", deleted; its ID can't take another type" : ""}`,
      );
    } else if (!deleted) existing.push(want);
  }
  const occupied: Occupied = { clashes, existing };
  return occupied;
});

/**
 * Copies `source` into `target`. Without `apply` it writes nothing: it lists ID clashes, entities
 * that already exist, and every write entity-store would refuse. With `apply`, any clash or
 * refusal stops it before it creates or versions a type, so a failure never leaves half a copy.
 */
export const migrate = Effect.fn("Migration.migrate")(function* (
  target: Target,
  source: Source,
  apply: boolean,
) {
  const { items } = yield* call(
    target,
    "GET",
    "/api/types",
    Schema.Struct({ items: Schema.Array(TypeSummary) }),
  );
  const existingTypes = yield* Effect.forEach(items, (summary) =>
    call(target, "GET", `/api/types/${summary.name}`, TypeInfo),
  );
  const occupied = yield* findOccupied(target, source);
  // What exists already is left as it is, and only what's missing is planned.
  const exists = (type: string, id: string) =>
    occupied.existing.some((held) => held.type === type && held.id === id);
  const planned = planMigration(source, existingTypes);
  const plan = {
    ...planned,
    steps: planned.steps.filter(
      (step) =>
        (step.kind !== "createEntity" && step.kind !== "linkEntity") || !exists(step.type, step.id),
    ),
  };
  yield* Console.log(
    `${source.types.length} types, ${source.entities.length} entities and ${source.roles.length} roles; ${plan.steps.length} writes.`,
  );
  for (const note of plan.notes) yield* Console.log(`  note: ${note}`);
  if (occupied.existing.length > 0) {
    yield* Console.log(
      `Already in entity-store, so left as they are:\n  ${occupied.existing.map((held) => `${held.type} ${held.id}`).join("\n  ")}`,
    );
  }
  const problems = [...plan.problems, ...occupied.clashes.map((clash) => `ID clash: ${clash}`)];
  if (problems.length > 0) {
    return yield* fail(`Fix these first; nothing was written:\n  ${problems.join("\n  ")}`);
  }
  const local = yield* Effect.promise(() => checkLocally(plan, existingTypes));
  if (local.length > 0) {
    return yield* fail(
      `entity-store would refuse these; fix them in automations first:\n  ${local.join("\n  ")}`,
    );
  }
  if (!apply) {
    for (const step of plan.steps) yield* Console.log(`would ${describeStep(step)}`);
    return yield* Console.log("Dry run: nothing was written. Add --apply to write.");
  }
  for (const step of plan.steps) {
    if (step.kind === "createType") {
      yield* Console.log(describeStep(step));
      yield* call(target, "POST", "/api/types", Schema.Unknown, step.input);
    } else if (step.kind === "createVersion") {
      yield* Console.log(describeStep(step));
      yield* call(target, "POST", `/api/types/${step.type}/versions`, Schema.Unknown, {
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
    target
      .attempt("POST", `${entityPath(step.type, step.id)}/check`, Schema.Unknown, {
        patch: step.patch,
      })
      .pipe(
        Effect.map(({ refused }) =>
          refused === undefined ? [] : [`${describeStep(step)}: ${refused.error}`],
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
      const answer = yield* target.attempt("PUT", entityPath(step.type, step.id), Created, {
        patch: step.patch,
        expectedRev: 0,
        meta: MIGRATION_META,
      });
      if (answer.refused === undefined) {
        created.set(step.id, answer.value.entity.rev);
        yield* Console.log(describeStep(step));
      } else if (answer.refused.code === "RevConflict") {
        // Created since it was looked up: still left as it is.
        skipped.push(`${step.type} ${step.id}`);
      } else {
        return yield* fail(
          `${describeStep(step)} failed: ${answer.refused.code}: ${answer.refused.error}`,
        );
      }
    } else if (step.kind === "linkEntity") {
      const rev = created.get(step.id);
      if (rev === undefined) continue;
      const answer = yield* call(target, "PUT", entityPath(step.type, step.id), Created, {
        patch: step.patch,
        expectedRev: rev,
        meta: MIGRATION_META,
      });
      created.set(step.id, answer.entity.rev);
      yield* Console.log(describeStep(step));
    }
  }
  if (skipped.length > 0) {
    yield* Console.log(
      `Created by someone else meanwhile, so left as they are:\n  ${skipped.join("\n  ")}`,
    );
  }
  yield* Console.log("Done.");
  return { created: [...created.keys()], skipped };
});
