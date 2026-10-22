/**
 * Plans copying automations' entity types, entities and roles from its own D1 into entity-store.
 * Pure: `migrate.ts` reads the rows and entity-store's types, and makes the writes. Every write
 * carries `meta` marking it as the migration's, so automations publishes and starts nothing.
 * Entities and roles are only ever created, never overwritten: one that already exists in
 * entity-store is skipped.
 */
import * as Schema from "effect/Schema";
import type {
  Lens,
  StoreSchema,
  TypeInfo,
  WriteMeta,
} from "../../src/entities/entity-store-api.ts";
import {
  planTypeWrite,
  ROLE_MEMBER_TYPE,
  ROLE_TYPE,
  roleData,
  roleSchema,
} from "../../src/entities/entity-store-types.ts";
import { makeFakeEntityStore } from "../../src/entities/entity-store-fake.ts";
import { EntityData, EntityType, Role } from "../../src/entities/model.ts";

/** What automations' D1 holds: the `entity_types`, `entities` and `roles` rows, decoded. */
export const Source = Schema.Struct({
  types: Schema.Array(EntityType),
  entities: Schema.Array(
    Schema.Struct({ type: Schema.String, id: Schema.String, data: EntityData }),
  ),
  roles: Schema.Array(Role),
});
export type Source = typeof Source.Type;

export const MIGRATION_META: WriteMeta = { depth: 0, source: "migration" };

export type Step =
  | {
      readonly kind: "createType";
      readonly input: {
        readonly name: string;
        readonly description: string;
        readonly schema: StoreSchema;
      };
    }
  | {
      readonly kind: "createVersion";
      readonly type: string;
      readonly schema: StoreSchema;
      readonly lens: Lens;
    }
  | {
      /** Creates the entity (`expectedRev: 0`), without its refs; skipped if it exists. */
      readonly kind: "createEntity";
      readonly type: string;
      readonly id: string;
      readonly patch: Readonly<Record<string, Schema.Json>>;
    }
  | {
      /** Adds the refs of an entity this run created, at the revision it created. */
      readonly kind: "linkEntity";
      readonly type: string;
      readonly id: string;
      readonly patch: Readonly<Record<string, Schema.Json>>;
    };

export interface Plan {
  readonly steps: ReadonlyArray<Step>;
  /** What stops the migration: nothing is written while there are any. */
  readonly problems: ReadonlyArray<string>;
  /** What it changes on the way, such as values it leaves out. */
  readonly notes: ReadonlyArray<string>;
}

const refTargets = (type: EntityType) =>
  type.fields.flatMap((field) =>
    field.type === "ref" && field.to !== undefined && field.to !== type.name ? [field.to] : [],
  );

/** A type info as entity-store would hold it once `schema` is its latest version. */
const withVersion = (info: TypeInfo | undefined, name: string, schema: StoreSchema): TypeInfo => ({
  name,
  description: info?.description ?? "",
  latestVersion: (info?.versions.length ?? 0) + 1,
  createdAt: info?.createdAt ?? 0,
  updatedAt: 0,
  versions: [
    ...(info?.versions ?? []),
    {
      type: name,
      version: (info?.versions.length ?? 0) + 1,
      schema,
      note: "",
      createdAt: 0,
    },
  ],
});

/**
 * The writes that copy `source` into an entity-store that already holds `existing` types.
 *
 * Types are created so that every type a ref points to exists first. Types that point to each
 * other are created without those refs, then given them in a second version. Entities are written
 * twice: first without their ref values, then with them, so every target exists by then. Roles
 * become `role` entities, after the `role` type is created, and get their members the same way. Values of fields a type no longer has,
 * `null` values, and refs to entities that don't exist are left out, as automations already read
 * them. Running it again writes the same values again; an existing type is only versioned if it
 * differs.
 */
