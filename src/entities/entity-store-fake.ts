/**
 * An in-memory entity-store behind the `EntityStoreRpc` contract, for tests and the memory layer.
 * It keeps revisions, tombstones, write `meta` and the change log as entity-store does, and
 * enforces what automations relies on: `expectedRev`, upsert's create/patch/recreate rules, link
 * targets and linked deletes, and `TypeInUse`. Schema checks cover the node kinds and the lens
 * ops automations writes (`add`, `remove`), which it applies to stored data when a version lands.
 */
import type * as Schema from "effect/Schema";
import type {
  ChangeEvent,
  EntityStoreRpc,
  SchemaNode,
  StoreSchema,
  TypeInfo,
  VersionInfo,
  WriteMeta,
} from "./entity-store-api.ts";

type Json = Schema.Json;
type Data = Record<string, Json>;

interface Row {
  readonly id: string;
  readonly type: string;
  rev: number;
  data: Data | null;
  createdAt: number;
  updatedAt: number;
}

interface Revision {
  readonly rev: number;
  readonly op: ChangeEvent["op"];
  readonly data: Data | null;
  readonly meta: WriteMeta | null;
}

const ok = (value: unknown) => Promise.resolve({ ok: true, value: structuredClone(value) });
const err = (code: string, message: string, details: Record<string, unknown> = {}) =>
  Promise.resolve({ ok: false, error: { code, message, ...details } });

const isRecord = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/** The links a value holds under a node, as `{ path, target, to }`. */
const linksIn = (
  node: SchemaNode,
  value: Json | undefined,
  path: string,
): Array<{ path: string; target: string; to: string }> => {
  if (value === undefined || value === null) return [];
  switch (node["type"]) {
    case "link":
      return typeof value === "string" ? [{ path, target: value, to: String(node["to"]) }] : [];
    case "nullable":
      return isRecord(node["of"]) ? linksIn(node["of"], value, path) : [];
    case "array":
      return Array.isArray(value) && isRecord(node["items"])
        ? value.flatMap((item, index) =>
            linksIn(node["items"] as SchemaNode, item, `${path}.${index}`),
          )
        : [];
    case "object":
      return isRecord(value) && isRecord(node["fields"])
        ? Object.entries(node["fields"]).flatMap(([name, child]) =>
            isRecord(child) ? linksIn(child, value[name], `${path}.${name}`) : [],
          )
        : [];
    default:
      return [];
  }
};

/** The types a node links to, anywhere inside it. */
const linkTypes = (node: SchemaNode): Array<string> => {
  const inner = (key: string) => (isRecord(node[key]) ? linkTypes(node[key]) : []);
  switch (node["type"]) {
    case "link":
      return [String(node["to"])];
    case "nullable":
      return inner("of");
    case "array":
      return inner("items");
    case "object":
      return isRecord(node["fields"])
        ? Object.values(node["fields"]).flatMap((child) =>
            isRecord(child) ? linkTypes(child) : [],
          )
        : [];
    default:
      return [];
  }
};

/** Why a value doesn't fit a node, or nothing when it does. */
const problemsIn = (node: SchemaNode, value: Json | undefined, path: string): Array<string> => {
  if (value === undefined) {
    return node["optional"] === true ? [] : [`${path} is required`];
  }
  const expect = (fits: boolean, what: string) => (fits ? [] : [`${path} must be ${what}`]);
  switch (node["type"]) {
    case "nullable":
      return value === null ? [] : problemsIn(node["of"] as SchemaNode, value, path);
    case "string": {
      if (typeof value !== "string") return [`${path} must be a string`];
      const minLength = node["minLength"];
      return [
        ...(typeof minLength === "number" && value.length < minLength
          ? [`${path} is shorter than ${minLength}`]
          : []),
        ...(node["format"] === "date" ? expect(isoDate.test(value), "a date") : []),
        ...(node["format"] === "datetime"
          ? expect(!Number.isNaN(Date.parse(value)), "a datetime")
          : []),
      ];
    }
    case "number":
      return expect(typeof value === "number", "a number");
    case "boolean":
      return expect(typeof value === "boolean", "a boolean");
    case "enum":
      return expect(
        Array.isArray(node["values"]) && node["values"].includes(value),
        `one of ${JSON.stringify(node["values"])}`,
      );
    case "link":
      return expect(typeof value === "string", "an entity id");
    case "array":
      return Array.isArray(value)
        ? value.flatMap((item, index) =>
            problemsIn(node["items"] as SchemaNode, item, `${path}.${index}`),
          )
        : [`${path} must be an array`];
    case "object":
      return isRecord(value)
        ? fieldProblems(node["fields"] as Record<string, SchemaNode>, value, `${path}.`)
        : [`${path} must be an object`];
    default:
      return [];
  }
};

