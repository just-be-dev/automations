import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Entities are the records automations act on, such as an `employee`. The `EntityStore` service
 * (`src/entity-store.ts`) keeps their types and records; this module holds the pure model: the
 * Schemas, how an entity's data is checked against its type, and how a dotted path walks from one
 * entity to another through `ref` fields.
 */

export class InvalidEntity extends Schema.TaggedError<InvalidEntity>()("InvalidEntity", {
  message: Schema.String,
}) {}

const snakeCase = /^[a-z][a-z0-9_]{0,39}$/;

/** An entity type or field name: `employee`, `start_date`. */
export const EntityName = Schema.String.check(
  Schema.isPattern(snakeCase, { message: "Entity and field names are snake_case identifiers" }),
);

/** An entity's ID: `ada`, `ada@example.com`. */
export const EntityId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_.@-]{1,120}$/, {
    message: "Entity IDs use letters, numbers, _ . @ and - (up to 120 characters)",
  }),
);

export const FieldType = Schema.Literals(["text", "number", "boolean", "date", "datetime", "ref"]);
export type FieldType = typeof FieldType.Type;

export const EntityField = Schema.Struct({
  name: EntityName,
  label: Schema.String,
  type: FieldType,
  /** The entity type a `ref` field points to. */
  to: Schema.optionalKey(EntityName),
}).check(
  Schema.makeFilter(
    (field: { readonly type: FieldType; readonly to?: string }) =>
      (field.type === "ref") === (field.to !== undefined),
    { message: "A ref field names the type it points to in `to`, and only ref fields do" },
  ),
);
export interface EntityField extends Schema.Schema.Type<typeof EntityField> {}

export const EntityType = Schema.Struct({
  name: EntityName,
  label: Schema.String,
  /** The field that names an entity when it is shown as text, such as `name`. */
  title: EntityName,
  fields: Schema.Array(EntityField),
}).check(
  Schema.makeFilter(
    (type: { readonly title: string; readonly fields: ReadonlyArray<{ readonly name: string }> }) =>
      type.fields.some((field) => field.name === type.title),
    { message: "An entity type's title must name one of its fields" },
  ),
);
export interface EntityType extends Schema.Schema.Type<typeof EntityType> {}

export const EntityData = Schema.Record(Schema.String, Schema.Json);
export type EntityData = typeof EntityData.Type;

/** One stored entity. `ref` fields hold the target entity's ID. */
export const EntityRecord = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  data: EntityData,
  updatedAt: Schema.Finite,
});
export interface EntityRecord extends Schema.Schema.Type<typeof EntityRecord> {}

/** A person's address: a text field named `email`. An entity with one is a person. */
export const isEmailField = (field: EntityField) => field.name === "email" && field.type === "text";

/** A member of a role: a person (see `isEmailField`), by type and ID. */
export const RoleMember = Schema.Struct({ type: EntityName, id: Schema.String });
export interface RoleMember extends Schema.Schema.Type<typeof RoleMember> {}

/**
 * A named group of people, such as People Ops. An operation a workflow sets to ask first names the
 * role whose members approve it.
 */
export const Role = Schema.Struct({
  name: EntityName,
  label: Schema.String.check(Schema.isMinLength(1)),
  members: Schema.Array(RoleMember),
});
export interface Role extends Schema.Schema.Type<typeof Role> {}

/** The entity a run is about: a snapshot of it when the run started. */
export const Subject = Schema.Struct({ type: Schema.String, id: Schema.String, data: EntityData });
export interface Subject extends Schema.Schema.Type<typeof Subject> {}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const fieldAccepts = (field: EntityField, value: Schema.Json): boolean => {
  if (value === null) {
    return true;
  }
  switch (field.type) {
    case "text":
    case "ref":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && isoDate.test(value) && !Number.isNaN(Date.parse(value));
    case "datetime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
  }
};

/** Checks a record's data against its type. Fields may be missing or `null` (unset). */
export const checkEntityData = (type: EntityType, data: EntityData) => {
  const problems = Object.entries(data).flatMap(([name, value]) => {
    const field = type.fields.find((candidate) => candidate.name === name);
    if (field === undefined) {
      return [`${type.name} has no field ${name}`];
    }
    return fieldAccepts(field, value) ? [] : [`${type.name}.${name} must be a ${field.type}`];
  });
  return problems.length === 0
    ? Effect.succeed(data)
    : Effect.fail(new InvalidEntity({ message: problems.join("; ") }));
};

/**
 * Checks a type against the others it will be stored beside. `id` is every entity's ID in a path,
 * so no field may take the name, and `types` would collide with `/api/entities/types`.
 */
export const checkEntityType = (types: ReadonlyArray<EntityType>, type: EntityType) => {
  const names = type.fields.map((field) => field.name);
  const problems = [
    ...(type.name === "types" ? ["types is reserved; choose another type name"] : []),
    ...(names.includes("id") ? [`${type.name}.id is every entity's ID; rename the field`] : []),
    ...[...new Set(names.filter((name, index) => names.indexOf(name) !== index))].map(
      (name) => `${type.name} has more than one field named ${name}`,
    ),
    ...type.fields.flatMap((field) =>
      field.to === undefined ||
      field.to === type.name ||
      types.some((candidate) => candidate.name === field.to)
        ? []
        : [`${type.name}.${field.name} points to unknown type ${field.to}`],
    ),
  ];
  return problems.length === 0
    ? Effect.succeed(type)
    : Effect.fail(new InvalidEntity({ message: problems.join("; ") }));
};

