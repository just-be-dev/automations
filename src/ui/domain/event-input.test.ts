/** Checks typed values, nested edits, identity, and honest partial-shape suggestions. */
import { expect, test } from "bun:test";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Message, Model, data, initial, update, type Node } from "./event-input.ts";
import type { Workflow } from "../../workflow.ts";

const apply = (editor: Model, messages: ReadonlyArray<Message>) => messages.reduce(update, editor);
const field = (editor: Model, path: ReadonlyArray<string>): Node =>
  path.reduce((node, name) => {
    const found = node.children.find((child) => child.name === name);
    if (found === undefined) {
      throw new Error(`No field ${name}`);
    }
    return found;
  }, editor.root);

test("workflow references suggest nested fields and condition types without filling values", () => {
  const workflow: Workflow = {
    name: "Paid order",
    trigger: {
      kind: "event",
      event: "order.paid",
      when: {
        all: [
          { ref: "event.data.total", op: "greaterThan", value: 100 },
          { ref: "event.data.confirmed", op: "equals", value: true },
        ],
      },
    },
    steps: [
      {
        kind: "agent",
        id: "check",
        title: "Check",
        instruction: "Read {{event.data.customer.name}} and {{event.data.total}}",
      },
    ],
  };
  const editor = initial(workflow.trigger, workflow);
  expect(editor.root.children.map((node) => node.name)).toEqual(["total", "confirmed", "customer"]);
  expect(field(editor, ["total"]).kind).toBe("number");
  expect(field(editor, ["confirmed"]).kind).toBe("boolean");
  expect(field(editor, ["customer", "name"]).kind).toBe("text");
  expect(field(editor, ["total"]).value).toBe("");
  expect(Result.isFailure(data(editor))).toBe(true);
  const filled = apply(editor, [
    Message.UpdatedValue({ id: field(editor, ["total"]).id, value: "137.5" }),
    Message.UpdatedValue({ id: field(editor, ["confirmed"]).id, value: "false" }),
    Message.UpdatedValue({ id: field(editor, ["customer", "name"]).id, value: "  Avery  " }),
  ]);
  expect(data(filled)).toEqual(
    Result.succeed({ total: 137.5, confirmed: false, customer: { name: "  Avery  " } }),
  );
  expect(Schema.decodeUnknownSync(Model)(filled)).toEqual(filled);
  const ids = [
    filled.root.id,
    ...filled.root.children.map((node) => node.id),
    field(filled, ["customer", "name"]).id,
  ];
  expect(new Set(ids).size).toBe(ids.length);
});

test("a visual list keeps item order and types; removed IDs never get reused", () => {
  const editor = apply(initial({ kind: "event", event: "example" }), [
    Message.SelectedKind({ id: 0, kind: "array" }),
    Message.ClickedAdd({ id: 0 }),
    Message.UpdatedValue({ id: 1, value: "001" }),
    Message.ClickedAdd({ id: 0 }),
    Message.SelectedKind({ id: 2, kind: "number" }),
    Message.UpdatedValue({ id: 2, value: "-2.5" }),
    Message.ClickedAdd({ id: 0 }),
    Message.SelectedKind({ id: 3, kind: "null" }),
  ]);
  expect(data(editor)).toEqual(Result.succeed(["001", -2.5, null]));
  const removed = apply(editor, [
    Message.ClickedRemove({ id: 2 }),
    Message.ClickedAdd({ id: 0 }),
    Message.UpdatedValue({ id: 4, value: "last" }),
  ]);
  expect(data(removed)).toEqual(Result.succeed(["001", null, "last"]));
  expect(removed.root.children.map((node) => node.id)).toEqual([1, 3, 4]);
  expect(data(update(removed, Message.SelectedKind({ id: 0, kind: "null" })))).toEqual(
    Result.succeed(null),
  );
});

test("object names and typed fields reject ambiguous or invalid values", () => {
  const editor = apply(initial({ kind: "event", event: "example" }), [
    Message.ClickedAdd({ id: 0 }),
    Message.UpdatedName({ id: 1, name: "total" }),
    Message.SelectedKind({ id: 1, kind: "number" }),
  ]);
  expect(data(editor)).toEqual(Result.fail("Enter a number for Event data.total"));
  expect(
    Result.isFailure(data(update(editor, Message.UpdatedValue({ id: 1, value: "Infinity" })))),
  ).toBe(true);
  const filled = update(editor, Message.UpdatedValue({ id: 1, value: "0" }));
  expect(data(filled)).toEqual(Result.succeed({ total: 0 }));
  const duplicate = apply(filled, [
    Message.ClickedAdd({ id: 0 }),
    Message.UpdatedName({ id: 2, name: " total " }),
  ]);
  expect(data(duplicate)).toEqual(Result.fail("Give each field in Event data a different name"));
  const boolean = update(filled, Message.SelectedKind({ id: 1, kind: "boolean" }));
  expect(Result.isFailure(data(boolean))).toBe(true);
  expect(
    Result.isFailure(data(update(boolean, Message.UpdatedValue({ id: 1, value: "no" })))),
  ).toBe(true);
  expect(data(update(boolean, Message.UpdatedValue({ id: 1, value: "false" })))).toEqual(
    Result.succeed({ total: false }),
  );
});

test("entity facts use known snapshot fields; indexed refs do not become incorrectly positioned items", () => {
  const editor = initial(
    { kind: "event", event: "entity.created", subject: "employee" },
    undefined,
    [
      {
        name: "employee",
        label: "Employee",
        title: "name",
        fields: [
          { name: "name", label: "Full name", type: "text" },
          { name: "active", label: "Active", type: "boolean" },
        ],
      },
    ],
  );
  expect(field(editor, ["before"]).kind).toBe("null");
  expect(field(editor, ["after", "name"]).kind).toBe("text");
  expect(field(editor, ["after", "active"]).kind).toBe("boolean");
  const indexed = initial({
    kind: "event",
    event: "example",
    when: { ref: "event.data.items.3.name", op: "exists" },
  });
  expect(field(indexed, ["items"]).kind).toBe("array");
  expect(data(indexed)).toEqual(Result.succeed({ items: [] }));
});
