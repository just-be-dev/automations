/** Exercises entity-store forms and tables through their accessible controls, including failed saves. */
import { test } from "bun:test";
import * as Option from "effect/Option";
import {
  Command,
  change,
  click,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
} from "foldkit/scene";
import { employeesOpen } from "./fixtures.ts";
import { Message, SaveEntity, SaveType, init, update, view } from "./index.ts";

test("a type shows its fields and its entities, which open in a form", () => {
  scene(
    { update, view },
    given(employeesOpen),
    expect(role("link", { name: /Employee/ })).toHaveAttr("aria-current", "page"),
    expect(role("table", { name: "Employee fields" })).toContainText("ref → employee"),
    expect(role("table", { name: "Employee entities" })).toContainText("Ada Lovelace"),
    click(role("button", { name: "Edit ada" })),
    expect(label("ID")).toHaveAttr("data-readonly"),
    expect(label("Level")).toHaveValue("3"),
    type(label("Start date"), "2026-11-02"),
    submit(role("form", { name: "Edit ada" })),
    Command.expectExact(
      SaveEntity({
        type: "employee",
        id: "ada",
        data: { name: "Ada Lovelace", level: 3, start_date: "2026-11-02", manager: "grace" },
      }),
    ),
    Command.resolve(
      SaveEntity,
      Message.FailedRequest({ error: "employee.manager points nowhere" }),
    ),
    expect(role("status")).toHaveText("employee.manager points nowhere"),
  );
});

test("a new type is built from field rows", () => {
  scene(
    { update, view },
    given(update(init(Option.none()).model, Message.SucceededLoadTypes({ types: [] })).model),
    click(role("button", { name: "New entity type" })),
    expect(role("heading", { name: "Create entity type" })).toExist(),
    type(label("Name"), "Office locations"),
    expect(label("ID")).toHaveValue("office_locations"),
    type(label("Name"), "Office directory"),
    expect(label("ID")).toHaveValue("office_directory"),
    type(label("ID"), "HQ Offices 2026"),
    expect(label("ID")).toHaveValue("hq_offices_2026"),
    expect(label("Name")).toHaveValue("Office directory"),
    click(role("button", { name: "Add field" })),
    type(label("Field name (new field)"), "city"),
    change(label("Field type (city)"), "text"),
    click(role("button", { name: "Add field" })),
    type(label("Field name (new field)"), "capacity"),
    click(role("button", { name: "Remove field capacity" })),
    expect(label("Field name (city)")).toHaveValue("city"),
    submit(role("form", { name: "New entity type" })),
    Command.expectExact(
      SaveType({
        type: {
          name: "hq_offices_2026",
          label: "Office directory",
          title: "name",
          fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "city", label: "City", type: "text" },
          ],
        },
        isNew: true,
      }),
    ),
    Command.resolve(SaveType, Message.FailedRequest({ error: "Try again" })),
  );
});

test("with no type chosen, the page explains the store", () => {
  scene(
    { update, view },
    given(update(init(Option.none()).model, Message.SucceededLoadTypes({ types: [] })).model),
    expect(text("Entity store")).toExist(),
    expect(text("No entity types yet.")).toExist(),
  );
});
