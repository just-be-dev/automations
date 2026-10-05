import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  checkEntityData,
  InvalidEntity,
  type EntityData,
  type EntityRecord,
  type EntityType,
  type Subject,
} from "./entities.ts";

/**
 * Where entity types, entities, and subscriptions to entity changes live. `EntityStore` is the
 * service steps, triggers, and the API use; `src/entity-store-d1.ts` implements it on D1, and
 * `layerMemory` below implements it in memory for tests.
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
    /** Creates or replaces an entity type. */
    readonly putType: (type: EntityType) => Effect.Effect<EntityType, EntityStoreError>;
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
    /** Records which entity type an automation's saved workflow watches, or that it watches none. */
    readonly subscribe: (
      automationId: string,
      type: string | undefined,
    ) => Effect.Effect<void, EntityStoreError>;
    /** The automations watching an entity type. */
    readonly subscribers: (type: string) => Effect.Effect<ReadonlyArray<string>, EntityStoreError>;
  }
>()("automations/EntityStore") {}

/** What an implementation stores and reads. `makeEntityStore` builds the service on top. */
export interface EntityStorage {
  readonly listTypes: Effect.Effect<ReadonlyArray<EntityType>, EntityStoreError>;
  readonly putType: (type: EntityType) => Effect.Effect<void, EntityStoreError>;
  readonly listEntities: (
    type: string,
  ) => Effect.Effect<ReadonlyArray<EntityRecord>, EntityStoreError>;
  readonly getEntity: (
    type: string,
    id: string,
  ) => Effect.Effect<EntityRecord | undefined, EntityStoreError>;
  readonly writeEntity: (record: EntityRecord) => Effect.Effect<void, EntityStoreError>;
  readonly subscribe: (
    automationId: string,
    type: string | undefined,
  ) => Effect.Effect<void, EntityStoreError>;
  readonly subscribers: (type: string) => Effect.Effect<ReadonlyArray<string>, EntityStoreError>;
}

/** Builds the service over an implementation's storage, so every one merges and checks alike. */
export const makeEntityStore = (storage: EntityStorage) =>
  EntityStore.of({
    listTypes: storage.listTypes,
    putType: (type) => storage.putType(type).pipe(Effect.as(type)),
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
      const merged = yield* checkEntityData(type, { ...before?.data, ...data });
      const updatedAt = yield* Clock.currentTimeMillis;
      yield* storage.writeEntity({ type: typeName, id, data: merged, updatedAt });
      return { before: before?.data, after: { type: typeName, id, data: merged } };
    }),
    subscribe: storage.subscribe,
    subscribers: storage.subscribers,
  });

/** An in-memory store, seeded with `types` and `entities`. */
export const layerMemory = (seed: {
  readonly types?: ReadonlyArray<EntityType>;
  readonly entities?: ReadonlyArray<EntityRecord>;
}) =>
  Layer.sync(EntityStore, () => {
    const types = new Map((seed.types ?? []).map((type) => [type.name, type]));
    const key = (type: string, id: string) => `${type}/${id}`;
    const entities = new Map(
      (seed.entities ?? []).map((entity) => [key(entity.type, entity.id), entity]),
    );
    const subscriptions = new Map<string, string>();
    return makeEntityStore({
      listTypes: Effect.sync(() => [...types.values()]),
      putType: (type) => Effect.sync(() => void types.set(type.name, type)),
      listEntities: (type) =>
        Effect.sync(() => [...entities.values()].filter((entity) => entity.type === type)),
      getEntity: (type, id) => Effect.sync(() => entities.get(key(type, id))),
      writeEntity: (record) =>
        Effect.sync(() => void entities.set(key(record.type, record.id), record)),
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
    });
  });
