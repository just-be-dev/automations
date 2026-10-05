import { expect, test } from "bun:test";
import { permissionOf, permissionsOf } from "./connections.ts";
import type { Step, Workflow } from "./workflow.ts";

const action = (id: string, use: string): Step => ({
  id,
  title: id,
  kind: "action",
  use,
  with: {},
});

const workflow = (permissions?: Workflow["permissions"]): Workflow => ({
  name: "Test",
  trigger: { kind: "manual" },
  steps: [
    action("find", "calendar.findTimes"),
    {
      id: "branch",
      title: "Branch",
      kind: "parallel",
      branches: [[action("invite", "calendar.createEvent")], [action("mail", "email.send")]],
    },
  ],
  ...(permissions === undefined ? {} : { permissions }),
});

test("without a permission, lookups run on their own and everything else asks first", () => {
  expect(permissionOf(workflow(), "calendar.findTimes")).toBe("auto");
  expect(permissionOf(workflow(), "calendar.createEvent")).toBe("ask");
  expect(permissionOf(workflow(), "email.send")).toBe("ask");
  expect(permissionOf(workflow({ "email.send": "auto" }), "email.send")).toBe("auto");
});

test("lists the permission of every operation the workflow uses, nested ones included", () => {
  expect(permissionsOf(workflow({ "email.send": "auto", "http.post": "ask" }))).toEqual({
    "calendar.findTimes": "auto",
    "calendar.createEvent": "ask",
    "email.send": "auto",
  });
});
