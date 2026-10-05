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
