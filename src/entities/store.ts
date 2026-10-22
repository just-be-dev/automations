/**
 * The entity store as the rest of automations uses it. Entity types, entities and roles live in
 * entity-store, reached through `EntityStoreApi`; templates and trigger subscriptions stay in
 * automations' own storage. This module applies automations' rules on top: type and field names,
 * role members who can approve, and the dependencies that keep a type from being deleted.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  LensReport,
  type EntityStoreApi,
  type EntityStoreApiError,
  type StoreSchema,
  type StoredEntity,
  type TypeInfo,
  type WriteMeta,
} from "./entity-store-api.ts";
import {
  planTypeWrite,
  ROLE_MEMBER_TYPE,
  ROLE_TYPE,
  roleData,
  roleFromEntity,
  roleSchema,
  toEntityData,
  toEntityType,
  type TypeWrite,
} from "./entity-store-types.ts";
import {
  checkEntityData,
  checkEntityType,
  InvalidEntity,
  isEmailField,
  type EntityData,
  type EntityRecord,
  type EntityType,
  type Role,
  type Subject,
} from "./model.ts";
import { checkTemplate, type InvalidTemplate, type Template } from "./templates.ts";

export class EntityStoreError extends Schema.TaggedError<EntityStoreError>()("EntityStoreError", {
  message: Schema.String,
}) {}

/** A conditional write found the entity at another revision than it expected. Nothing was written. */
export class EntityRevConflict extends Schema.TaggedError<EntityRevConflict>()(
  "EntityRevConflict",
  { message: Schema.String },
) {}

/** An entity before and after a write. `before` is missing for a new entity. */
export interface EntityChange {
  readonly before: EntityData | undefined;
  readonly after: Subject;
}

/** What writing an entity does, or did. */
export interface EntityWrite {
  readonly before: EntityRecord | undefined;
  readonly after: Subject;
  /** The live revision the write is conditioned on: 0 for an entity that doesn't exist yet. */
  readonly expectedRev: number;
  /** The revision the write makes. */
  readonly rev: number;
}

/** What deleting an entity does, or did. */
export interface EntityDeletion {
  readonly before: EntityRecord;
  readonly expectedRev: number;
  readonly rev: number;
}

/** A committed change to an entity, as entity-store recorded it. */
export interface StoredChange {
  readonly type: string;
  readonly id: string;
  readonly rev: number;
  readonly op: "create" | "replace" | "patch" | "delete";
  readonly meta: WriteMeta | null;
  /** The entity's type as automations sees it, or `undefined` when automations can't use it. */
  readonly entityType: EntityType | undefined;
  /** The data at `rev - 1` and at `rev`, as automations sees it; `null` where there was none. */
  readonly before: EntityData | null;
  readonly after: EntityData | null;
}

/** A write's condition and its metadata, stored with its change. */
export interface WriteOptions {
  /** Fail with `EntityRevConflict` unless the entity is at this revision (0: doesn't exist). */
  readonly expectedRev?: number;
  readonly meta?: WriteMeta;
}

