/** Checks the demo seed against the migrations, the catalog checker, and the calendar. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { checkEntityData, EntityType, Role } from "../src/entities/model.ts";
import { Template } from "../src/entities/templates.ts";
import { checkWorkflow } from "../src/workflow/catalog.ts";
import {
  approverNote,
  employees,
  employeeType,
  fallback,
  newHire,
  people,
  roles,
  startDateFrom,
  templates,
} from "./seed.ts";

/** The JSON values a migration inserts, with SQL's doubled quotes undone. */
const insertedJson = async (file: string) => {
  const sql = await Bun.file(new URL(`../migrations/${file}`, import.meta.url)).text();
  return [...sql.matchAll(/'(\{(?:[^']|'')*\})'/g)].map((match) =>
    JSON.parse((match[1] ?? "").replaceAll("''", "'")),
  );
};

test("the new hire starts on the first Monday at least two weeks out", () => {
  expect(startDateFrom(new Date(2026, 9, 14))).toBe("2026-11-02");
  expect(startDateFrom(new Date(2026, 9, 12))).toBe("2026-10-26");
  expect(startDateFrom(new Date(2026, 9, 18))).toBe("2026-11-02");
  expect(startDateFrom(new Date(2026, 11, 28))).toBe("2027-01-11");
});

test("the seed restores the type and templates the migrations create", async () => {
  const [type] = await insertedJson("0002_entities.sql");
  expect(employeeType).toEqual(Schema.decodeUnknownSync(EntityType)(type));
  const seeded = await insertedJson("0003_templates.sql");
  const byName = (list: ReadonlyArray<Template>) =>
    list.toSorted((a, b) => a.name.localeCompare(b.name));
  expect(byName(templates)).toEqual(
    byName(seeded.map((each) => Schema.decodeUnknownSync(Template)(each))),
  );
});

test("people get configured addresses, or placeholders that go nowhere", () => {
  const records = employees({ DEMO_ADA_EMAIL: "ada@sandbox.test" }, "2026-11-02");
  expect(records.map((each) => each.id)).toEqual(people.map((each) => each.id));
  const ada = records.find((each) => each.id === newHire);
  expect(ada?.data).toEqual({
    name: "Ada Lovelace",
    email: "ada@sandbox.test",
    role: "Software engineer",
    start_date: "2026-11-02",
    manager: "grace",
  });
  expect(records.find((each) => each.id === "grace")?.data["email"]).toBe("grace@example.com");
  for (const record of records) {
    expect(Effect.runSync(checkEntityData(employeeType, record.data))).toEqual(record.data);
  }
});

test("every manager and role member is a seeded person who comes first", () => {
  const ids = people.map((each) => each.id);
  people.forEach((each, index) => {
    const manager = each.data("2026-11-02")["manager"];
    if (typeof manager === "string") expect(ids.indexOf(manager)).toBeLessThan(index);
  });
  for (const role of roles) {
    Schema.decodeSync(Role)(role);
    for (const member of role.members) expect(ids).toContain(member.id);
  }
});

test("the fallback workflow checks against the seeded catalog", () => {
  const checked = Effect.runSync(
    checkWorkflow({ types: [employeeType], templates, roles }, fallback),
  );
  expect(checked.name).toBe("Launch a great first week");
  expect(checked.permissions?.["email.send"]).toEqual({ ask: "people_ops" });
});

test("the reset says whether the local studio's user approves for People Ops", () => {
  const seeded = employees({ DEMO_GRACE_EMAIL: "Me@Example.com" }, "2026-11-02");
  expect(approverNote("me@example.com", seeded)).toBe(
    "You are Grace Hopper (me@example.com) and approve for People Ops.",
  );
  expect(approverNote("katherine@example.com", seeded)).toContain("isn't in People Ops");
  expect(approverNote("someone@example.com", seeded)).toContain(
    "Set DEMO_GRACE_EMAIL to someone@example.com",
  );
  expect(approverNote(undefined, seeded)).toContain("Set DEV_USER_EMAIL and DEMO_GRACE_EMAIL");
});
