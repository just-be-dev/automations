/** Checks the translation between entity-store schemas and automations' types. */
import { describe, expect, test } from "bun:test";
import type { StoreSchema, TypeInfo } from "./entity-store-api.ts";
import { planTypeWrite, toEntityData, toEntityType, type TypeWrite } from "./entity-store-types.ts";
import type { EntityType } from "./model.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "text" },
    { name: "start_date", label: "Start date", type: "date" },
    { name: "starts_at", label: "Starts at", type: "datetime" },
    { name: "salary", label: "Salary", type: "number" },
    { name: "remote", label: "Remote", type: "boolean" },
    { name: "manager", label: "Manager", type: "ref", to: "employee" },
  ],
};

const info = (name: string, ...schemas: ReadonlyArray<StoreSchema>): TypeInfo => ({
  name,
  description: "",
  latestVersion: schemas.length,
  createdAt: 0,
  updatedAt: 0,
  versions: schemas.map((schema, index) => ({
    type: name,
    version: index + 1,
    schema,
    note: "",
    createdAt: 0,
  })),
});

/** What reads give back after a plan is written over `existing`. */
const written = (existing: TypeInfo | undefined, plan: TypeWrite) => {
  if (plan.kind === "create") return toEntityType(info(plan.input.name, plan.input.schema));
  if (plan.kind === "version" && existing !== undefined)
    return toEntityType(
      info(existing.name, ...existing.versions.map((version) => version.schema), plan.schema),
    );
  return existing === undefined ? undefined : toEntityType(existing);
};

