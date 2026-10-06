/** Checks workflow references, branch ordering, operation inputs, templates, and role permissions against a catalog. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { describeCatalog, workflowProblems, type Catalog } from "./catalog.ts";
import { findOperation } from "../connections/registry.ts";
import type { EntityType } from "../entities/model.ts";
import type { Template } from "../entities/templates.ts";
import { decodeWorkflow, operationsUsed } from "./model.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "text" },
    { name: "start_date", label: "Start date", type: "date" },
    { name: "manager", label: "Manager", type: "ref", to: "employee" },
  ],
};

const welcome: Template = {
  name: "welcome",
  label: "Welcome email",
  description: "Welcomes any new hire.",
  slots: [{ name: "hire", label: "New hire", type: "ref", to: "employee" }],
  content: { subject: "Welcome, {{hire.name}}", body: "Hi {{hire.name}}" },
};

const engineering: Template = {
  ...welcome,
  name: "engineering",
  label: "Engineering welcome",
  description: "Welcomes new engineers.",
  slots: [...welcome.slots, { name: "team", label: "Team", type: "text" }],
  content: { body: "Hi {{hire.name}}, welcome to {{team}}" },
};

const catalog: Catalog = {
  types: [employee],
  templates: [welcome, engineering],
  roles: [
    { name: "people_ops", label: "People Ops", members: [{ type: "employee", id: "grace" }] },
  ],
};

/** The problems with a workflow of these steps, whose operations all run automatically. */
const problems = (
  steps: ReadonlyArray<unknown>,
  trigger: unknown = { kind: "entity", entity: "employee" },
) => {
  const workflow = Effect.runSync(decodeWorkflow({ name: "Test", trigger, steps }));
  return workflowProblems(catalog, {
    ...workflow,
    permissions: Object.fromEntries(
      operationsUsed(workflow.steps)
        .filter((operation) => findOperation(operation) !== undefined)
        .map((operation) => [operation, "auto"]),
    ),
  });
};