const fieldProblems = (fields: Record<string, SchemaNode>, data: Data, prefix = "") => [
  ...Object.keys(data)
    .filter((name) => fields[name] === undefined)
    .map((name) => `${prefix}${name} is not a field`),
  ...Object.entries(fields).flatMap(([name, node]) =>
    problemsIn(node, data[name], `${prefix}${name}`),
  ),
];

/** RFC 7386: `null` removes a member, objects merge, anything else replaces. */
const mergePatch = (target: Data, patch: Data): Data => {
  const result: Data = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else {
      const current = result[key];
      result[key] = isRecord(value) && isRecord(current) ? mergePatch(current, value) : value;
    }
  }
  return result;
};

export interface FakeEntityStore extends EntityStoreRpc {
  /** Stores a type as given, skipping the checks `createType` makes. */
  readonly seedType: (name: string, description: string, schema: StoreSchema) => void;
  /** Stores a live entity at rev 1 as given, skipping write checks. */
  readonly seedEntity: (type: string, id: string, data: Data) => void;
  /** Every change, oldest first. */
  readonly changes: () => ReadonlyArray<ChangeEvent>;
  /** Fails calls of `method` with `error` until reset with `undefined`. */
  readonly failing: (
    method: keyof EntityStoreRpc,
    error: { readonly code: string; readonly message: string } | "throw" | undefined,
  ) => void;
}

