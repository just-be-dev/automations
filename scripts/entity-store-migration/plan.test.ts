/** Checks the migration plan by applying it to a fake entity-store and reading it back. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { makeEntityStoreApi } from "../../src/entities/entity-store-api.ts";
import { makeFakeEntityStore, type FakeEntityStore } from "../../src/entities/entity-store-fake.ts";
import { makeMemoryCatalog } from "../../src/entities/memory.ts";
import { makeEntityStore } from "../../src/entities/store.ts";
import type { EntityType } from "../../src/entities/model.ts";
import { checkLocally, MIGRATION_META, planMigration, type Source } from "./plan.ts";

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

/**
 * Applies a plan's steps to a fake entity-store as `migrate.ts` does over HTTP: entities are only
 * created, and those that exist are skipped. Returns the skipped ones.
 */
const apply = async (fake: FakeEntityStore, plan: ReturnType<typeof planMigration>) => {
  const created = new Map<string, number>();
  const skipped: Array<string> = [];
  for (const step of plan.steps) {
    if (step.kind === "createType") {
      expect(await fake.createType(step.input)).toMatchObject({ ok: true });
    } else if (step.kind === "createVersion") {
      expect(
        await fake.createVersion(step.type, { schema: step.schema, lens: step.lens }),
      ).toMatchObject({ ok: true });
    } else if (step.kind === "createEntity") {
      const answer = (await fake.upsertEntity(step.type, step.id, {
        patch: step.patch,
        expectedRev: 0,
        meta: MIGRATION_META,
      })) as { ok: boolean; value?: { entity: { rev: number } }; error?: { code: string } };
      if (answer.value !== undefined) created.set(step.id, answer.value.entity.rev);
      else if (answer.error?.code === "RevConflict") skipped.push(step.id);
      else throw new Error(JSON.stringify(answer));
    } else {
      const rev = created.get(step.id);
      if (rev === undefined) continue;
      expect(
        await fake.upsertEntity(step.type, step.id, {
          patch: step.patch,
          expectedRev: rev,
          meta: MIGRATION_META,
        }),
      ).toMatchObject({ ok: true });
    }
  }
  return skipped;
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

  // Running it again changes no type, and doesn't revert an edit made since: what exists is
  // skipped.
  await fake.upsertEntity("employee", "ada", { patch: { name: "Ada Lovelace" } });
  const again = planMigration(source, await infos(fake));
  expect(
    again.steps.filter((step) => step.kind === "createType" || step.kind === "createVersion"),
  ).toEqual([]);
  expect(await apply(fake, again)).toEqual(["engines", "ada", "grace", "people_ops"]);
  expect(await fake.getEntity("ada")).toMatchObject({ value: { data: { name: "Ada Lovelace" } } });
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

test("lists every write entity-store would refuse, without guessing fixes", async () => {
  const meeting: EntityType = {
    name: "meeting",
    label: "Meeting",
    title: "topic",
    fields: [
      { name: "topic", label: "Topic", type: "text" },
      { name: "at", label: "At", type: "datetime" },
    ],
  };
  const plan = planMigration(
    {
      types: [meeting],
      entities: [
        { type: "meeting", id: "kickoff", data: { topic: "Kickoff", at: "2026-11-02T09:00" } },
        { type: "meeting", id: "retro", data: { topic: "Retro", at: "2026-11-06T16:00Z" } },
        { type: "meeting", id: "sync", data: { topic: "Sync", at: "2026-11-03 10:00" } },
      ],
      roles: [],
    },
    [],
  );
  expect(plan.problems).toEqual([]);
  const failures = await checkLocally(plan, []);
  expect(failures).toHaveLength(2);
  expect(failures[0]).toContain("create meeting kickoff");
  expect(failures[1]).toContain("create meeting sync");
});

test("every entity's creation passes on its own, before any ref or member exists", async () => {
  const plan = planMigration(source, []);
  const fake = makeFakeEntityStore();
  for (const step of plan.steps) {
    if (step.kind === "createType") await fake.createType(step.input);
  }
  // migrate.ts --apply checks every creation before writing any of them.
  for (const step of plan.steps) {
    if (step.kind !== "createEntity") continue;
    expect(await fake.checkEntity(step.type, step.id, { patch: step.patch })).toMatchObject({
      ok: true,
    });
  }
});
