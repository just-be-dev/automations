/** Checks the migration plan by applying it to a fake entity-store and reading it back. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { makeEntityStoreApi } from "../../src/entities/entity-store-api.ts";
import { makeFakeEntityStore, type FakeEntityStore } from "../../src/entities/entity-store-fake.ts";
import { makeMemoryCatalog } from "../../src/entities/memory.ts";
import { makeEntityStore } from "../../src/entities/store.ts";
import type { EntityType } from "../../src/entities/model.ts";
import { MIGRATION_META, planMigration, type Source } from "./plan.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "text" },
    { name: "team", label: "Team", type: "ref", to: "team" },
    { name: "manager", label: "Manager", type: "ref", to: "employee" },
  ],
};
// Teams and employees point to each other, so one is created without its ref first.
const team: EntityType = {
  name: "team",
  label: "Team",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "lead", label: "Lead", type: "ref", to: "employee" },
  ],
};

const source: Source = {
  types: [employee, team],
  entities: [
    { type: "team", id: "engines", data: { name: "Engines", lead: "grace" } },
    {
      type: "employee",
      id: "ada",
      data: { name: "Ada", email: null, team: "engines", manager: "grace", nickname: "Countess" },
    },
    {
      type: "employee",
      id: "grace",
      data: { name: "Grace", email: "grace@example.com", manager: "nobody" },
    },
  ],
  roles: [
    { name: "people_ops", label: "People Ops", members: [{ type: "employee", id: "grace" }] },
  ],
};

/** Applies a plan's steps to a fake entity-store as `migrate.ts` does over HTTP. */
const apply = async (fake: FakeEntityStore, plan: ReturnType<typeof planMigration>) => {
  for (const step of plan.steps) {
    const answer =
      step.kind === "createType"
        ? await fake.createType(step.input)
        : step.kind === "createVersion"
          ? await fake.createVersion(step.type, { schema: step.schema, lens: step.lens })
          : await fake.upsertEntity(step.type, step.id, {
              patch: step.patch,
              meta: MIGRATION_META,
            });
    expect(answer).toMatchObject({ ok: true });
  }
};

const infos = async (fake: FakeEntityStore) => {
  const listed = (await fake.listTypes()) as { value: Array<{ name: string }> };
  return Promise.all(
    listed.value.map(
      async (summary) => ((await fake.getType(summary.name)) as { value: never }).value,
    ),
  );
};

test("copies types, entities and roles so automations reads back what it had", async () => {
  const fake = makeFakeEntityStore();
  const plan = planMigration(source, []);
  expect(plan.problems).toEqual([]);
  expect(plan.notes).toEqual([
    "employee ada: left out nickname, which employee no longer has",
    "employee grace: left out manager, which points to employee nobody, which doesn't exist",
  ]);
  await apply(fake, plan);
  const store = makeEntityStore(makeEntityStoreApi(fake), makeMemoryCatalog());
  const read = await Effect.runPromise(
    Effect.all({
      types: store.listTypes,
      employees: store.listEntities("employee"),
      teams: store.listEntities("team"),
      roles: store.listRoles,
    }),
  );
  expect(read.types).toEqual([employee, team]);
  expect(read.employees.map(({ id, data }) => ({ id, data }))).toEqual([
    { id: "ada", data: { name: "Ada", team: "engines", manager: "grace" } },
    { id: "grace", data: { name: "Grace", email: "grace@example.com" } },
  ]);
  expect(read.teams.map(({ data }) => data)).toEqual([{ name: "Engines", lead: "grace" }]);
  expect(read.roles).toEqual(source.roles);
  // Every write is marked as the migration's, so automations starts nothing from it.
  expect(fake.changes().every((change) => change.meta?.["source"] === "migration")).toBe(true);

  // Running it again changes no type.
  const again = planMigration(source, await infos(fake));
  expect(again.steps.filter((step) => step.kind !== "upsertEntity")).toEqual([]);
  await apply(fake, again);
});

test("refuses what entity-store can't hold, before writing anything", () => {
  const plan = planMigration(
    {
      types: [employee, team, { ...team, name: "role" }],
      entities: [
        { type: "employee", id: "engines", data: {} },
        { type: "team", id: "engines", data: {} },
        { type: "contractor", id: "sam", data: {} },
      ],
      roles: [{ name: "engines", label: "Engines", members: [{ type: "contractor", id: "sam" }] }],
    },
    [],
  );
  expect(plan.problems).toEqual([
    "automations has a type named role, which entity-store keeps roles in",
    "engines is the ID of both employee engines and team engines; entity IDs are unique across types in entity-store",
    "contractor sam has no type",
    "Role engines has the ID of team engines",
    "Role engines has contractor sam as a member; members must be employees",
  ]);
});