/** The names of the fields whose values differ between two versions of a record. */
export const changedFields = (before: EntityData | undefined, after: EntityData) =>
  [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].filter(
    (name) => JSON.stringify(before?.[name] ?? null) !== JSON.stringify(after[name] ?? null),
  );

/**
 * An entity as steps see it: its fields plus `$type`, `$id`, and `$title`. Templates show an
 * entity as its `$title`; connections read the fields they need, such as `email`.
 */
export const entityValue = (type: EntityType | undefined, record: Subject): Schema.Json => {
  const title = type === undefined ? undefined : record.data[type.title];
  return {
    ...record.data,
    $type: record.type,
    $id: record.id,
    $title: typeof title === "string" ? title : record.id,
  };
};

export type PathTarget =
  | { readonly kind: "entity"; readonly type: EntityType }
  | { readonly kind: "field"; readonly field: EntityField }
  | { readonly kind: "error"; readonly message: string };

/**
 * What a dotted path from an entity type leads to, so the designer's references can be checked
 * before a run. `id` is every entity's ID. A `ref` field with more segments after it continues in
 * the type it points to.
 */
export const pathTarget = (
  types: ReadonlyArray<EntityType>,
  type: EntityType,
  path: ReadonlyArray<string>,
): PathTarget => {
  const [segment, ...rest] = path;
  if (segment === undefined) {
    return { kind: "entity", type };
  }
  if (segment === "id") {
    return rest.length === 0
      ? { kind: "field", field: { name: "id", label: "ID", type: "text" } }
      : { kind: "error", message: `${type.name}.id has no fields` };
  }
  const field = type.fields.find((candidate) => candidate.name === segment);
  if (field === undefined) {
    const names = type.fields.map((candidate) => candidate.name).join(", ");
    return { kind: "error", message: `${type.name} has no field ${segment} (fields: ${names})` };
  }
  if (field.type !== "ref") {
    return rest.length === 0
      ? { kind: "field", field }
      : { kind: "error", message: `${type.name}.${segment} is a ${field.type}, not an entity` };
  }
  const target = types.find((candidate) => candidate.name === field.to);
  return target === undefined
    ? { kind: "error", message: `${type.name}.${segment} points to unknown type ${field.to}` }
    : pathTarget(types, target, rest);
};

/** Loads an entity by type and ID, or `undefined` when it doesn't exist. */
export type LoadEntity<E, R> = (
  type: string,
  id: string,
) => Effect.Effect<Subject | undefined, E, R>;

/**
 * Reads a dotted path from an entity, loading the entities that `ref` fields point to. A path that
 * ends on a `ref` field yields that whole entity. Missing values read as `null`.
 */
export const readEntityPath = <E, R>(
  types: ReadonlyArray<EntityType>,
  entity: Subject,
  path: ReadonlyArray<string>,
  load: LoadEntity<E, R>,
): Effect.Effect<Schema.Json, E, R> => {
  const type = types.find((candidate) => candidate.name === entity.type);
  const [segment, ...rest] = path;
  if (segment === undefined) {
    return Effect.succeed(entityValue(type, entity));
  }
  if (segment === "id") {
    return Effect.succeed(rest.length === 0 ? entity.id : null);
  }
  const value = entity.data[segment] ?? null;
  const field = type?.fields.find((candidate) => candidate.name === segment);
  if (field?.type === "ref" && field.to !== undefined && typeof value === "string") {
    return load(field.to, value).pipe(
      Effect.flatMap((target) =>
        target === undefined ? Effect.succeed(null) : readEntityPath(types, target, rest, load),
      ),
    );
  }
  return Effect.succeed(readJsonPath(value, rest));
};

/** Reads a dotted path into plain JSON; numeric segments index arrays. Missing reads as `null`. */
export const readJsonPath = (value: Schema.Json, path: ReadonlyArray<string>): Schema.Json =>
  path.reduce<Schema.Json>((current, key) => {
    if (Array.isArray(current)) {
      return /^\d+$/.test(key) ? (current[Number(key)] ?? null) : null;
    }
    return typeof current === "object" && current !== null
      ? (Object.getOwnPropertyDescriptor(current, key)?.value ?? null)
      : null;
  }, value);

/**
 * Reads a ref against what a run knows: `steps.<id>…` from the step records, and a path rooted
 * at the subject's type from the subject, following `ref` fields. Any other root reads `null`.
 */
export const readRef = <E, R>(
  types: ReadonlyArray<EntityType>,
  known: {
    readonly subject: Subject | null;
    readonly steps: Readonly<Record<string, Schema.Json>>;
  },
  ref: string,
  load: LoadEntity<E, R>,
): Effect.Effect<Schema.Json, E, R> => {
  const [root, ...path] = ref.split(".");
  if (root === "steps") {
    return Effect.succeed(readJsonPath(known.steps, path));
  }
  return known.subject !== null && root === known.subject.type
    ? readEntityPath(types, known.subject, path, load)
    : Effect.succeed(null);
};