describe("entity-store schemas as entity types", () => {
  test("a type round-trips: created, then read back as it was", () => {
    const plan = planTypeWrite(undefined, employee);
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") return;
    expect(plan.input.description).toBe("Employee");
    expect(plan.input.schema.title).toBe("name");
    // Every field automations writes is optional and nullable, described by its label.
    expect(plan.input.schema.fields["manager"]).toEqual({
      type: "nullable",
      of: { type: "link", to: "employee" },
      optional: true,
      description: "Manager",
    });
    expect(plan.input.schema.fields["start_date"]).toMatchObject({
      of: { type: "string", format: "date" },
    });
    const created = info("employee", plan.input.schema);
    expect(toEntityType(created)).toEqual(employee);
    expect(planTypeWrite(created, employee)).toEqual({ kind: "unchanged" });
  });

  test("a type changed in automations round-trips as a new version", () => {
    const created = info(
      "employee",
      (planTypeWrite(undefined, employee) as { input: { schema: StoreSchema } }).input.schema,
    );
    const changed: EntityType = {
      ...employee,
      label: "Staff member",
      fields: [
        ...employee.fields.filter((field) => field.name !== "salary"),
        { name: "team", label: "Team", type: "text" as const },
      ].map((field) => (field.name === "email" ? { ...field, label: "Work email" } : field)),
    };
    const plan = planTypeWrite(created, changed);
    expect(plan.kind).toBe("version");
    if (plan.kind !== "version") return;
    expect(plan.lens.ops).toEqual([
      { op: "add", field: "team" },
      { op: "remove", field: "salary" },
    ]);
    expect(written(created, plan)).toEqual(changed);
  });

  test("maps each kind of field, and leaves out what checks and paths can't see into", () => {
    const type = toEntityType(
      info("person", {
        description: "Someone",
        fields: {
          nick: { type: "string", format: "email", description: "Nickname" },
          born: { type: "nullable", of: { type: "string", format: "date" }, description: "Born" },
          seen: { type: "string", format: "datetime" },
          level: { type: "enum", values: ["a", "b"] },
          age: { type: "number", integer: true },
          active: { type: "boolean" },
          buddy: { type: "nullable", of: { type: "link", to: "person", description: "Buddy" } },
          tags: { type: "array", items: { type: "string" } },
          address: { type: "object", fields: { city: { type: "string" } } },
          extra: { type: "json" },
          camelCase: { type: "string" },
          id: { type: "string" },
          office: { type: "link", to: "Office-Space" },
        },
      }),
    );
    expect(type).toEqual({
      name: "person",
      label: "Someone",
      // No `title` and no `name` field: the first text field.
      title: "nick",
      fields: [
        { name: "nick", label: "Nickname", type: "text" },
        { name: "born", label: "Born", type: "date" },
        { name: "seen", label: "seen", type: "datetime" },
        { name: "level", label: "level", type: "text" },
        { name: "age", label: "age", type: "number" },
        { name: "active", label: "active", type: "boolean" },
        { name: "buddy", label: "Buddy", type: "ref", to: "person" },
      ],
    });
    if (type === undefined) return;
    expect(toEntityData(type, { nick: "Al", tags: ["x"], extra: 1, buddy: null })).toEqual({
      nick: "Al",
      buddy: null,
    });
  });

  test("titles come from the schema's title, then a name field, then the first text field", () => {
    const title = (schema: StoreSchema) => toEntityType(info("thing", schema))?.title;
    const fields = {
      code: { type: "number" },
      label: { type: "string" },
      name: { type: "string" },
    };
    expect(title({ title: "label", fields })).toBe("label");
    expect(title({ fields })).toBe("name");
    expect(title({ fields: { code: fields.code, label: fields.label } })).toBe("label");
    expect(title({ fields: { code: fields.code } })).toBe("code");
    // Nothing automations can see: no type.
    expect(toEntityType(info("thing", { fields: { tags: { type: "json" } } }))).toBeUndefined();
  });

  test("leaves out types automations can't name", () => {
    const schema = { fields: { name: { type: "string" } } };
    expect(toEntityType(info("Office-Space", schema))).toBeUndefined();
    expect(toEntityType(info("office_space", schema))?.name).toBe("office_space");
  });

  test("a new version keeps hidden fields and unchanged nodes, constraints included", () => {
    const current: StoreSchema = {
      title: "name",
      fields: {
        name: { type: "string", minLength: 1 },
        level: { type: "enum", values: ["junior", "senior"], description: "Level" },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    const existing = info("employee", current);
    const type = toEntityType(existing);
    if (type === undefined) throw new Error("No type");
    const plan = planTypeWrite(existing, {
      ...type,
      fields: [...type.fields, { name: "team", label: "Team", type: "text" }],
    });
    expect(plan.kind).toBe("version");
    if (plan.kind !== "version") return;
    expect(plan.schema.fields["name"]).toEqual(current.fields["name"]);
    expect(plan.schema.fields["level"]).toEqual(current.fields["level"]);
    expect(plan.schema.fields["tags"]).toEqual(current.fields["tags"]);
    expect(plan.lens.ops).toEqual([{ op: "add", field: "team" }]);
  });

  test("refuses what needs a lens only entity-store can author", () => {
    const existing = info("employee", {
      fields: {
        name: { type: "string" },
        salary: { type: "number" },
        tags: { type: "array", items: { type: "string" }, optional: true },
      },
    });
    const type = toEntityType(existing);
    if (type === undefined) throw new Error("No type");
    const refused = (next: EntityType) => {
      const plan = planTypeWrite(existing, next);
      return plan.kind === "refused" ? plan.message : plan.kind;
    };
    expect(
      refused({
        ...type,
        fields: type.fields.map((field) =>
          field.name === "salary" ? { ...field, type: "text" } : field,
        ),
      }),
    ).toBe(
      "employee.salary is a number; change it to a text in entity-store, where a lens can convert stored values",
    );
    // `salary` is required there: old readers would need a value automations can't choose.
    expect(
      refused({ ...type, fields: type.fields.filter((field) => field.name !== "salary") }),
    ).toBe(
      "employee.salary is required in entity-store; remove it there, where a lens can say what old readers get",
    );
    expect(
      refused({ ...type, fields: [...type.fields, { name: "tags", label: "Tags", type: "text" }] }),
    ).toBe("employee.tags exists in entity-store as a field automations can't edit");
  });
});

describe("titles", () => {
  test("an enum isn't a name, so it's never chosen as the title", () => {
    const title = (schema: StoreSchema) => toEntityType(info("thing", schema))?.title;
    const level = { type: "enum", values: ["low", "high"] };
    expect(title({ fields: { level, summary: { type: "string" } } })).toBe("summary");
    expect(title({ fields: { name: level, summary: { type: "string" } } })).toBe("summary");
  });

  test("a title must be a text field, when created or changed", () => {
    const counted: EntityType = {
      name: "counter",
      label: "Counter",
      title: "count",
      fields: [
        { name: "label", label: "Label", type: "text" },
        { name: "count", label: "Count", type: "number" },
      ],
    };
    expect(planTypeWrite(undefined, counted)).toEqual({
      kind: "refused",
      message: "counter.count can't be the title: a title names a text field",
    });
    const existing = info("ticket", {
      title: "summary",
      fields: { summary: { type: "string" }, level: { type: "enum", values: ["low", "high"] } },
    });
    const ticket = toEntityType(existing);
    if (ticket === undefined) throw new Error("No type");
    expect(planTypeWrite(existing, { ...ticket, title: "level" })).toEqual({
      kind: "refused",
      message: "ticket.level can't be the title: a title names a text field",
    });
  });

  test("saving a type as it was writes nothing, even one entity-store gave no description or title", () => {
    const existing = info("ticket", { fields: { summary: { type: "string" } } });
    const ticket = toEntityType(existing);
    if (ticket === undefined) throw new Error("No type");
    expect(planTypeWrite(existing, ticket)).toEqual({ kind: "unchanged" });
    expect(planTypeWrite(existing, { ...ticket, label: "Tickets" })).toMatchObject({
      kind: "version",
      schema: { description: "Tickets", fields: { summary: { type: "string" } } },
    });
  });
});
