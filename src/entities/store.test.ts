/** Checks the entity store over a fake entity-store: merging, revisions, subscriptions, and deletion constraints for types, templates, and roles. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { EntityType } from "./model.ts";
import { EntityStore } from "./store.ts";
import { layerFake, layerMemory, seededEntityStore } from "./memory.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "start_date", label: "Start date", type: "date" },
  ],
};

/** Employees with an email, who can be members of roles. */
const staff: EntityType = {
  ...employee,
  fields: [...employee.fields, { name: "email", label: "Email", type: "text" }],
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

/** A store whose employees have emails, so they can be members of roles. */
const runWithPeople = <A, E>(effect: Effect.Effect<A, E, EntityStore>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        layerMemory({
          types: [staff],
          entities: [
            { type: "employee", id: "ada", data: { name: "Ada" } },
            { type: "employee", id: "sam", data: { name: "Sam", email: "sam@example.com" } },
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
      before: { type: "employee", id: "ada", data: { name: "Ada" }, updatedAt: expect.any(Number) },
      after: { type: "employee", id: "ada", data: { name: "Ada", start_date: "2026-11-02" } },
      expectedRev: 1,
      rev: 2,
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

  test("keeps roles whose members are stored employees with an email", async () => {
    const ops = { name: "ops", label: "Ops", members: [{ type: "employee", id: "sam" }] };
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
      "employee ada has no email; Role members are employees, so person nobody can't be one",
    );
  });

  test("a role's members stay people with an email until they leave it", async () => {
    const attempts = await runWithPeople(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.putRole({
          name: "ops",
          label: "Ops",
          members: [{ type: "employee", id: "sam" }],
        });
        const failure = (effect: Effect.Effect<unknown, { readonly message: string }>) =>
          effect.pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        return {
          deleteMember: yield* failure(entities.deleteEntity("employee", "sam")),
          clearEmail: yield* failure(entities.putEntity("employee", "sam", { email: null })),
          dropEmailField: yield* failure(entities.putType(employee)),
          deleteType: yield* failure(entities.deleteType("employee")),
          kept: yield* entities.getEntity("employee", "sam"),
          renamed: yield* entities.putEntity("employee", "sam", { name: "Samuel" }),
          left: yield* entities
            .putRole({ name: "ops", label: "Ops", members: [] })
            .pipe(Effect.andThen(entities.deleteEntity("employee", "sam"))),
        };
      }),
    );
    expect(attempts.deleteMember).toBe(
      "Can't delete employee sam: it is a member of ops. Take it out of them first.",
    );
    expect(attempts.clearEmail).toBe("employee sam needs an email: it is a member of ops");
    expect(attempts.dropEmailField).toBe(
      "employee needs a text field named email: roles have members of it (ops)",
    );
    expect(attempts.deleteType).toBe(
      "Can't delete employee: it still has entities; roles have members of it: ops",
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
      "Can't delete employee: it still has entities; team.lead points to it; template slots point to it: welcome.hire; automations watch it: onboarding",
    );
    expect(result.types.map((type) => type.name)).toEqual(["employee"]);
  });

  test("removing a field adds a version whose lens drops its values", async () => {
    const stored = await run(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.putEntity("employee", "ada", { start_date: "2026-11-02" });
        yield* entities.putType({ ...employee, fields: employee.fields.slice(0, 1) });
        return (yield* entities.getEntity("employee", "ada"))?.data;
      }),
    );
    expect(stored).toEqual({ name: "Ada" });
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

describe("EntityStore over entity-store", () => {
  test("entity IDs are unique across types, and a role's name takes one too", async () => {
    const problems = await runWithPeople(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.putType({ ...employee, name: "contractor" });
        const taken = yield* Effect.flip(entities.putEntity("contractor", "ada", { name: "Ada" }));
        const role = yield* Effect.flip(
          entities.putRole({ name: "ada", label: "Ada", members: [] }),
        );
        return { taken: taken.message, role: role.message };
      }),
    );
    expect(problems.taken).toBe(
      "ada is already used by employee ada; entity IDs are unique across types",
    );
    expect(problems.role).toBe("ada is already used by employee ada; choose another role name");
  });

  test("a conditional write fails on another revision and writes nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        const stale = yield* Effect.flip(
          entities.putEntity("employee", "ada", { name: "Stale" }, { expectedRev: 0 }),
        );
        const gone = yield* Effect.flip(
          entities.deleteEntity("employee", "ada", { expectedRev: 7 }),
        );
        return { stale, gone, stored: yield* entities.getEntity("employee", "ada") };
      }),
    );
    expect(result.stale._tag).toBe("EntityRevConflict");
    expect(result.gone._tag).toBe("EntityRevConflict");
    expect(result.stored?.data).toEqual({ name: "Ada" });
  });

  test("reads a change back with its meta, and creates a deleted ID again at the next revision", async () => {
    const result = await run(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.deleteEntity("employee", "ada", { meta: { depth: 2, changeId: "c-1" } });
        const deleted = yield* entities.getChange("ada", 2);
        const check = yield* entities.checkEntity("employee", "ada", { name: "Ada again" });
        const written = yield* entities.putEntity("employee", "ada", { name: "Ada again" });
        return { deleted, check, written, missing: yield* entities.getChange("ada", 9) };
      }),
    );
    expect(result.deleted).toMatchObject({
      type: "employee",
      op: "delete",
      meta: { depth: 2, changeId: "c-1" },
      before: { name: "Ada" },
      after: null,
    });
    expect(result.check).toMatchObject({ before: undefined, expectedRev: 0, rev: 3 });
    expect(result.written.rev).toBe(3);
    expect(result.missing).toBeUndefined();
  });

  test("hides what automations can't use, and leaves it alone when a type changes", async () => {
    const fake = seededEntityStore({});
    fake.seedType("employee", "People who work here", {
      title: "full_name",
      fields: {
        full_name: { type: "string", minLength: 1, description: "Full name" },
        level: { type: "enum", values: ["junior", "senior"] },
        tags: { type: "array", items: { type: "string" }, optional: true },
        nickName: { type: "string", optional: true },
      },
    });
    fake.seedType("Office-Space", "", { fields: { name: { type: "string" } } });
    fake.seedEntity("employee", "ada", {
      full_name: "Ada",
      level: "senior",
      tags: ["math"],
      nickName: "Countess",
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        const [type] = yield* entities.listTypes;
        const before = yield* entities.getEntity("employee", "ada");
        if (type === undefined) return yield* Effect.die("No type");
        yield* entities.putType({
          ...type,
          fields: [...type.fields, { name: "team", label: "Team", type: "text" }],
        });
        yield* entities.putEntity("employee", "ada", { team: "Engines" });
        return { type, before, after: yield* entities.getEntity("employee", "ada") };
      }).pipe(Effect.provide(layerFake(fake))),
    );
    expect(result.type).toEqual({
      name: "employee",
      label: "People who work here",
      title: "full_name",
      fields: [
        { name: "full_name", label: "Full name", type: "text" },
        { name: "level", label: "level", type: "text" },
      ],
    });
    expect(result.before?.data).toEqual({ full_name: "Ada", level: "senior" });
    expect(result.after?.data).toEqual({ full_name: "Ada", level: "senior", team: "Engines" });
    const stored = await fake.getEntity("ada");
    expect(stored).toMatchObject({
      value: { data: { tags: ["math"], nickName: "Countess", team: "Engines" } },
    });
  });
});
