import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  checkEntityData,
  isEmailField,
  checkEntityType,
  InvalidEntity,
  type EntityData,
  type EntityRecord,
  type EntityType,
  type Role,
  type Subject,
} from "./entities.ts";
import { checkTemplate, type InvalidTemplate, type Template } from "./templates.ts";

/**
 * Where entity types, entities, templates, roles, and subscriptions to entity changes live. Templates sit
 * beside the types because each one is checked against them. `EntityStore` is the service steps,
 * triggers, and the API use; `src/entity-store-d1.ts` implements it on D1, and `layerMemory` below
 * implements it in memory for tests.
 */

export class EntityStoreError extends Schema.TaggedError<EntityStoreError>()("EntityStoreError", {
  message: Schema.String,
}) {}

/** An entity before and after a write. `before` is missing for a new entity. */
export interface EntityChange {
  readonly before: EntityData | undefined;
  readonly after: Subject;
}

export class EntityStore extends Context.Service<
  EntityStore,
  {
    readonly listTypes: Effect.Effect<ReadonlyArray<EntityType>, EntityStoreError>;
    /**
     * Creates or replaces an entity type. Stored entities aren't rewritten: the next write to one
     * drops the values of fields the type no longer has, and must fix any value a changed field no
     * longer accepts.
     */
    readonly putType: (
      type: EntityType,
    ) => Effect.Effect<EntityType, EntityStoreError | InvalidEntity>;
    /**
     * Deletes an entity type that nothing depends on: it has no entities, no other type's `ref`
     * field or template slot points to it, and no saved automation watches it.
     */
    readonly deleteType: (name: string) => Effect.Effect<void, EntityStoreError | InvalidEntity>;
    readonly listEntities: (
      type: string,
    ) => Effect.Effect<ReadonlyArray<EntityRecord>, EntityStoreError>;
    readonly getEntity: (
      type: string,
      id: string,
    ) => Effect.Effect<EntityRecord | undefined, EntityStoreError>;
    /**
     * Creates or updates an entity, merging `data` over its stored fields and checking the result
     * against its type.
     */
    readonly putEntity: (
      type: string,
      id: string,
      data: EntityData,
    ) => Effect.Effect<EntityChange, EntityStoreError | InvalidEntity>;
    /**
     * Deletes an entity and returns what it held, or `undefined` when there was none. Deleting
     * starts no runs, and `ref` fields that pointed to it read as `null`.
     */
    readonly deleteEntity: (
      type: string,
      id: string,
    ) => Effect.Effect<EntityRecord | undefined, EntityStoreError>;
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
    /** Creates or replaces a role, once every member is a stored entity with an email field. */
    readonly putRole: (role: Role) => Effect.Effect<Role, EntityStoreError | InvalidEntity>;
  }
>()("automations/EntityStore") {}

/** What an implementation stores and reads. `makeEntityStore` builds the service on top. */
export interface EntityStorage {
  readonly listTypes: Effect.Effect<ReadonlyArray<EntityType>, EntityStoreError>;
  readonly putType: (type: EntityType) => Effect.Effect<void, EntityStoreError>;
  readonly deleteType: (name: string) => Effect.Effect<void, EntityStoreError>;
  readonly listEntities: (
    type: string,
  ) => Effect.Effect<ReadonlyArray<EntityRecord>, EntityStoreError>;
  readonly getEntity: (
    type: string,
    id: string,
  ) => Effect.Effect<EntityRecord | undefined, EntityStoreError>;
  readonly writeEntity: (record: EntityRecord) => Effect.Effect<void, EntityStoreError>;
  readonly deleteEntity: (type: string, id: string) => Effect.Effect<void, EntityStoreError>;
  readonly subscribe: (
    automationId: string,
    type: string | undefined,
  ) => Effect.Effect<void, EntityStoreError>;
  readonly subscribers: (type: string) => Effect.Effect<ReadonlyArray<string>, EntityStoreError>;
  readonly listTemplates: Effect.Effect<ReadonlyArray<Template>, EntityStoreError>;
  readonly writeTemplate: (template: Template) => Effect.Effect<void, EntityStoreError>;
  readonly deleteTemplate: (name: string) => Effect.Effect<void, EntityStoreError>;
  readonly listRoles: Effect.Effect<ReadonlyArray<Role>, EntityStoreError>;
  readonly putRole: (role: Role) => Effect.Effect<void, EntityStoreError>;
}