export const makeFakeEntityStore = (): FakeEntityStore => {
  const types = new Map<string, Omit<TypeInfo, "latestVersion">>();
  const rows = new Map<string, Row>();
  const revisions = new Map<string, Array<Revision>>();
  const log: Array<ChangeEvent> = [];
  const failures = new Map<string, { readonly code: string; readonly message: string } | "throw">();
  let clock = 0;
  const now = () => ++clock;

  const latest = (name: string) => types.get(name)?.versions.at(-1);
  const summary = (info: Omit<TypeInfo, "latestVersion">) => ({
    name: info.name,
    description: info.description,
    latestVersion: info.versions.length,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
  });
  const info = (name: string) => {
    const found = types.get(name);
    return found === undefined ? undefined : { ...summary(found), versions: found.versions };
  };
  const entity = (row: Row) => {
    const version = types.get(row.type)?.versions.length ?? 1;
    return {
      id: row.id,
      type: row.type,
      version,
      storedVersion: version,
      rev: row.rev,
      data: row.data,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };
  const record = (row: Row, op: ChangeEvent["op"], meta: WriteMeta | null) => {
    const history = revisions.get(row.id) ?? [];
    history.push({
      rev: row.rev,
      op,
      data: row.data === null ? null : structuredClone(row.data),
      meta,
    });
    revisions.set(row.id, history);
    log.push({
      v: 1,
      seq: log.length + 1,
      type: row.type,
      id: row.id,
      rev: row.rev,
      op,
      meta: meta === null ? null : { ...meta },
      createdAt: row.updatedAt,
    });
  };

  /** Entities linking to `id`, judged by their type's latest schema. */
  const linkedFrom = (id: string) =>
    [...rows.values()].flatMap((row) => {
      const schema = latest(row.type)?.schema;
      if (row.data === null || schema === undefined) return [];
      return Object.entries(schema.fields).flatMap(([name, node]) =>
        linksIn(node, row.data?.[name], name)
          .filter((link) => link.target === id && row.id !== id)
          .map((link) => ({ source: row.id, type: row.type, path: link.path })),
      );
    });

  const schemaProblems = (name: string, schema: StoreSchema) => {
    const title = schema.title;
    const titleNode = title === undefined ? undefined : schema.fields[title];
    const titleType =
      titleNode?.["type"] === "nullable" && isRecord(titleNode["of"])
        ? titleNode["of"]["type"]
        : titleNode?.["type"];
    return [
      ...(title !== undefined && titleType !== "string"
        ? [{ path: "title", message: `title must name a string field` }]
        : []),
      ...Object.entries(schema.fields).flatMap(([field, node]) =>
        linkTypes(node)
          .filter((to) => to !== name && !types.has(to))
          .map((to) => ({ path: field, message: `links to ${to}, which doesn't exist` })),
      ),
    ];
  };

  const lensProblems = (from: StoreSchema, to: StoreSchema, ops: ReadonlyArray<Data>) =>
    ops.flatMap((op) => {
      const field = String(op["field"]);
      if (op["op"] === "add") {
        const node = to.fields[field];
        return node === undefined
          ? [`add ${field}: not in the new schema`]
          : node["optional"] !== true && !("default" in op)
            ? [`add ${field}: a required field needs a default`]
            : [];
      }
      if (op["op"] === "remove") {
        const node = from.fields[field];
        return node === undefined
          ? [`remove ${field}: not in the old schema`]
          : node["optional"] !== true && !("default" in op)
            ? [`remove ${field}: a required field needs a default`]
            : [];
      }
      return [`${String(op["op"])}: not supported by the fake`];
    });

  type Checked =
    | { readonly failed: Promise<unknown> }
    | {
        readonly failed?: undefined;
        readonly value: {
          readonly from: number;
          readonly to: number;
          readonly report: { readonly ok: boolean; readonly [key: string]: unknown };
        };
      };
  const check = (
    type: string,
    schema: StoreSchema,
    lens: { readonly ops: ReadonlyArray<Data> },
  ): Checked => {
    const from = latest(type);
    if (from === undefined) return { failed: err("TypeNotFound", `No type ${type}`) };
    const issues = schemaProblems(type, schema);
    if (issues.length > 0)
      return { failed: err("InvalidSchema", "The schema is invalid", { issues }) };
    const failures = lensProblems(from.schema, schema, lens.ops).map((error) => ({
      input: null,
      error,
    }));
    return {
      value: {
        from: from.version,
        to: from.version + 1,
        report: { ok: failures.length === 0, forward: { checked: 1, failures }, warnings: [] },
      },
    };
  };

  const metaProblem = (meta: WriteMeta | undefined) =>
    meta !== undefined && JSON.stringify(meta).length > 1024;

  const writeProblems = (type: string, data: Data, id: string) => {
    const schema = latest(type)?.schema;
    if (schema === undefined) return err("TypeNotFound", `No type ${type}`);
    const issues = fieldProblems(schema.fields, data);
    if (issues.length > 0) return err("ValidationFailed", issues.join("; "));
    const problems = Object.entries(schema.fields).flatMap(([name, node]) =>
      linksIn(node, data[name], name).flatMap((link) => {
        const target = rows.get(link.target);
        if (link.target === id && link.to === type) return [];
        return target === undefined || target.data === null || target.type !== link.to
          ? [{ path: link.path, target: link.target, message: `No live ${link.to} ${link.target}` }]
          : [];
      }),
    );
    return problems.length > 0
      ? err("LinkTargetInvalid", problems.map((problem) => problem.message).join("; "), {
          problems,
        })
      : undefined;
  };

  const rpc: EntityStoreRpc = {
    listTypes: () => ok([...types.values()].map(summary)),
    getType: (name) => {
      const found = info(name);
      return found === undefined ? err("TypeNotFound", `No type ${name}`) : ok(found);
    },
    createType: ({ name, description, schema }) => {
      if (types.has(name)) return err("TypeAlreadyExists", `Type ${name} already exists`);
      const issues = schemaProblems(name, schema);
      if (issues.length > 0) return err("InvalidSchema", "The schema is invalid", { issues });
      const at = now();
      const version: VersionInfo = { type: name, version: 1, schema, note: "", createdAt: at };
      types.set(name, {
        name,
        description: description ?? "",
        createdAt: at,
        updatedAt: at,
        versions: [version],
      });
      return ok(info(name));
    },
    checkVersion: (type, { schema, lens }) => {
      const result = check(type, schema, lens);
      return result.failed ?? ok(result.value);
    },
    createVersion: (type, { schema, lens, note, force }) => {
      const result = check(type, schema, lens);
      if (result.failed !== undefined) return result.failed;
      if (!result.value.report.ok && force !== true)
        return err("LensCheckFailed", "The lens check failed", { report: result.value.report });
      const found = types.get(type);
      if (found === undefined) return err("TypeNotFound", `No type ${type}`);
      const at = now();
      const version: VersionInfo = {
        type,
        version: result.value.to,
        schema,
        lens,
        note: note ?? "",
        createdAt: at,
      };
      types.set(type, { ...found, updatedAt: at, versions: [...found.versions, version] });
      // Reads lens stored data forward; storing it lensed is the same for add and remove.
      for (const row of rows.values()) {
        if (row.type !== type || row.data === null) continue;
        for (const op of lens.ops) {
          const field = String(op["field"]);
          if (op["op"] === "remove") delete row.data[field];
          if (op["op"] === "add" && "default" in op && !(field in row.data))
            row.data[field] = op["default"] ?? null;
        }
      }
      return ok({ version, report: result.value.report });
    },
    deleteType: (name) => {
      if (!types.has(name)) return err("TypeNotFound", `No type ${name}`);
      const live = [...rows.values()].filter((row) => row.type === name && row.data !== null);
      const linking = [...types.values()].filter(
        (other) =>
          other.name !== name &&
          Object.values(other.versions.at(-1)?.schema.fields ?? {}).some((node) =>
            linkTypes(node).includes(name),
          ),
      );
      const reasons = [
        ...(live.length > 0 ? [`it has ${live.length} live entities`] : []),
        ...linking.map((other) => `${other.name} links to it`),
      ];
      if (reasons.length > 0)
        return err("TypeInUse", `Type ${name} is in use`, { type: name, reasons });
      types.delete(name);
      for (const row of rows.values()) {
        if (row.type !== name) continue;
        rows.delete(row.id);
        revisions.delete(row.id);
      }
      for (let index = log.length - 1; index >= 0; index--) {
        if (log[index]?.type === name) log.splice(index, 1);
      }
      return ok({ name });
    },
    listEntities: (type, options) => {
      if (!types.has(type)) return err("TypeNotFound", `No type ${type}`);
      const limit = Math.min(options?.limit ?? 50, 200);
      const live = [...rows.values()]
        .filter((row) => row.type === type && row.data !== null)
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .filter((row) => options?.cursor === undefined || row.id > options.cursor);
      const items = live.slice(0, limit);
      const last = items.at(-1);
      return ok({
        items: items.map(entity),
        failures: [],
        ...(live.length > limit && last !== undefined ? { nextCursor: last.id } : {}),
      });
    },
    getEntity: (id) => {
      const row = rows.get(id);
      if (row === undefined) return err("EntityNotFound", `No entity ${id}`);
      if (row.data === null) return err("EntityDeleted", `${id} was deleted`, { rev: row.rev });
      return ok(entity(row));
    },
    upsertEntity: (type, id, { patch, expectedRev, meta }) => {
      if (metaProblem(meta)) return err("BadRequest", "meta is larger than 1 KB");
      if (!types.has(type)) return err("TypeNotFound", `No type ${type}`);
      const row = rows.get(id);
      if (row !== undefined && row.type !== type)
        return err("EntityTypeMismatch", `${id} is a ${row.type}`, { id, type, actual: row.type });
      const live = row !== undefined && row.data !== null;
      if (expectedRev !== undefined && expectedRev !== (live ? row.rev : 0))
        // A deleted entity reports 0, as one that never existed does.
        return err("RevConflict", `${id} is at another revision`, {
          currentRev: live ? row.rev : 0,
        });
      const data = live ? mergePatch(row.data ?? {}, patch) : mergePatch({}, patch);
      const problem = writeProblems(type, data, id);
      if (problem !== undefined) return problem;
      const at = now();
      const next: Row =
        row === undefined
          ? { id, type, rev: 1, data, createdAt: at, updatedAt: at }
          : { ...row, rev: row.rev + 1, data, updatedAt: at, createdAt: live ? row.createdAt : at };
      rows.set(id, next);
      record(next, live ? "patch" : "create", meta ?? null);
      return ok({ entity: entity(next), created: !live });
    },
    deleteEntity: (id, options) => {
      if (metaProblem(options?.meta)) return err("BadRequest", "meta is larger than 1 KB");
      const row = rows.get(id);
      if (row === undefined) return err("EntityNotFound", `No entity ${id}`);
      if (row.data === null) return err("EntityDeleted", `${id} was deleted`, { rev: row.rev });
      if (options?.expectedRev !== undefined && options.expectedRev !== row.rev)
        return err("RevConflict", `${id} is at another revision`, { currentRev: row.rev });
      const linked = linkedFrom(id);
      if (linked.length > 0)
        return err(
          "EntityLinked",
          `${id} is linked from ${linked.map((link) => link.source).join(", ")}`,
          {
            linkedFrom: linked,
          },
        );
      const next: Row = { ...row, rev: row.rev + 1, data: null, updatedAt: now() };
      rows.set(id, next);
      record(next, "delete", options?.meta ?? null);
      return ok({ id, rev: next.rev });
    },
    getChange: (id, rev) => {
      const history = revisions.get(id) ?? [];
      const at = history.find((revision) => revision.rev === rev);
      const event = log.find((change) => change.id === id && change.rev === rev);
      if (at === undefined || event === undefined)
        return err("ChangeNotFound", `No change at revision ${rev} of ${id}`);
      const previous = history.find((revision) => revision.rev === rev - 1);
      return ok({
        ...event,
        version: types.get(event.type)?.versions.length ?? 1,
        before: previous?.data ?? null,
        after: at.data,
      });
    },
  };

  /** Fails a method as `failing` says, and copies arguments as a real binding does. */
  const guard =
    <A extends ReadonlyArray<unknown>>(
      method: keyof EntityStoreRpc,
      implementation: (...args: A) => Promise<unknown>,
    ) =>
    (...args: A): Promise<unknown> => {
      const failure = failures.get(method);
      if (failure === "throw") return Promise.reject(new Error(`${method} is unreachable`));
      if (failure !== undefined) return err(failure.code, failure.message);
      return implementation(...(structuredClone(args) as A));
    };
  const guarded: EntityStoreRpc = {
    listTypes: guard("listTypes", rpc.listTypes),
    getType: guard("getType", rpc.getType),
    createType: guard("createType", rpc.createType),
    checkVersion: guard("checkVersion", rpc.checkVersion),
    createVersion: guard("createVersion", rpc.createVersion),
    deleteType: guard("deleteType", rpc.deleteType),
    listEntities: guard("listEntities", rpc.listEntities),
    getEntity: guard("getEntity", rpc.getEntity),
    upsertEntity: guard("upsertEntity", rpc.upsertEntity),
    deleteEntity: guard("deleteEntity", rpc.deleteEntity),
    getChange: guard("getChange", rpc.getChange),
  };

  return {
    ...guarded,
    seedType: (name, description, schema) => {
      const at = now();
      types.set(name, {
        name,
        description,
        createdAt: at,
        updatedAt: at,
        versions: [{ type: name, version: 1, schema, note: "", createdAt: at }],
      });
    },
    seedEntity: (type, id, data) => {
      const at = now();
      const row: Row = {
        id,
        type,
        rev: 1,
        data: structuredClone(data),
        createdAt: at,
        updatedAt: at,
      };
      rows.set(id, row);
      record(row, "create", null);
    },
    changes: () => structuredClone(log),
    failing: (method, error) => {
      if (error === undefined) failures.delete(method);
      else failures.set(method, error);
    },
  };
};
