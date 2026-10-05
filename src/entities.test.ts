import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  changedFields,
  checkEntityData,
  pathTarget,
  readRef,
  type EntityType,
  type Subject,
} from "./entities.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "email" },
    { name: "start_date", label: "Start date", type: "date" },
    { name: "manager", label: "Manager", type: "ref", to: "employee" },
  ],
};

const grace: Subject = {
  type: "employee",
  id: "grace",
  data: { name: "Grace Hopper", email: "grace@example.com", manager: null },
};
const ada: Subject = {
  type: "employee",
  id: "ada",
  data: { name: "Ada Lovelace", start_date: "2026-11-02", manager: "grace" },
};

const load = (type: string, id: string) =>
  Effect.succeed(type === "employee" && id === "grace" ? grace : undefined);

const read = (ref: string) =>
  Effect.runSync(
    readRef([employee], { subject: ada, steps: { draft: { output: "Hi" } } }, ref, load),
  );

describe("entities", () => {
  test("reads fields, follows ref fields, and yields whole entities", () => {
    expect(read("employee.start_date")).toBe("2026-11-02");
    expect(read("employee.manager.email")).toBe("grace@example.com");
    expect(read("employee.manager")).toMatchObject({
      $type: "employee",
      $id: "grace",
      $title: "Grace Hopper",
      email: "grace@example.com",
    });
    expect(read("employee.id")).toBe("ada");
    expect(read("steps.draft.output")).toBe("Hi");
    expect(read("employee.manager.manager.email")).toBeNull();
    expect(read("contractor.name")).toBeNull();
  });

  test("says where a path leads, or why it can't", () => {
    expect(pathTarget([employee], employee, ["manager"])).toMatchObject({ kind: "entity" });
    expect(pathTarget([employee], employee, ["manager", "start_date"])).toMatchObject({
      kind: "field",
      field: { type: "date" },
    });
    expect(pathTarget([employee], employee, ["email", "domain"])).toEqual({
      kind: "error",
      message: "employee.email is a email, not an entity",
    });
  });

  test("checks data against the type", () => {
    expect(Effect.runSync(checkEntityData(employee, { start_date: null }))).toEqual({
      start_date: null,
    });
    const error = Effect.runSync(
      checkEntityData(employee, { start_date: "next week", desk: "4" }).pipe(Effect.flip),
    );
    expect(error.message).toBe("employee.start_date must be a date; employee has no field desk");
  });

  test("lists the fields that changed", () => {
    expect(
      changedFields({ name: "Ada", start_date: null }, { name: "Ada", start_date: "2026-11-02" }),
    ).toEqual(["start_date"]);
    expect(changedFields(undefined, { name: "Ada" })).toEqual(["name"]);
  });
});