export class EntityStore extends Context.Service<
  EntityStore,
  {
    readonly listTypes: Effect.Effect<ReadonlyArray<EntityType>, EntityStoreError>;
    /** Checks a type as `putType` would, without writing, and returns what it would store. */
    readonly checkType: (
      type: EntityType,
    ) => Effect.Effect<EntityType, EntityStoreError | InvalidEntity>;
    /**
     * Creates a type, or adds a version to it whose lens adds and removes fields. Entities written
     * before keep their data; entity-store lenses it to the new version when it's read. A field
     * can't change kind here: that needs a lens authored in entity-store.
     */
    readonly putType: (
      type: EntityType,
    ) => Effect.Effect<EntityType, EntityStoreError | InvalidEntity>;
    /**
     * Checks that a type can be deleted, and whether there is one. Nothing may depend on it: no
     * entities, no other type's `ref` field, template slot or role member, and no saved automation
     * watching it.
     */
    readonly checkDeleteType: (
      name: string,
    ) => Effect.Effect<boolean, EntityStoreError | InvalidEntity>;
    readonly deleteType: (name: string) => Effect.Effect<void, EntityStoreError | InvalidEntity>;
    readonly listEntities: (
      type: string,
    ) => Effect.Effect<ReadonlyArray<EntityRecord>, EntityStoreError>;
    readonly getEntity: (
      type: string,
      id: string,
    ) => Effect.Effect<EntityRecord | undefined, EntityStoreError>;
    /** Checks a write as `putEntity` would, without writing, and returns what it would do. */
    readonly checkEntity: (
      type: string,
      id: string,
      data: EntityData,
    ) => Effect.Effect<EntityWrite, EntityStoreError | InvalidEntity>;
    /**
     * Creates or updates an entity, merging `data` over its fields; `null` clears one. Entity IDs
     * are unique across types. The write is conditioned on the revision it read, or on
     * `options.expectedRev`.
     */
    readonly putEntity: (
      type: string,
      id: string,
      data: EntityData,
      options?: WriteOptions,
    ) => Effect.Effect<EntityWrite, EntityStoreError | InvalidEntity | EntityRevConflict>;
    /** Checks a deletion as `deleteEntity` would, or `undefined` when there's no such entity. */
    readonly checkDeleteEntity: (
      type: string,
      id: string,
    ) => Effect.Effect<EntityDeletion | undefined, EntityStoreError | InvalidEntity>;
    /**
     * Deletes an entity and returns what it held, or `undefined` when there was none. Nothing is
     * notified here: entity-store's change queue reaches automations, which publishes
     * `entity.deleted`. An entity others link to, such as a role's member, can't be deleted.
     */
    readonly deleteEntity: (
      type: string,
      id: string,
      options?: WriteOptions,
    ) => Effect.Effect<
      EntityRecord | undefined,
      EntityStoreError | InvalidEntity | EntityRevConflict
    >;
    /** The change that made revision `rev` of an entity, or `undefined` when there's none. */
    readonly getChange: (
      id: string,
      rev: number,
    ) => Effect.Effect<StoredChange | undefined, EntityStoreError>;
    /** Records which entity type an automation's saved workflow watches, or that it watches none. */
    readonly subscribe: (
      automationId: string,
      type: string | undefined,
    ) => Effect.Effect<void, EntityStoreError>;
    /** The automations watching an entity type. */
    readonly subscribers: (type: string) => Effect.Effect<ReadonlyArray<string>, EntityStoreError>;
    readonly listTemplates: Effect.Effect<ReadonlyArray<Template>, EntityStoreError>;
    readonly getTemplate: (name: string) => Effect.Effect<Template | undefined, EntityStoreError>;
    /** Creates or replaces a template once it checks against the entity types. */
    readonly putTemplate: (
      template: Template,
    ) => Effect.Effect<Template, EntityStoreError | InvalidTemplate>;
    /** Deletes a template. Saved workflows that use it fail their check when they next start. */
    readonly deleteTemplate: (name: string) => Effect.Effect<void, EntityStoreError>;
    readonly listRoles: Effect.Effect<ReadonlyArray<Role>, EntityStoreError>;
    /** Creates or replaces a role, once every member is a stored employee with an email. */
    readonly putRole: (role: Role) => Effect.Effect<Role, EntityStoreError | InvalidEntity>;
    /**
     * Deletes a role. Saved workflows that ask it fail their check when they next start, and
     * approval tasks already open keep the members they recorded.
     */
    readonly deleteRole: (name: string) => Effect.Effect<void, EntityStoreError>;
  }
>()("automations/EntityStore") {}

