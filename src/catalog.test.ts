import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { describeCatalog, workflowProblems, type Catalog } from "./catalog.ts";
import type { EntityType } from "./entities.ts";
import { decodeWorkflow } from "./workflow.ts";

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

const catalog: Catalog = { types: [employee] };

const problems = (
  steps: ReadonlyArray<unknown>,
  trigger: unknown = { kind: "entity", entity: "employee" },
) => workflowProblems(catalog, Effect.runSync(decodeWorkflow({ name: "Test", trigger, steps })));

const agent = (id: string, instruction = `Do ${id}`) => ({
  id,
  title: id,
  kind: "agent",
  instruction,
});

describe("workflowProblems", () => {
  test("accepts refs through ref fields and to earlier steps", () => {
    expect(
      problems([
        agent("draft", "Welcome {{employee.name}}; tell {{employee.manager.email}}"),
        {
          id: "send",
          title: "Send",
          kind: "action",
          use: "slack.sendMessage",
          with: { to: "{{employee.manager}}", text: "{{steps.draft.output}}" },
        },
      ]),
    ).toEqual([]);
  });

  test("names fields that don't exist and paths through non-entities", () => {
    expect(problems([agent("a", "{{employee.desk}} and {{employee.name.first}}")])).toEqual([
      "Step a: employee.desk: employee has no field desk (fields: name, email, start_date, manager)",
      "Step a: employee.name.first: employee.name is a text, not an entity",
    ]);
  });

  test("rejects refs to steps that may not have run", () => {
    const branch = {
      id: "check",
      title: "Check",
      kind: "if",
      cases: [
        {
          when: { ref: "employee.start_date", op: "after", value: "now" },
          steps: [agent("inside")],
        },
      ],
    };
    expect(problems([branch, agent("after", "Use {{steps.inside.output}}")])).toEqual([
      "Step after: steps.inside.output reads step inside, which doesn't finish before this point on every path. Move the reader after it, outside the branch that contains it.",
    ]);
    expect(problems([agent("first", "Use {{steps.later.output}}"), agent("later")])).toHaveLength(
      1,
    );
  });

  test("checks what a step's record holds", () => {
    expect(
      problems([
        {
          id: "slots",
          title: "Slots",
          kind: "action",
          use: "calendar.findTimes",
          with: {
            attendees: ["{{employee}}"],
            after: "2026-11-02T00:00:00Z",
            duration: "30 minutes",
          },
        },
        {
          id: "pick",
          title: "Pick",
          kind: "agent",
          instruction: "Pick from {{steps.slots.output.times}} or {{steps.slots.times}}",
          output: { fields: [{ name: "start", type: "datetime" }] },
        },
        {
          id: "confirm",
          title: "Confirm",
          kind: "human",
          prompt: "Keep {{steps.pick.output.start}}? Not {{steps.pick.output.when}}",
          response: { fields: [{ name: "start", label: "Start", type: "datetime" }] },
        },
        agent("book", "Book {{steps.confirm.values.start}}, not {{steps.confirm.values.end}}"),
      ]),
    ).toEqual([
      "Step pick: steps.slots.output.times: step slots records times",
      "Step confirm: steps.pick.output.when: steps.pick.output has fields start",
      "Step book: steps.confirm.values.end: steps.confirm.values has fields start",
    ]);
  });

  test("makes every parallel branch's steps available after the parallel step", () => {
    expect(
      problems([
        {
          id: "prep",
          title: "Prep",
          kind: "parallel",
          branches: [[agent("laptop")], [agent("buddy", "Not {{steps.laptop.output}}")]],
        },
        agent("report", "{{steps.laptop.output}} and {{steps.buddy.output}}"),
      ]),
    ).toEqual([
      "Step buddy: steps.laptop.output reads step laptop, which doesn't finish before this point on every path. Move the reader after it, outside the branch that contains it.",
    ]);
  });

  test("checks operations, their inputs, and the URLs they post to", () => {
    expect(
      problems([
        { id: "x", title: "X", kind: "action", use: "fax.send", with: {} },
        {
          id: "invite",
          title: "Invite",
          kind: "action",
          use: "calendar.createEvent",
          with: {
            title: "1:1",
            attendees: "{{employee}}",
            start: "2026-11-02T10:00:00Z",
            room: "4",
          },
        },
        {
          id: "hook",
          title: "Hook",
          kind: "action",
          use: "http.post",
          with: { url: "https://10.0.0.1/hook" },
        },
      ]),
    ).toEqual([
      "Step x uses unknown operation fax.send",
      "Step invite: calendar.createEvent has no input room",
      'Step invite input attendees is a list, such as ["{{employee}}", "{{employee.manager}}"]',
      "Step invite input duration is required by calendar.createEvent",
      "Step hook input url must be a literal public HTTPS URL without credentials",
    ]);
  });

  test("requires people to be entities with an email or email addresses", () => {
    expect(
      problems([
        {
          id: "send",
          title: "Send",
          kind: "action",
          use: "email.send",
          with: { to: "{{employee.start_date}}", subject: "Hi", body: "Hi" },
        },
        {
          id: "ask",
          title: "Ask",
          kind: "human",
          prompt: "Confirm",
          assignee: "employee.name",
          response: "approval",
        },
      ]),
    ).toEqual([
      "Step send input to: employee.start_date isn't a person; point it at an entity with an email field",
      "Step ask: assignee employee.name isn't a person",
    ]);
  });

  test("checks the trigger and refs in workflows without a subject", () => {
    expect(problems([agent("a")], { kind: "entity", entity: "contractor" })).toEqual([
      "The trigger names unknown entity type contractor (types: employee)",
    ]);
    expect(
      problems([agent("a")], { kind: "entity", entity: "employee", fields: ["salary"] }),
    ).toEqual(["The trigger watches employee.salary, which doesn't exist"]);
    expect(problems([agent("a", "{{employee.name}}")], { kind: "manual" })).toEqual([
      "Step a: employee.name starts with employee, but this workflow has no subject. Refs start with steps., or with the trigger's entity type (the manual trigger's subject, or an entity trigger). Entity types: employee.",
    ]);
  });
});

test("describes object types and operations for the designer", () => {
  const description = describeCatalog(catalog);
  expect(description).toContain(
    "- employee (Employee; shown as its name): name text, email email, start_date date, manager → employee, id",
  );
  expect(description).toContain("- slack.sendMessage:");
});