const sendEmail = (fields: Record<string, unknown>) => ({
  id: "send",
  title: "Send",
  kind: "action",
  use: "email.send",
  with: { to: "{{employee}}" },
  ...fields,
});

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

  test("requires people to be entities with an email field, that field, or email addresses", () => {
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
        {
          id: "confirm",
          title: "Confirm",
          kind: "human",
          prompt: "Confirm",
          assignee: "employee.email",
          response: "approval",
        },
      ]),
    ).toEqual([
      "Step send input to: employee.start_date isn't a person; point it at an entity with an email field",
      "Step ask: assignee employee.name isn't a person",
    ]);
  });

  test("accepts templates that fill inputs, alone or picked by a match", () => {
    expect(
      problems([
        sendEmail({ template: { use: "welcome", with: { hire: "{{employee}}" } } }),
        {
          ...sendEmail({
            match: {
              on: "employee.name",
              cases: [
                {
                  when: { any: [{ op: "contains", value: "eng" }, { op: "exists" }] },
                  with: { subject: "Welcome to engineering" },
                  template: {
                    use: "engineering",
                    with: { hire: "{{employee}}", team: "Platform, under {{employee.manager}}" },
                  },
                },
              ],
              otherwise: { template: { use: "welcome", with: { hire: "{{employee.manager}}" } } },
            },
          }),
          id: "send-by-role",
        },
      ]),
    ).toEqual([]);
  });

  test("checks which template a step uses and what fills its slots", () => {
    expect(
      problems([
        sendEmail({ template: { use: "farewell", with: {} } }),
        {
          ...sendEmail({
            template: { use: "welcome", with: { hire: "{{employee.name}}", desk: "4" } },
          }),
          id: "wrong-slot",
        },
        {
          ...sendEmail({
            template: { use: "engineering", with: { hire: "{{steps.send.messageId}}" } },
          }),
          id: "unfilled",
          with: { to: "{{employee}}", subject: "Hi" },
        },
      ]),
    ).toEqual([
      "Step send uses unknown template farewell (templates: welcome, engineering)",
      "Step send input subject is required by email.send",
      "Step send input body is required by email.send",
      "Step wrong-slot: template welcome has no slot desk (slots: hire)",
      "Step wrong-slot: template welcome: slot hire takes one employee: fill it with exactly one {{ref}} that starts at the trigger's entity and leads to one employee",
      "Step unfilled: template engineering: slot hire takes one employee: fill it with exactly one {{ref}} that starts at the trigger's entity and leads to one employee",
      "Step unfilled: template engineering needs slot team (Team) filled",
    ]);
  });

  test("gives each input once on every path through a match, and only text from templates", () => {
    expect(
      problems([
        sendEmail({
          with: { to: "{{employee}}", subject: "Hi" },
          match: {
            on: "employee.name",
            cases: [
              {
                when: { op: "equals", value: "Ada" },
                template: { use: "welcome", with: { hire: "{{employee}}" } },
              },
            ],
            otherwise: { with: { to: "{{employee.manager}}" } },
          },
        }),
        {
          id: "post",
          title: "Post",
          kind: "action",
          use: "http.post",
          with: { url: "https://example.com/hook" },
          template: { use: "engineering", with: { hire: "{{employee}}", team: "Core" } },
        },
      ]),
    ).toEqual([
      "Step send (case 1) input subject comes from both the step's with and template welcome; keep one",
      "Step send (otherwise) input to comes from both the step's with and the case's with; keep one",
      "Step send (otherwise) input body is required by email.send",
      "Step post input body takes a json, which a template can't fill",
    ]);
  });

  test("checks the ref a match reads", () => {
    expect(
      problems([
        sendEmail({
          with: { to: "{{employee}}", subject: "Hi", body: "Hi" },
          match: {
            on: "employee.role",
            cases: [{ when: { op: "exists" }, with: {} }],
            otherwise: {},
          },
        }),
      ]),
    ).toEqual([
      "Step send: employee.role: employee has no field role (fields: name, email, start_date, manager)",
    ]);
  });

  test("rejects steps after a stop step in the same list, wherever it is nested", () => {
    const stop = { id: "halt", title: "Halt", kind: "stop", reason: "Rejected" };
    expect(problems([agent("one"), stop])).toEqual([]);
    expect(
      problems([
        {
          id: "check",
          title: "Check",
          kind: "if",
          cases: [{ when: { ref: "employee.name", op: "exists" }, steps: [stop, agent("late")] }],
        },
        agent("after"),
      ]),
    ).toEqual(["Step late comes after stop step halt, so it never runs"]);
  });

  test("every operation used needs a permission, and asks name roles that exist", () => {
    const check = (permissions: unknown) =>
      workflowProblems(
        catalog,
        Effect.runSync(
          decodeWorkflow({
            name: "Test",
            trigger: { kind: "manual" },
            steps: [
              {
                id: "mail",
                title: "Mail",
                kind: "action",
                use: "email.send",
                with: { to: "a@example.com", subject: "Hi", body: "Hello" },
              },
            ],
            permissions,
          }),
        ),
      );
    expect(check({ "email.send": { ask: "people_ops" } })).toEqual([]);
    expect(check({ "email.send": "auto", "fax.send": "auto" })).toEqual([
      "permissions names unknown operation fax.send",
    ]);
    expect(check({})).toEqual([
      'permissions needs one for email.send: "auto", or {"ask":"<role>"}',
    ]);
    expect(check({ "email.send": { ask: "finance" } })).toEqual([
      "permissions for email.send ask unknown role finance (roles: people_ops)",
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
      "Step a: employee.name starts with employee, but this workflow has no subject. Refs start with steps., or with the trigger's entity type (the manual trigger's subject, or another trigger's entity). Entity types: employee.",
    ]);
  });

  test("checks that a date trigger reads a date of its entity", () => {
    const date = { kind: "date", entity: "employee", on: "employee.start_date" };
    expect(problems([agent("a")], date)).toEqual([]);
    expect(problems([agent("a")], { ...date, on: "employee.manager.start_date" })).toEqual([]);
    expect(problems([agent("a")], { ...date, on: "employee.name" })).toEqual([
      "The trigger's date employee.name must be a date or datetime field",
    ]);
    expect(problems([agent("a")], { ...date, on: "employee.ends" })).toEqual([
      expect.stringContaining("employee has no field ends"),
    ]);
    expect(problems([agent("a")], { ...date, on: "steps.a.output" })).toEqual([
      "The trigger's date steps.a.output must start with employee",
    ]);
  });

  test("checks a schedule's entity and condition like an entity trigger's", () => {
    const weekly = { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/London" };
    expect(problems([agent("a")], weekly)).toEqual([]);
    expect(
      problems([agent("a", "{{employee.name}}")], {
        ...weekly,
        entity: "employee",
        when: { ref: "employee.manager.start_date", op: "after", value: "now" },
      }),
    ).toEqual([]);
    expect(problems([agent("a")], { ...weekly, entity: "contractor" })).toEqual([
      "The trigger names unknown entity type contractor (types: employee)",
    ]);
    expect(
      problems([agent("a")], {
        ...weekly,
        entity: "employee",
        when: { ref: "employee.salary", op: "exists" },
      }),
    ).toEqual([expect.stringContaining("employee.salary")]);
    expect(
      problems([agent("a")], { ...weekly, when: { ref: "employee.name", op: "exists" } }),
    ).toEqual([
      'The trigger\'s condition needs an entity type: name the one it checks in "entity"',
    ]);
  });
});

test("describes object types and operations for the planner", () => {
  const description = describeCatalog(catalog);
  expect(description).toContain(
    "- employee (Employee; shown as its name): name text, email text, start_date date, manager → employee, id",
  );
  expect(description).toContain("- slack.sendMessage:");
  expect(description).toContain(
    "- welcome (Welcome email): Welcomes any new hire. Slots: hire → employee (New hire). Fills subject, body; fits email.send.",
  );
  expect(description).toContain(
    "Slots: hire → employee (New hire), team text (Team). Fills body; fits email.send.",
  );
  expect(description).toContain("- people_ops (People Ops): 1 member");
});