/** What automations keeps itself: templates and trigger subscriptions. */
export interface CatalogStorage {
  readonly subscribe: (
    automationId: string,
    type: string | undefined,
  ) => Effect.Effect<void, EntityStoreError>;
  readonly subscribers: (type: string) => Effect.Effect<ReadonlyArray<string>, EntityStoreError>;
  readonly listTemplates: Effect.Effect<ReadonlyArray<Template>, EntityStoreError>;
  readonly writeTemplate: (template: Template) => Effect.Effect<void, EntityStoreError>;
  readonly deleteTemplate: (name: string) => Effect.Effect<void, EntityStoreError>;
}

/**
 * Type versions never change once written, so their schemas can be kept for as long as the store
 * lives. Keyed by name, creation time and latest version, so a type deleted and created again
 * isn't mistaken for the old one.
 */
export type TypeCache = Map<string, TypeInfo>;

const storeError = (error: EntityStoreApiError) => new EntityStoreError({ message: error.message });

/** entity-store codes that mean the write can't apply as asked, rather than that it failed. */
const refusals = new Set([
  "BadRequest",
  "EntityLinked",
  "EntityTypeMismatch",
  "IndexKeyFailed",
  "InvalidSchema",
  "LensCheckFailed",
  "LinkTargetInvalid",
  "ProjectionFailed",
  "TypeAlreadyExists",
  "TypeInUse",
  "TypeNotFound",
  "UniqueViolation",
  "ValidationFailed",
]);

const refusal = (error: EntityStoreApiError) =>
  refusals.has(error.code) ? new InvalidEntity({ message: error.message }) : storeError(error);

const writeError = (error: EntityStoreApiError) =>
  error.code === "RevConflict" ? new EntityRevConflict({ message: error.message }) : refusal(error);

/** Treats one entity-store code as "there's nothing there". */
const orMissing =
  (...codes: ReadonlyArray<string>) =>
  <A, R>(effect: Effect.Effect<A, EntityStoreApiError, R>) =>
    effect.pipe(
      Effect.map((value): A | undefined => value),
      Effect.catchIf(
        (error) => codes.includes(error.code),
        () => Effect.succeed(undefined),
      ),
    );

/** RFC 7386 for a flat record, as entity-store applies `upsertEntity`'s patch to it. */
const mergePatch = (target: EntityData, patch: EntityData): EntityData =>
  Object.fromEntries(
    Object.entries({ ...target, ...patch }).filter(
      ([name, value]) => !(name in patch && value === null),
    ),
  );

