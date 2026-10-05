import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { EntityType } from "./entities.ts";
import { EntityStore, layerMemory } from "./entity-store.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "start_date", label: "Start date", type: "date" },
  ],
};

const run = <A, E>(effect: Effect.Effect<A, E, EntityStore>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        layerMemory({
          types: [employee],
          entities: [{ type: "employee", id: "ada", data: { name: "Ada" }, updatedAt: 0 }],
        }),
      ),
    ),
  );

describe("EntityStore", () => {
  test("merges a write over the stored entity and returns both versions", async () => {
    const result = await run(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        const change = yield* entities.putEntity("employee", "ada", { start_date: "2026-11-02" });
        return { change, stored: yield* entities.getEntity("employee", "ada") };
      }),
    );
    expect(result.change).toEqual({
      before: { name: "Ada" },
      after: { type: "employee", id: "ada", data: { name: "Ada", start_date: "2026-11-02" } },
    });
    expect(result.stored?.data).toEqual({ name: "Ada", start_date: "2026-11-02" });
  });

  test("creates new entities and rejects data or types it doesn't know", async () => {
    const created = await run(
      EntityStore.use((entities) => entities.putEntity("employee", "grace", { name: "Grace" })),
    );
    expect(created.before).toBeUndefined();
    const invalid = await run(
      EntityStore.use((entities) =>
        entities.putEntity("employee", "ada", { start_date: "soon" }),
      ).pipe(Effect.flip),
    );
    expect(invalid.message).toBe("employee.start_date must be a date");
    const unknown = await run(
      EntityStore.use((entities) => entities.putEntity("contractor", "x", {})).pipe(Effect.flip),
    );
    expect(unknown.message).toBe("Unknown entity type contractor");
  });

  test("tracks which automations subscribe to a type", async () => {
    const subscribers = await run(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.subscribe("onboarding", "employee");
        yield* entities.subscribe("offboarding", "employee");
        yield* entities.subscribe("offboarding", undefined);
        return yield* entities.subscribers("employee");
      }),
    );
    expect(subscribers).toEqual(["onboarding"]);
  });
});

describe("EntityStore types", () => {
  const team: EntityType = {
    name: "team",
    label: "Team",
    title: "name",
    fields: [
      { name: "name", label: "Name", type: "text" },
      { name: "lead", label: "Lead", type: "ref", to: "employee" },
    ],
  };

  test("rejects a type whose refs, field names, or name can't work", async () => {
    const problem = (type: EntityType) =>
      run(EntityStore.use((entities) => entities.putType(type)).pipe(Effect.flip)).then(
        (error) => error.message,
      );
    expect(
      await problem({
        ...team,
        fields: [...team.fields, { name: "office", label: "Office", type: "ref", to: "office" }],
      }),
    ).toBe("team.office points to unknown type office");
    expect(
      await problem({
        ...team,
        fields: [...team.fields, { name: "id", label: "ID", type: "text" }],
      }),
    ).toBe("team.id is every entity's ID; rename the field");
    expect(
      await problem({
        ...team,
        fields: [...team.fields, { name: "name", label: "Again", type: "text" }],
      }),
    ).toBe("team has more than one field named name");
    expect(await problem({ ...team, name: "types" })).toBe(
      "types is reserved; choose another type name",
    );
  });

  test("deletes a type only once nothing depends on it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.putType(team);
        yield* entities.subscribe("onboarding", "employee");
        const blocked = yield* Effect.flip(entities.deleteType("employee"));
        const deletedTeam = yield* entities.deleteType("team");
        return { blocked, deletedTeam, types: yield* entities.listTypes };
      }),
    );
    expect(result.blocked.message).toBe(
      "Can't delete employee: it still has 1 entity; team.lead points to it; automations watch it: onboarding",
    );
    expect(result.types.map((type) => type.name)).toEqual(["employee"]);
  });

  test("drops the values of removed fields on the next write", async () => {
    const stored = await run(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.putEntity("employee", "ada", { start_date: "2026-11-02" });
        yield* entities.putType({ ...employee, fields: employee.fields.slice(0, 1) });
        const change = yield* entities.putEntity("employee", "ada", { name: "Ada Lovelace" });
        return change.after.data;
      }),
    );
    expect(stored).toEqual({ name: "Ada Lovelace" });
  });

  test("deletes an entity and reports what it held", async () => {
    const result = await run(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        const deleted = yield* entities.deleteEntity("employee", "ada");
        const missing = yield* entities.deleteEntity("employee", "ada");
        return { deleted, missing, left: yield* entities.listEntities("employee") };
      }),
    );
    expect(result.deleted?.data).toEqual({ name: "Ada" });
    expect(result.missing).toBeUndefined();
    expect(result.left).toEqual([]);
  });
});
