/** Checks entity-store merging, subscriptions, and deletion constraints for types, templates, and roles. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { EntityType } from "./model.ts";
import { EntityStore, layerMemory } from "./store.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "start_date", label: "Start date", type: "date" },
  ],
};

const person: EntityType = {
  name: "person",
  label: "Person",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "text" },
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

/** A store that also has people, who can be members of roles. */
const runWithPeople = <A, E>(effect: Effect.Effect<A, E, EntityStore>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        layerMemory({
          types: [employee, person],
          entities: [
            { type: "employee", id: "ada", data: { name: "Ada" }, updatedAt: 0 },
            {
              type: "person",
              id: "sam",
              data: { name: "Sam", email: "sam@example.com" },
              updatedAt: 0,
            },
          ],
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

  test("stores templates that check against the entity types, and deletes them", async () => {
    const welcome = {
      name: "welcome",
      label: "Welcome",
      description: "Welcomes a new hire.",
      slots: [{ name: "hire", label: "New hire", type: "ref", to: "employee" }],
      content: { subject: "Welcome, {{hire.name}}" },
    } as const;
    const result = await run(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        const invalid = yield* Effect.flip(
          entities.putTemplate({ ...welcome, content: { subject: "Welcome, {{hire.nickname}}" } }),
        );
        yield* entities.putTemplate(welcome);
        const stored = yield* entities.getTemplate("welcome");
        yield* entities.deleteTemplate("welcome");
        return { invalid, stored, remaining: yield* entities.listTemplates };
      }),
    );
    expect(result.invalid.message).toBe(
      "{{hire.nickname}}: employee has no field nickname (fields: name, start_date)",
    );
    expect(result.stored).toEqual(welcome);
    expect(result.remaining).toEqual([]);
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

  test("keeps roles whose members are stored entities with an email field", async () => {
    const ops = { name: "ops", label: "Ops", members: [{ type: "person", id: "sam" }] };
    const roles = await runWithPeople(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.putRole(ops);
        return yield* entities.listRoles;
      }),
    );
    expect(roles).toEqual([ops]);
    const invalid = await runWithPeople(
      EntityStore.use((entities) =>
        entities.putRole({
          name: "ops",
          label: "Ops",
          members: [
            { type: "employee", id: "ada" },
            { type: "person", id: "nobody" },
          ],
        }),
      ).pipe(Effect.flip),
    );
    expect(invalid.message).toBe(
      "employee has no email field, so it can't be a member; No person nobody",
    );
  });

  test("a role's members stay people with an email until they leave it", async () => {
    const attempts = await runWithPeople(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.putRole({
          name: "ops",
          label: "Ops",
          members: [{ type: "person", id: "sam" }],
        });
        const failure = (effect: Effect.Effect<unknown, { readonly message: string }>) =>
          effect.pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        return {
          deleteMember: yield* failure(entities.deleteEntity("person", "sam")),
          clearEmail: yield* failure(entities.putEntity("person", "sam", { email: null })),
          dropEmailField: yield* failure(
            entities.putType({
              ...person,
              fields: person.fields.filter((f) => f.name !== "email"),
            }),
          ),
          deleteType: yield* failure(entities.deleteType("person")),
          kept: yield* entities.getEntity("person", "sam"),
          renamed: yield* entities.putEntity("person", "sam", { name: "Samuel" }),
          left: yield* entities
            .putRole({ name: "ops", label: "Ops", members: [] })
            .pipe(Effect.andThen(entities.deleteEntity("person", "sam"))),
        };
      }),
    );
    expect(attempts.deleteMember).toBe(
      "Can't delete person sam: it is a member of ops. Take it out of them first.",
    );
    expect(attempts.clearEmail).toBe("person sam needs an email: it is a member of ops");
    expect(attempts.dropEmailField).toBe(
      "person needs a text field named email: roles have members of it (ops)",
    );
    expect(attempts.deleteType).toBe(
      "Can't delete person: it still has 1 entity; roles have members of it: ops",
    );
    expect(attempts.kept?.data).toEqual({ name: "Sam", email: "sam@example.com" });
    expect(attempts.renamed.after.data).toEqual({ name: "Samuel", email: "sam@example.com" });
    expect(attempts.left?.id).toBe("sam");
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
        yield* entities.putTemplate({
          name: "welcome",
          label: "Welcome",
          description: "Welcomes a new hire.",
          slots: [{ name: "hire", label: "New hire", type: "ref", to: "employee" }],
          content: { subject: "Welcome, {{hire.name}}" },
        });
        const blocked = yield* Effect.flip(entities.deleteType("employee"));
        const deletedTeam = yield* entities.deleteType("team");
        return { blocked, deletedTeam, types: yield* entities.listTypes };
      }),
    );
    expect(result.blocked.message).toBe(
      "Can't delete employee: it still has 1 entity; team.lead points to it; template slots point to it: welcome.hire; automations watch it: onboarding",
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