export const planMigration = (source: Source, existing: ReadonlyArray<TypeInfo>): Plan => {
  const problems: Array<string> = [];
  const notes: Array<string> = [];
  const steps: Array<Step> = [];
  const infos = new Map(existing.map((info) => [info.name, info]));
  const types = new Map(source.types.map((type) => [type.name, type]));

  if (types.has(ROLE_TYPE)) {
    problems.push(`automations has a type named ${ROLE_TYPE}, which entity-store keeps roles in`);
  }
  const owners = new Map<string, string>();
  for (const entity of source.entities) {
    if (!types.has(entity.type)) {
      problems.push(`${entity.type} ${entity.id} has no type`);
    }
    const owner = owners.get(entity.id);
    if (owner !== undefined && owner !== entity.type) {
      problems.push(
        `${entity.id} is the ID of both ${owner} ${entity.id} and ${entity.type} ${entity.id}; entity IDs are unique across types in entity-store`,
      );
    }
    owners.set(entity.id, entity.type);
  }
  for (const role of source.roles) {
    const owner = owners.get(role.name);
    if (owner !== undefined) {
      problems.push(`Role ${role.name} has the ID of ${owner} ${role.name}`);
    }
    for (const member of role.members) {
      if (member.type !== ROLE_MEMBER_TYPE) {
        problems.push(
          `Role ${role.name} has ${member.type} ${member.id} as a member; members must be ${ROLE_MEMBER_TYPE}s`,
        );
      }
    }
  }

  // Types, each after the types its refs point to. A cycle is broken by leaving its refs out.
  const pending = new Map(types);
  const partial = new Set<string>();
  const available = (name: string) => infos.has(name) && !pending.has(name);
  const write = (type: EntityType) => {
    const plan = planTypeWrite(infos.get(type.name), type);
    switch (plan.kind) {
      case "refused":
        problems.push(plan.message);
        return;
      case "create":
        steps.push({ kind: "createType", input: plan.input });
        infos.set(type.name, withVersion(undefined, type.name, plan.input.schema));
        return;
      case "version":
        steps.push({
          kind: "createVersion",
          type: type.name,
          schema: plan.schema,
          lens: plan.lens,
        });
        infos.set(type.name, withVersion(infos.get(type.name), type.name, plan.schema));
        return;
      case "unchanged":
        return;
    }
  };
  while (pending.size > 0) {
    const ready = [...pending.values()].find((type) =>
      refTargets(type).every((target) => available(target) || !types.has(target)),
    );
    const next = ready ?? [...pending.values()][0];
    if (next === undefined) break;
    pending.delete(next.name);
    const missing = refTargets(next).filter((target) => !available(target) && !infos.has(target));
    for (const target of missing.filter((target) => !types.has(target))) {
      problems.push(
        `${next.name} points to ${target}, which neither automations nor entity-store has`,
      );
    }
    if (ready === undefined) {
      partial.add(next.name);
      const kept = next.fields.filter(
        (field) => field.to === undefined || !missing.includes(field.to),
      );
      write({
        ...next,
        fields: kept,
        title: kept.some((field) => field.name === next.title)
          ? next.title
          : (kept.find((field) => field.type === "text")?.name ?? next.title),
      });
    } else {
      write(next);
    }
  }
  for (const name of partial) {
    const type = types.get(name);
    if (type !== undefined) write(type);
  }

  // Entities, without their refs and then with them.
  const exists = (type: string, id: string) =>
    source.entities.some((entity) => entity.type === type && entity.id === id);
  const refs: Array<Step> = [];
  for (const entity of source.entities) {
    const type = types.get(entity.type);
    if (type === undefined) continue;
    const plain: Record<string, Schema.Json> = {};
    const linked: Record<string, Schema.Json> = {};
    for (const [name, value] of Object.entries(entity.data)) {
      const field = type.fields.find((candidate) => candidate.name === name);
      if (field === undefined) {
        notes.push(
          `${entity.type} ${entity.id}: left out ${name}, which ${entity.type} no longer has`,
        );
      } else if (value === null) {
        continue;
      } else if (field.type === "ref") {
        if (typeof value === "string" && field.to !== undefined && exists(field.to, value)) {
          linked[name] = value;
        } else {
          notes.push(
            `${entity.type} ${entity.id}: left out ${name}, which points to ${field.to} ${String(value)}, which doesn't exist`,
          );
        }
      } else {
        plain[name] = value;
      }
    }
    steps.push({ kind: "createEntity", type: entity.type, id: entity.id, patch: plain });
    if (Object.keys(linked).length > 0) {
      refs.push({ kind: "linkEntity", type: entity.type, id: entity.id, patch: linked });
    }
  }
  steps.push(...refs);

  if (source.roles.length > 0) {
    if (!infos.has(ROLE_TYPE)) {
      if (!infos.has(ROLE_MEMBER_TYPE)) {
        problems.push(`Roles need a ${ROLE_MEMBER_TYPE} type for their members`);
      }
      steps.push({
        kind: "createType",
        input: { name: ROLE_TYPE, description: "Roles", schema: roleSchema },
      });
    }
    for (const role of source.roles) {
      const missing = role.members.filter((member) => !exists(member.type, member.id));
      for (const member of missing) {
        notes.push(`Role ${role.name}: left out ${member.type} ${member.id}, which doesn't exist`);
      }
      // Created without its members, which link to employees, and given them once every entity
      // exists, as entities get their refs.
      const { members, ...created } = roleData({
        ...role,
        members: role.members.filter((member) => !missing.includes(member)),
      });
      steps.push({
        kind: "createEntity",
        type: ROLE_TYPE,
        id: role.name,
        patch: { ...created, members: [] },
      });
      if (Array.isArray(members) && members.length > 0) {
        steps.push({ kind: "linkEntity", type: ROLE_TYPE, id: role.name, patch: { members } });
      }
    }
  }

  return { steps, problems: [...new Set(problems)], notes };
};