/** Builds the service over an implementation's storage, so every one merges and checks alike. */
export const makeEntityStore = (storage: EntityStorage) =>
  EntityStore.of({
    listTypes: storage.listTypes,
    putType: Effect.fn("EntityStore.putType")(function* (type: EntityType) {
      const others = (yield* storage.listTypes).filter((other) => other.name !== type.name);
      yield* checkEntityType(others, type);
      yield* storage.putType(type);
      return type;
    }),
    deleteType: Effect.fn("EntityStore.deleteType")(function* (name: string) {
      const types = yield* storage.listTypes;
      if (!types.some((type) => type.name === name)) {
        return;
      }
      const referrers = types.flatMap((type) =>
        type.name === name
          ? []
          : type.fields.flatMap((field) =>
              field.to === name ? [`${type.name}.${field.name}`] : [],
            ),
      );
      const slots = (yield* storage.listTemplates).flatMap((template) =>
        template.slots.flatMap((slot) =>
          slot.to === name ? [`${template.name}.${slot.name}`] : [],
        ),
      );
      const entities = yield* storage.listEntities(name);
      const watchers = yield* storage.subscribers(name);
      const problems = [
        ...(entities.length === 0
          ? []
          : [`it still has ${entities.length} ${entities.length === 1 ? "entity" : "entities"}`]),
        ...(referrers.length === 0 ? [] : [`${referrers.join(", ")} points to it`]),
        ...(slots.length === 0 ? [] : [`template slots point to it: ${slots.join(", ")}`]),
        ...(watchers.length === 0 ? [] : [`automations watch it: ${watchers.join(", ")}`]),
      ];
      if (problems.length > 0) {
        return yield* new InvalidEntity({
          message: `Can't delete ${name}: ${problems.join("; ")}`,
        });
      }
      yield* storage.deleteType(name);
    }),
    listEntities: storage.listEntities,
    getEntity: storage.getEntity,
    putEntity: Effect.fn("EntityStore.putEntity")(function* (
      typeName: string,
      id: string,
      data: EntityData,
    ) {
      const type = (yield* storage.listTypes).find((candidate) => candidate.name === typeName);
      if (type === undefined) {
        return yield* new InvalidEntity({ message: `Unknown entity type ${typeName}` });
      }
      const before = yield* storage.getEntity(typeName, id);
      // Fields the type no longer has are dropped rather than failing every later write.
      const kept = Object.fromEntries(
        Object.entries(before?.data ?? {}).filter(([name]) =>
          type.fields.some((field) => field.name === name),
        ),
      );
      const merged = yield* checkEntityData(type, { ...kept, ...data });
      const updatedAt = yield* Clock.currentTimeMillis;
      yield* storage.writeEntity({ type: typeName, id, data: merged, updatedAt });
      return { before: before?.data, after: { type: typeName, id, data: merged } };
    }),
    deleteEntity: Effect.fn("EntityStore.deleteEntity")(function* (type: string, id: string) {
      const found = yield* storage.getEntity(type, id);
      if (found !== undefined) {
        yield* storage.deleteEntity(type, id);
      }
      return found;
    }),
    subscribe: storage.subscribe,
    subscribers: storage.subscribers,
    listTemplates: storage.listTemplates,
    getTemplate: (name) =>
      storage.listTemplates.pipe(
        Effect.map((templates) => templates.find((template) => template.name === name)),
      ),
    putTemplate: Effect.fn("EntityStore.putTemplate")(function* (template: Template) {
      yield* checkTemplate(yield* storage.listTypes, template);
      yield* storage.writeTemplate(template);
      return template;
    }),
    deleteTemplate: storage.deleteTemplate,
    listRoles: storage.listRoles,
    putRole: Effect.fn("EntityStore.putRole")(function* (role: Role) {
      const types = yield* storage.listTypes;
      const problems = yield* Effect.forEach(role.members, (member) =>
        Effect.gen(function* () {
          const type = types.find((candidate) => candidate.name === member.type);
          if (type === undefined || !type.fields.some(isEmailField)) {
            return [`${member.type} has no email field, so it can't be a member`];
          }
          const found = yield* storage.getEntity(member.type, member.id);
          return found === undefined ? [`No ${member.type} ${member.id}`] : [];
        }),
      );
      if (problems.flat().length > 0) {
        return yield* new InvalidEntity({ message: problems.flat().join("; ") });
      }
      yield* storage.putRole(role);
      return role;
    }),
  });

/** An in-memory store, seeded with `types`, `entities`, `templates`, and `roles`. */
export const layerMemory = (seed: {
  readonly types?: ReadonlyArray<EntityType>;
  readonly entities?: ReadonlyArray<EntityRecord>;
  readonly templates?: ReadonlyArray<Template>;
  readonly roles?: ReadonlyArray<Role>;
}) =>
  Layer.sync(EntityStore, () => {
    const types = new Map((seed.types ?? []).map((type) => [type.name, type]));
    const key = (type: string, id: string) => `${type}/${id}`;
    const entities = new Map(
      (seed.entities ?? []).map((entity) => [key(entity.type, entity.id), entity]),
    );
    const subscriptions = new Map<string, string>();
    const templates = new Map((seed.templates ?? []).map((template) => [template.name, template]));
    const roles = new Map((seed.roles ?? []).map((role) => [role.name, role]));
    return makeEntityStore({
      listTypes: Effect.sync(() => [...types.values()]),
      putType: (type) => Effect.sync(() => void types.set(type.name, type)),
      deleteType: (name) => Effect.sync(() => void types.delete(name)),
      listEntities: (type) =>
        Effect.sync(() => [...entities.values()].filter((entity) => entity.type === type)),
      getEntity: (type, id) => Effect.sync(() => entities.get(key(type, id))),
      writeEntity: (record) =>
        Effect.sync(() => void entities.set(key(record.type, record.id), record)),
      deleteEntity: (type, id) => Effect.sync(() => void entities.delete(key(type, id))),
      subscribe: (automationId, type) =>
        Effect.sync(() =>
          type === undefined
            ? void subscriptions.delete(automationId)
            : void subscriptions.set(automationId, type),
        ),
      subscribers: (type) =>
        Effect.sync(() =>
          [...subscriptions].flatMap(([automationId, watched]) =>
            watched === type ? [automationId] : [],
          ),
        ),
      listTemplates: Effect.sync(() => [...templates.values()]),
      writeTemplate: (template) => Effect.sync(() => void templates.set(template.name, template)),
      deleteTemplate: (name) => Effect.sync(() => void templates.delete(name)),
      listRoles: Effect.sync(() => [...roles.values()]),
      putRole: (role) => Effect.sync(() => void roles.set(role.name, role)),
    });
  });
