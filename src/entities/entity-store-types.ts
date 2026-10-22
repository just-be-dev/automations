/**
 * Translates between entity-store's schemas and automations' entity types and roles, in both
 * directions. Pure: the store layer reads and writes, this only decides what the shapes mean.
 *
 * Reading, a field maps by its kind: `string` is text (or a date or datetime by its `format`),
 * `enum` is text, `number`, `boolean`, and `link` is a ref. `nullable` maps as what it holds.
 * `array`, `object` and `json` fields are left out, along with fields and types whose names
 * aren't snake_case: automations can't see into them, so neither checks nor paths reach them, and
 * entity data is read without them. A write leaves them as they are.
 */
import * as Schema from "effect/Schema";
import type { Lens, SchemaNode, StoreSchema, TypeInfo } from "./entity-store-api.ts";
import {
  EntityName,
  type EntityData,
  type EntityField,
  type EntityType,
  type FieldType,
  type Role,
} from "./model.ts";

/** Roles are entities of this type, so it isn't one of automations' entity types. */
export const ROLE_TYPE = "role";
/** The only type a role's members may have. */
export const ROLE_MEMBER_TYPE = "employee";

const isName = Schema.is(EntityName);

const isNode = (value: Schema.Json | undefined): value is SchemaNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The node a `nullable` holds, however deep. */
const unwrap = (node: SchemaNode): SchemaNode =>
  node["type"] === "nullable" && isNode(node["of"]) ? unwrap(node["of"]) : node;

const fieldKind = (
  node: SchemaNode,
): { readonly type: FieldType; readonly to?: string } | undefined => {
  const inner = unwrap(node);
  switch (inner["type"]) {
    case "string":
      return {
        type:
          inner["format"] === "date"
            ? "date"
            : inner["format"] === "datetime"
              ? "datetime"
              : "text",
      };
    case "enum":
      return { type: "text" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "link": {
      const to = inner["to"];
      return typeof to === "string" && isName(to) ? { type: "ref", to } : undefined;
    }
    default:
      return undefined;
  }
};

const descriptionOf = (node: SchemaNode) => {
  const own = node["description"];
  const inner = unwrap(node)["description"];
  return typeof own === "string" && own !== ""
    ? own
    : typeof inner === "string" && inner !== ""
      ? inner
      : undefined;
};

/** The fields automations sees, in the schema's order. */
const visibleFields = (schema: StoreSchema): ReadonlyArray<EntityField> =>
  Object.entries(schema.fields).flatMap(([name, node]) => {
    const kind = isName(name) && name !== "id" ? fieldKind(node) : undefined;
    return kind === undefined ? [] : [{ name, label: descriptionOf(node) ?? name, ...kind }];
  });

const latest = (info: TypeInfo) => info.versions.at(-1);

/** Whether a field can be a title: text that's a string, not an enum's value. */
const titleable = (schema: StoreSchema, field: EntityField | undefined) => {
  const node = field === undefined ? undefined : schema.fields[field.name];
  return field?.type === "text" && node !== undefined && unwrap(node)["type"] === "string";
};

/**
 * The entity type automations sees for an entity-store type at its latest version, or `undefined`
 * when automations can't use it: its name isn't snake_case, it is the role type, or no field is
 * visible. Its label is the schema's description, then the type's, then its name. Its title is
 * the schema's `title`, then a text field named `name`, then the first text field (an enum's
 * values aren't names), then the first field.
 */
export const toEntityType = (info: TypeInfo): EntityType | undefined => {
  const version = latest(info);
  if (version === undefined || !isName(info.name) || info.name === ROLE_TYPE) {
    return undefined;
  }
  const fields = visibleFields(version.schema);
  const has = (name: string | undefined) => fields.find((field) => field.name === name);
  const text = (field: EntityField | undefined) =>
    titleable(version.schema, field) ? field : undefined;
  const title =
    has(version.schema.title) ??
    text(has("name")) ??
    fields.find((field) => titleable(version.schema, field)) ??
    fields[0];
  if (title === undefined) {
    return undefined;
  }
  const label = version.schema.description || info.description || info.name;
  return { name: info.name, label, title: title.name, fields };
};

/** An entity's data as automations sees it: only its type's fields. */
export const toEntityData = (type: EntityType, data: Schema.Json): EntityData =>
  isNode(data)
    ? Object.fromEntries(
        type.fields.flatMap((field) =>
          field.name in data ? [[field.name, data[field.name] ?? null] as const] : [],
        ),
      )
    : {};

const baseNode = (field: EntityField): SchemaNode => {
  switch (field.type) {
    case "text":
      return { type: "string" };
    case "date":
      return { type: "string", format: "date" };
    case "datetime":
      return { type: "string", format: "datetime" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "ref":
      return { type: "link", to: field.to ?? "" };
  }
};

/** A field automations writes: optional and nullable, described by its label. */
const fieldNode = (field: EntityField): SchemaNode => ({
  type: "nullable",
  of: baseNode(field),
  optional: true,
  description: field.label,
});

const textual = (type: EntityType) =>
  type.fields.some((field) => field.name === type.title && field.type === "text");

const kindName = (field: { readonly type: FieldType; readonly to?: string }) =>
  field.type === "ref" ? `ref to ${field.to}` : field.type;

/** What a lens's `remove` restores going backward, when the old field needs a value. */
const removedDefault = (node: SchemaNode): { readonly default?: Schema.Json } | undefined =>
  node["optional"] === true ? {} : node["type"] === "nullable" ? { default: null } : undefined;

export type TypeWrite =
  | {
      readonly kind: "create";
      readonly input: {
        readonly name: string;
        readonly description: string;
        readonly schema: StoreSchema;
      };
    }
  | { readonly kind: "version"; readonly schema: StoreSchema; readonly lens: Lens }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly message: string };

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : item,
  );