/**
 * Every entity write the plan makes, checked by the in-memory entity-store once the plan's types
 * are applied to the types entity-store has: what entity-store would refuse, such as a datetime
 * without a timezone, an enum value it lacks, or a string too long. Each failure is listed, not
 * fixed. `migrate.ts --apply` checks them again against entity-store itself before writing any.
 */
export const checkLocally = async (
  plan: Plan,
  existing: ReadonlyArray<TypeInfo>,
): Promise<ReadonlyArray<string>> => {
  const store = makeFakeEntityStore();
  for (const info of existing) {
    const schema = info.versions.at(-1)?.schema;
    if (schema !== undefined) store.seedType(info.name, info.description, schema);
  }
  const failures: Array<string> = [];
  const failed = (step: Step, answer: unknown) => {
    const error = (answer as { ok: boolean; error?: { message?: string } }).error;
    if (error !== undefined) failures.push(`${describeStep(step)}: ${error.message ?? "refused"}`);
  };
  for (const step of plan.steps) {
    if (step.kind === "createType") failed(step, await store.createType(step.input));
    else if (step.kind === "createVersion")
      failed(
        step,
        await store.createVersion(step.type, { schema: step.schema, lens: step.lens, force: true }),
      );
    else if (step.kind === "createEntity")
      failed(step, await store.upsertEntity(step.type, step.id, { patch: step.patch }));
    else failed(step, await store.upsertEntity(step.type, step.id, { patch: step.patch }));
  }
  return failures;
};

export const describeStep = (step: Step) =>
  step.kind === "createType"
    ? `create type ${step.input.name}`
    : step.kind === "createVersion"
      ? `add a version of ${step.type}: ${step.lens.ops.map((op) => `${String(op["op"])} ${String(op["field"])}`).join(", ")}`
      : step.kind === "createEntity"
        ? `create ${step.type} ${step.id}: ${Object.keys(step.patch).join(", ") || "(no values)"}`
        : `link ${step.type} ${step.id}: ${Object.keys(step.patch).join(", ")}`;
