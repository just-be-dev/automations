/** Exercises nested event editing through the accessible controls, without raw JSON. */
import { test } from "bun:test";
import { change, click, expect, given, label, role, scene, type } from "foldkit/scene";
import type { HtmlBuilder } from "foldkit/html";
import type { Trigger } from "../../workflow.ts";
import { EventInput } from "../domain/index.ts";
import { eventInputView } from "./event-input.ts";

const trigger: Extract<Trigger, { kind: "event" }> = {
  kind: "event",
  event: "order.paid",
  when: {
    all: [
      { ref: "event.data.customer.name", op: "exists" },
      { ref: "event.data.total", op: "greaterThan", value: 100 },
      { ref: "event.data.confirmed", op: "equals", value: false },
    ],
  },
};

const update = (editor: EventInput.Model, message: EventInput.Message) => ({
  model: EventInput.update(editor, message),
});
const view = (editor: EventInput.Model, h: HtmlBuilder<EventInput.Message>) =>
  eventInputView(trigger, editor, (message) => message, false, h);

test("nested controls preserve item values when removing, adding, and changing their types", () => {
  scene(
    { update, view },
    given(EventInput.initial(trigger)),
    type(label("Name"), "Avery"),
    type(label("Total"), "137.5"),
    change(label("Confirmed"), "false"),
    click(role("button", { name: "Add field to Event data" })),
    type(label("New field field name"), "tags"),
    change(label("Tags type"), "array"),
    click(role("button", { name: "Add item to Tags" })),
    type(label("Tags item 1"), "001"),
    click(role("button", { name: "Add item to Tags" })),
    change(label("Tags item 2 type"), "number"),
    type(label("Tags item 2"), "-2.5"),
    click(role("button", { name: "Add item to Tags" })),
    change(label("Tags item 3 type"), "null"),
    expect(label("Tags item 1")).toHaveValue("001"),
    expect(label("Tags item 2")).toHaveValue("-2.5"),
    expect(label("Tags item 3")).not.toExist(),
    click(role("button", { name: "Remove Tags item 2" })),
    expect(label("Tags item 2 type")).toHaveValue("null"),
    click(role("button", { name: "Add item to Tags" })),
    type(label("Tags item 3"), "last"),
    expect(label("Tags item 1")).toHaveValue("001"),
    expect(label("Tags item 3")).toHaveValue("last"),
    change(label("Customer type"), "text"),
    expect(label("Name")).not.toExist(),
    type(label("Customer"), "Replaced"),
    expect(label("Customer")).toHaveValue("Replaced"),
    expect(label("Total")).toHaveValue("137.5"),
    expect(label("Confirmed")).toHaveValue("false"),
  );
});