/**
 * How to store `type` in entity-store: create it, or add a version to `existing` with a lens from
 * the field diff (`add` for new fields, `remove` for dropped ones). Every field automations writes
 * is optional and nullable, and its label is its description. Fields automations can't see keep
 * their nodes, and so do unchanged fields, keeping constraints such as an enum's values. A field
 * whose kind changes is refused: that needs a lens only entity-store can author.
 */
export const planTypeWrite = (existing: TypeInfo | undefined, type: EntityType): TypeWrite => {
  const untitled: TypeWrite = {
    kind: "refused",
    message: `${type.name}.${type.title} can't be the title: a title names a text field`,
  };
  if (existing === undefined) {
    if (!textual(type)) return untitled;
    return {
      kind: "create",
      input: {
        name: type.name,
        description: type.label,
        schema: {
          description: type.label,
          title: type.title,
          fields: Object.fromEntries(type.fields.map((field) => [field.name, fieldNode(field)])),
        },
      },
    };
  }
  const current = latest(existing)?.schema ?? { fields: {} };
  // What reads show now: kept as entity-store has it unless this save changes it, so saving a type
  // as it was writes nothing, even one entity-store gave no description or title.
  const shown = toEntityType(existing);
  const visible = new Map(visibleFields(current).map((field) => [field.name, field]));
  const problems: Array<string> = [];
  const ops: Array<Lens["ops"][number]> = [];
  const fields: Array<readonly [string, SchemaNode]> = [];
  for (const field of type.fields) {
    const node = current.fields[field.name];
    const before = visible.get(field.name);
    if (node === undefined) {
      fields.push([field.name, fieldNode(field)]);
      ops.push({ op: "add", field: field.name });
    } else if (before === undefined) {
      problems.push(
        `${type.name}.${field.name} exists in entity-store as a field automations can't edit`,
      );
    } else if (before.type !== field.type || before.to !== field.to) {
      problems.push(
        `${type.name}.${field.name} is a ${kindName(before)}; change it to a ${kindName(field)} in entity-store, where a lens can convert stored values`,
      );
    } else {
      fields.push([
        field.name,
        field.label === before.label ? node : { ...node, description: field.label },
      ]);
    }
  }
  for (const [name, node] of Object.entries(current.fields)) {
    if (!visible.has(name)) {
      fields.push([name, node]);
    } else if (!type.fields.some((field) => field.name === name)) {
      const restore = removedDefault(node);
      if (restore === undefined) {
        problems.push(
          `${type.name}.${name} is required in entity-store; remove it there, where a lens can say what old readers get`,
        );
      } else {
        ops.push({ op: "remove", field: name, ...restore });
      }
    }
  }
  if (problems.length > 0) {
    return { kind: "refused", message: problems.join("; ") };
  }
  const nodes = Object.fromEntries(fields);
  const keptTitle = type.title === shown?.title;
  if (
    !keptTitle &&
    !titleable(
      { fields: nodes },
      type.fields.find((f) => f.name === type.title),
    )
  ) {
    return untitled;
  }
  const description = type.label === shown?.label ? current.description : type.label;
  const title = keptTitle ? current.title : type.title;
  const schema: StoreSchema = {
    ...(description === undefined ? {} : { description }),
    ...(title === undefined ? {} : { title }),
    fields: nodes,
  };
  return canonical(schema) === canonical(current)
    ? { kind: "unchanged" }
    : { kind: "version", schema, lens: { ops } };
};

/** The schema of the `role` type: a label, and employees as members. */
export const roleSchema: StoreSchema = {
  description: "A named group of employees who approve what an automation asks first about",
  title: "label",
  fields: {
    label: { type: "string", minLength: 1, description: "Label" },
    members: {
      type: "array",
      items: { type: "link", to: ROLE_MEMBER_TYPE },
      description: "Members",
    },
  },
};

const RoleData = Schema.Struct({
  label: Schema.String,
  members: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** A `role` entity as a role, or `undefined` when its ID or data can't be one. */
export const roleFromEntity = (id: string, data: Schema.Json): Role | undefined => {
  const decoded = Schema.decodeUnknownOption(RoleData)(data);
  if (decoded._tag === "None" || !isName(id) || decoded.value.label === "") {
    return undefined;
  }
  return {
    name: id,
    label: decoded.value.label,
    members: (decoded.value.members ?? []).map((member) => ({
      type: ROLE_MEMBER_TYPE,
      id: member,
    })),
  };
};

/** A role's data as a `role` entity. */
export const roleData = (role: Role): Record<string, Schema.Json> => ({
  label: role.label,
  members: role.members.map((member) => member.id),
});
