/** An in-memory entity store for tests: the real store over a fake entity-store and a memory catalog. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EntityStoreApi, makeEntityStoreApi } from "./entity-store-api.ts";
import { makeFakeEntityStore, type FakeEntityStore } from "./entity-store-fake.ts";
import { planTypeWrite, ROLE_TYPE, roleData, roleSchema } from "./entity-store-types.ts";
import type { EntityRecord, EntityType, Role } from "./model.ts";
import { EntityStore, makeEntityStore, type CatalogStorage } from "./store.ts";
import type { Template } from "./templates.ts";

export interface MemorySeed {
  readonly types?: ReadonlyArray<EntityType>;
  readonly entities?: ReadonlyArray<
    Omit<EntityRecord, "updatedAt"> & { readonly updatedAt?: number }
  >;
  readonly templates?: ReadonlyArray<Template>;
  /** Roles, stored as `role` entities. Their members are employees. */
  readonly roles?: ReadonlyArray<Role>;
}

/** Templates and subscriptions in memory. */
export const makeMemoryCatalog = (templates: ReadonlyArray<Template> = []): CatalogStorage => {
  const stored = new Map(templates.map((template) => [template.name, template]));
  const subscriptions = new Map<string, string>();
  return {
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
    listTemplates: Effect.sync(() =>
      [...stored.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    ),
    writeTemplate: (template) => Effect.sync(() => void stored.set(template.name, template)),
    deleteTemplate: (name) => Effect.sync(() => void stored.delete(name)),
  };
};

/** A fake entity-store holding `seed`'s types, entities and roles as automations would write them. */
export const seededEntityStore = (seed: MemorySeed): FakeEntityStore => {
  const fake = makeFakeEntityStore();
  for (const type of seed.types ?? []) {
    const plan = planTypeWrite(undefined, type);
    if (plan.kind === "create") {
      fake.seedType(type.name, plan.input.description, plan.input.schema);
    }
  }
  for (const entity of seed.entities ?? []) {
    fake.seedEntity(entity.type, entity.id, entity.data);
  }
  if (seed.roles !== undefined && seed.roles.length > 0) {
    fake.seedType(ROLE_TYPE, "Roles", roleSchema);
    for (const role of seed.roles) {
      fake.seedEntity(ROLE_TYPE, role.name, roleData(role));
    }
  }
  return fake;
};

/** The store over `fake` and an in-memory catalog seeded with `templates`. */
export const layerFake = (fake: FakeEntityStore, templates?: ReadonlyArray<Template>) =>
  Layer.sync(EntityStore, () =>
    makeEntityStore(makeEntityStoreApi(fake), makeMemoryCatalog(templates)),
  );

/** entity-store's API over `fake`, for code that calls it directly. */
export const layerFakeApi = (fake: FakeEntityStore) =>
  Layer.succeed(EntityStoreApi, makeEntityStoreApi(fake));

/** An in-memory store, seeded with `types`, `entities`, `templates`, and `roles`. */
export const layerMemory = (seed: MemorySeed) =>
  Layer.suspend(() => layerFake(seededEntityStore(seed), seed.templates));