/** Builds the service over entity-store and automations' own catalog storage. */
export const makeEntityStore = (
  api: EntityStoreApi["Service"],
  catalog: CatalogStorage,
  cache: TypeCache = new Map(),
) => {
  const typeInfos = Effect.gen(function* () {
    const summaries = yield* api.listTypes;
    return yield* Effect.forEach(
      summaries,
      (summary) => {
        const key = `${summary.name}@${summary.createdAt}@${summary.latestVersion}`;
        const cached = cache.get(key);
        return cached === undefined
          ? api.getType(summary.name).pipe(
              Effect.tap((info) => Effect.sync(() => cache.set(key, info))),
              orMissing("TypeNotFound"),
            )
          : Effect.succeed(cached);
      },
      { concurrency: 4 },
    );
  }).pipe(
    Effect.map((infos) => infos.flatMap((info) => (info === undefined ? [] : [info]))),
    Effect.mapError(storeError),
  );

  const listTypes = typeInfos.pipe(
    Effect.map((infos) =>
      infos
        .flatMap((info) => {
          const type = toEntityType(info);
          return type === undefined ? [] : [type];
        })
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    ),
  );

  const typeInfo = (name: string) =>
    api.getType(name).pipe(orMissing("TypeNotFound"), Effect.mapError(storeError));

  const typeOf = (name: string) =>
    Effect.map(typeInfo(name), (info) => (info === undefined ? undefined : toEntityType(info)));

  /** An entity as entity-store holds it: live, deleted at a revision, or never written. */
  const readEntity = (id: string) =>
    api.getEntity(id).pipe(
      Effect.map((entity) => ({ kind: "live", entity }) as const),
      Effect.catchIf(
        (error) => error.code === "EntityNotFound" || error.code === "EntityDeleted",
        (error) => {
          const rev = error.details["rev"];
          return Effect.succeed({
            kind: "absent",
            rev: error.code === "EntityDeleted" && typeof rev === "number" ? rev : 0,
          } as const);
        },
      ),
      Effect.mapError(storeError),
    );

  const toRecord = (type: EntityType, entity: StoredEntity): EntityRecord => ({
    type: entity.type,
    id: entity.id,
    data: toEntityData(type, entity.data),
    updatedAt: entity.updatedAt,
  });

  /** Every page of a type's entities, as entity-store holds them. */
  const allEntities = (type: string) =>
    Effect.gen(function* () {
      const items: Array<StoredEntity> = [];
      let cursor: string | undefined;
      do {
        const page = yield* api.listEntities(type, {
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        });
        items.push(...page.items);
        for (const failure of page.failures) {
          yield* Effect.logWarning("entity-store couldn't present an entity").pipe(
            Effect.annotateLogs({ type, id: failure.id, error: failure.error }),
          );
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return items;
    }).pipe(orMissing("TypeNotFound"), Effect.mapError(storeError));

  const listRoles = allEntities(ROLE_TYPE).pipe(
    Effect.map((entities) =>
      (entities ?? []).flatMap((entity) => {
        const role = roleFromEntity(entity.id, entity.data);
        return role === undefined ? [] : [role];
      }),
    ),
  );

  /**
   * The names of the roles with a member of `type`, or with that one entity when `id` is given.
   * Their members must stay people who can approve: stored, with an email address.
   */
  const rolesWith = (type: string, id?: string) =>
    Effect.map(listRoles, (roles) =>
      roles
        .filter((role) =>
          role.members.some(
            (member) => member.type === type && (id === undefined || member.id === id),
          ),
        )
        .map((role) => role.name),
    );

  const getEntity = Effect.fn("EntityStore.getEntity")(function* (typeName: string, id: string) {
    const found = yield* readEntity(id);
    if (found.kind !== "live" || found.entity.type !== typeName) {
      return undefined;
    }
    const type = yield* typeOf(typeName);
    return type === undefined ? undefined : toRecord(type, found.entity);
  });

  const planType = Effect.fn("EntityStore.planType")(function* (type: EntityType) {
    if (type.name === ROLE_TYPE) {
      return yield* new InvalidEntity({
        message: `${ROLE_TYPE} is reserved for roles; choose another type name`,
      });
    }
    const infos = yield* typeInfos;
    const others = infos.flatMap((info) => {
      const other = info.name === type.name ? undefined : toEntityType(info);
      return other === undefined ? [] : [other];
    });
    yield* checkEntityType(others, type);
    const roles = yield* rolesWith(type.name);
    if (roles.length > 0 && !type.fields.some(isEmailField)) {
      return yield* new InvalidEntity({
        message: `${type.name} needs a text field named email: roles have members of it (${roles.join(", ")})`,
      });
    }
    const existing = infos.find((info) => info.name === type.name);
    const plan = planTypeWrite(existing, type);
    if (plan.kind === "refused") {
      return yield* new InvalidEntity({ message: plan.message });
    }
    return { plan, stored: storedType(existing, plan) ?? type };
  });

  /** What reads give back once a plan is written. */
  const storedType = (existing: TypeInfo | undefined, plan: TypeWrite) => {
    const withVersion = (info: TypeInfo | undefined, schema: StoreSchema) =>
      info === undefined
        ? undefined
        : toEntityType({
            ...info,
            versions: [
              ...info.versions,
              {
                type: info.name,
                version: info.versions.length + 1,
                schema,
                note: "",
                createdAt: 0,
              },
            ],
          });
    switch (plan.kind) {
      case "create":
        return withVersion(
          { ...plan.input, latestVersion: 0, createdAt: 0, updatedAt: 0, versions: [] },
          plan.input.schema,
        );
      case "version":
        return withVersion(existing, plan.schema);
      default:
        return existing === undefined ? undefined : toEntityType(existing);
    }
  };

  const checkDeleteType = Effect.fn("EntityStore.checkDeleteType")(function* (name: string) {
    const types = yield* listTypes;
    if (!types.some((type) => type.name === name)) {
      return false;
    }
    const referrers = types.flatMap((type) =>
      type.name === name
        ? []
        : type.fields.flatMap((field) => (field.to === name ? [`${type.name}.${field.name}`] : [])),
    );
    const slots = (yield* catalog.listTemplates).flatMap((template) =>
      template.slots.flatMap((slot) => (slot.to === name ? [`${template.name}.${slot.name}`] : [])),
    );
    const entities = yield* api
      .listEntities(name, { limit: 1 })
      .pipe(orMissing("TypeNotFound"), Effect.mapError(storeError));
    const watchers = yield* catalog.subscribers(name);
    const roles = yield* rolesWith(name);
    const problems = [
      ...((entities?.items.length ?? 0) === 0 ? [] : ["it still has entities"]),
      ...(referrers.length === 0 ? [] : [`${referrers.join(", ")} points to it`]),
      ...(slots.length === 0 ? [] : [`template slots point to it: ${slots.join(", ")}`]),
      ...(watchers.length === 0 ? [] : [`automations watch it: ${watchers.join(", ")}`]),
      ...(roles.length === 0 ? [] : [`roles have members of it: ${roles.join(", ")}`]),
    ];
    if (problems.length > 0) {
      return yield* new InvalidEntity({ message: `Can't delete ${name}: ${problems.join("; ")}` });
    }
    return true;
  });

  const checkEntity = Effect.fn("EntityStore.checkEntity")(function* (
    typeName: string,
    id: string,
    data: EntityData,
  ) {
    const type = yield* typeOf(typeName);
    if (type === undefined) {
      return yield* new InvalidEntity({ message: `Unknown entity type ${typeName}` });
    }
    yield* checkEntityData(type, data);
    const found = yield* readEntity(id);
    if (found.kind === "live" && found.entity.type !== typeName) {
      return yield* new InvalidEntity({
        message: `${id} is already used by ${found.entity.type} ${id}; entity IDs are unique across types`,
      });
    }
    const before = found.kind === "live" ? toRecord(type, found.entity) : undefined;
    const merged = mergePatch(before?.data ?? {}, data);
    const email = merged["email"];
    if (typeof email !== "string" || email === "") {
      const roles = yield* rolesWith(typeName, id);
      if (roles.length > 0) {
        return yield* new InvalidEntity({
          message: `${typeName} ${id} needs an email: it is a member of ${roles.join(", ")}`,
        });
      }
    }
    const expectedRev = found.kind === "live" ? found.entity.rev : 0;
    const write: EntityWrite = {
      before,
      after: { type: typeName, id, data: merged },
      expectedRev,
      rev: (found.kind === "live" ? found.entity.rev : found.rev) + 1,
    };
    return write;
  });

  const checkDeleteEntity = Effect.fn("EntityStore.checkDeleteEntity")(function* (
    typeName: string,
    id: string,
  ) {
    const before = yield* getEntity(typeName, id);
    if (before === undefined) {
      return undefined;
    }
    const roles = yield* rolesWith(typeName, id);
    if (roles.length > 0) {
      return yield* new InvalidEntity({
        message: `Can't delete ${typeName} ${id}: it is a member of ${roles.join(", ")}. Take it out of them first.`,
      });
    }
    const found = yield* readEntity(id);
    const rev = found.kind === "live" ? found.entity.rev : 0;
    const deletion: EntityDeletion = { before, expectedRev: rev, rev: rev + 1 };
    return deletion;
  });

  const stale = (expected: number, actual: number) =>
    new EntityRevConflict({
      message: `Expected revision ${expected}, but the entity is at revision ${actual}`,
    });

  return EntityStore.of({
    listTypes,
    checkType: Effect.fn("EntityStore.checkType")(function* (type: EntityType) {
      const { plan, stored } = yield* planType(type);
      if (plan.kind === "version") {
        const { report } = yield* api
          .checkVersion(type.name, { schema: plan.schema, lens: plan.lens })
          .pipe(Effect.mapError(refusal));
        const { ok } = yield* Schema.decodeUnknownEffect(LensReport)(report).pipe(
          Effect.mapError((error) => new EntityStoreError({ message: error.message })),
        );
        if (!ok) {
          return yield* new InvalidEntity({
            message: `entity-store's check of the new version failed: ${JSON.stringify(report)}`,
          });
        }
      }
      return stored;
    }),
    putType: Effect.fn("EntityStore.putType")(function* (type: EntityType) {
      const { plan, stored } = yield* planType(type);
      const written =
        plan.kind === "create"
          ? api.createType(plan.input)
          : plan.kind === "version"
            ? api.createVersion(type.name, {
                schema: plan.schema,
                lens: plan.lens,
                note: "Saved in automations",
              })
            : Effect.void;
      yield* written.pipe(Effect.mapError(refusal));
      return stored;
    }),
    checkDeleteType,
    deleteType: Effect.fn("EntityStore.deleteType")(function* (name: string) {
      if (!(yield* checkDeleteType(name))) {
        return;
      }
      yield* api.deleteType(name).pipe(
        orMissing("TypeNotFound"),
        Effect.mapError((error) => {
          const reasons = error.details["reasons"];
          return error.code === "TypeInUse" && Array.isArray(reasons)
            ? new InvalidEntity({ message: `Can't delete ${name}: ${reasons.join("; ")}` })
            : refusal(error);
        }),
      );
    }),
    listEntities: Effect.fn("EntityStore.listEntities")(function* (typeName: string) {
      const type = yield* typeOf(typeName);
      if (type === undefined) {
        return [];
      }
      return ((yield* allEntities(typeName)) ?? []).map((entity) => toRecord(type, entity));
    }),
    getEntity,
    checkEntity,
    putEntity: Effect.fn("EntityStore.putEntity")(function* (
      typeName: string,
      id: string,
      data: EntityData,
      options?: WriteOptions,
    ) {
      const write = yield* checkEntity(typeName, id, data);
      if (options?.expectedRev !== undefined && options.expectedRev !== write.expectedRev) {
        return yield* stale(options.expectedRev, write.expectedRev);
      }
      const { entity } = yield* api
        .upsertEntity(typeName, id, {
          patch: data,
          expectedRev: write.expectedRev,
          ...(options?.meta === undefined ? {} : { meta: options.meta }),
        })
        .pipe(Effect.mapError(writeError));
      const type = yield* typeOf(typeName);
      const done: EntityWrite = {
        ...write,
        after: {
          type: typeName,
          id,
          data: type === undefined ? write.after.data : toEntityData(type, entity.data),
        },
        rev: entity.rev,
      };
      return done;
    }),
    checkDeleteEntity,
    deleteEntity: Effect.fn("EntityStore.deleteEntity")(function* (
      typeName: string,
      id: string,
      options?: WriteOptions,
    ) {
      const deletion = yield* checkDeleteEntity(typeName, id);
      if (deletion === undefined) {
        return undefined;
      }
      if (options?.expectedRev !== undefined && options.expectedRev !== deletion.expectedRev) {
        return yield* stale(options.expectedRev, deletion.expectedRev);
      }
      yield* api
        .deleteEntity(id, {
          expectedRev: deletion.expectedRev,
          ...(options?.meta === undefined ? {} : { meta: options.meta }),
        })
        .pipe(
          Effect.mapError((error) =>
            error.code === "EntityLinked"
              ? new InvalidEntity({
                  message: `Can't delete ${typeName} ${id}: other entities link to it. ${error.message}`,
                })
              : writeError(error),
          ),
        );
      return deletion.before;
    }),
    getChange: Effect.fn("EntityStore.getChange")(function* (id: string, rev: number) {
      const change = yield* api
        .getChange(id, rev)
        .pipe(
          orMissing("RevisionNotFound", "EntityNotFound", "TypeNotFound"),
          Effect.mapError(storeError),
        );
      if (change === undefined) {
        return undefined;
      }
      const entityType = yield* typeOf(change.type);
      const data = (value: Schema.Json) =>
        value === null || entityType === undefined ? null : toEntityData(entityType, value);
      const stored: StoredChange = {
        type: change.type,
        id: change.id,
        rev: change.rev,
        op: change.op,
        meta: change.meta,
        entityType,
        before: data(change.before),
        after: data(change.after),
      };
      return stored;
    }),
    subscribe: catalog.subscribe,
    subscribers: catalog.subscribers,
    listTemplates: catalog.listTemplates,
    getTemplate: (name) =>
      catalog.listTemplates.pipe(
        Effect.map((templates) => templates.find((template) => template.name === name)),
      ),
    putTemplate: Effect.fn("EntityStore.putTemplate")(function* (template: Template) {
      yield* checkTemplate(yield* listTypes, template);
      yield* catalog.writeTemplate(template);
      return template;
    }),
    deleteTemplate: catalog.deleteTemplate,
    listRoles,
    putRole: Effect.fn("EntityStore.putRole")(function* (role: Role) {
      const type = yield* typeOf(ROLE_MEMBER_TYPE);
      const problems = yield* Effect.forEach(role.members, (member) =>
        Effect.gen(function* () {
          if (member.type !== ROLE_MEMBER_TYPE) {
            return [
              `Role members are ${ROLE_MEMBER_TYPE}s, so ${member.type} ${member.id} can't be one`,
            ];
          }
          if (type === undefined || !type.fields.some(isEmailField)) {
            return [`${ROLE_MEMBER_TYPE} has no email field, so it can't have members`];
          }
          const found = yield* getEntity(member.type, member.id);
          if (found === undefined) {
            return [`No ${member.type} ${member.id}`];
          }
          const email = found.data["email"];
          return typeof email === "string" && email !== ""
            ? []
            : [`${member.type} ${member.id} has no email`];
        }),
      );
      if (problems.flat().length > 0) {
        return yield* new InvalidEntity({ message: [...new Set(problems.flat())].join("; ") });
      }
      if ((yield* typeInfo(ROLE_TYPE)) === undefined) {
        yield* api
          .createType({ name: ROLE_TYPE, description: "Roles", schema: roleSchema })
          .pipe(orMissing("TypeAlreadyExists"), Effect.mapError(refusal));
      }
      yield* api.upsertEntity(ROLE_TYPE, role.name, { patch: roleData(role) }).pipe(
        Effect.mapError((error) =>
          error.code === "EntityTypeMismatch"
            ? new InvalidEntity({
                message: `${role.name} is already used by ${String(error.details["actual"])} ${role.name}; choose another role name`,
              })
            : refusal(error),
        ),
      );
      return role;
    }),
    deleteRole: Effect.fn("EntityStore.deleteRole")(function* (name: string) {
      const found = yield* readEntity(name);
      if (found.kind !== "live" || found.entity.type !== ROLE_TYPE) {
        return;
      }
      yield* api
        .deleteEntity(name, { expectedRev: found.entity.rev })
        .pipe(orMissing("EntityNotFound", "EntityDeleted"), Effect.mapError(storeError));
    }),
  });
};
