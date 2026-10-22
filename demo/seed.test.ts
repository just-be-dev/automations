/** Checks the demo seed against the entity checker, the catalog checker, and the calendar. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { checkEntityData } from "../src/entities/model.ts";
import { checkWorkflow } from "../src/workflow/catalog.ts";
import {
  approverNote,
  employees,
  employeeType,
  fallback,
  newHire,
  people,
  startDateFrom,
  templates,
} from "./seed.ts";

test("the new hire starts on the first Monday at least two weeks out", () => {
  expect(startDateFrom(new Date(2026, 9, 14))).toBe("2026-11-02");
  expect(startDateFrom(new Date(2026, 9, 12))).toBe("2026-10-26");
  expect(startDateFrom(new Date(2026, 9, 18))).toBe("2026-11-02");
  expect(startDateFrom(new Date(2026, 11, 28))).toBe("2027-01-11");
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

test("every manager is a seeded person who comes first", () => {
  const ids = people.map((each) => each.id);
  people.forEach((each, index) => {
    const manager = each.data("2026-11-02")["manager"];
    if (typeof manager === "string") expect(ids.indexOf(manager)).toBeLessThan(index);
  });
});

test("the fallback workflow checks against the seeded catalog", () => {
  const checked = Effect.runSync(checkWorkflow({ types: [employeeType], templates }, fallback));
  expect(checked.name).toBe("Launch a great first week");
  expect(checked.permissions?.["email.send"]).toBe("ask");
});

test("the reset says who the local studio's user approves as", () => {
  const seeded = employees({ DEMO_GRACE_EMAIL: "Me@Example.com" }, "2026-11-02");
  expect(approverNote("me@example.com", seeded)).toBe(
    "You approve as Grace Hopper (me@example.com).",
  );
  expect(approverNote("someone@example.com", seeded)).toBe("You approve as someone@example.com.");
  expect(approverNote(undefined, seeded)).toContain("Set DEV_USER_EMAIL");
});
