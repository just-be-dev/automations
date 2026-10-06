/** Checks template slots, reference substitution, nested expansion, and ordered template-use discovery. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { EntityType } from "./model.ts";
import {
  expandTemplates,
  fillTemplate,
  templateProblems,
  usedTemplates,
  type Template,
} from "./templates.ts";
import type { Workflow } from "../workflow/model.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "text" },
    { name: "manager", label: "Manager", type: "ref", to: "employee" },
  ],
};

const welcome: Template = {
  name: "welcome",
  label: "Welcome",
  description: "Welcomes a new hire.",
  slots: [
    { name: "hire", label: "New hire", type: "ref", to: "employee" },
    { name: "note", label: "A personal note", type: "text" },
  ],
  content: {
    subject: "Welcome, {{hire.name}}",
    body: "Your manager is {{hire.manager}} ({{hire.manager.email}}). {{note}}",
  },
};

describe("templateProblems", () => {
  test("accepts refs that start at a slot and follow ref fields", () => {
    expect(templateProblems([employee], welcome)).toEqual([]);
  });

  test("names refs outside the slots, missing fields, and unknown slot types", () => {
    expect(
      templateProblems([employee], {
        ...welcome,
        slots: [...welcome.slots, { name: "team", label: "Team", type: "ref", to: "team" }],
        content: { body: "{{employee.name}} {{hire.desk}} {{note.text}}" },
      }),
    ).toEqual([
      "Slot team points to unknown entity type team",
      "{{employee.name}} doesn't start with a slot (slots: hire, note, team)",
      "{{hire.desk}}: employee has no field desk (fields: name, email, manager)",
      "{{note.text}}: welcome.note is a text, not an entity",
    ]);
  });
});

describe("fillTemplate", () => {
  test("reads entity slots through the ref that fills them and inserts text slots", () => {
    expect(
      fillTemplate(welcome, {
        use: "welcome",
        with: { hire: "{{employee}}", note: "Glad you're here, {{employee.name}}!" },
      }),
    ).toEqual({
      subject: "Welcome, {{employee.name}}",
      body: "Your manager is {{employee.manager}} ({{employee.manager.email}}). Glad you're here, {{employee.name}}!",
    });
  });

  test("a text slot filled with one ref reads that ref", () => {
    expect(
      fillTemplate(welcome, {
        use: "welcome",
        with: { hire: "{{employee.manager}}", note: "{{steps.draft.output}}" },
      }).body,
    ).toBe(
      "Your manager is {{employee.manager.manager}} ({{employee.manager.manager.email}}). {{steps.draft.output}}",
    );
  });
});

describe("expandTemplates", () => {
  const send = {
    id: "send",
    title: "Send",
    kind: "action",
    use: "email.send",
    with: { to: "{{employee}}" },
    match: {
      on: "employee.name",
      cases: [
        {
          when: { op: "equals", value: "Ada" },
          template: { use: "welcome", with: { hire: "{{employee}}", note: "Hi Ada" } },
        },
      ],
      otherwise: { with: { subject: "Hello", body: "Welcome" } },
    },
  } as const;
  const workflow: Workflow = {
    name: "Welcome",
    trigger: { kind: "entity", entity: "employee" },
    steps: [
      {
        id: "known",
        title: "Known?",
        kind: "if",
        cases: [{ when: { ref: "employee.name", op: "exists" }, steps: [send] }],
      },
    ],
  };

  test("replaces template uses with the inputs they fill, inside branches and match cases", () => {
    const expanded = Effect.runSync(expandTemplates(workflow, [welcome]));
    expect(expanded.steps[0]).toMatchObject({
      cases: [
        {
          steps: [
            {
              with: { to: "{{employee}}" },
              match: {
                cases: [
                  {
                    when: { op: "equals", value: "Ada" },
                    with: {
                      subject: "Welcome, {{employee.name}}",
                      body: "Your manager is {{employee.manager}} ({{employee.manager.email}}). Hi Ada",
                    },
                  },
                ],
                otherwise: { with: { subject: "Hello", body: "Welcome" } },
              },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(expanded)).not.toContain('"template"');
  });

  test("fails when a template is missing", () => {
    const error = Effect.runSync(Effect.flip(expandTemplates(workflow, [])));
    expect(error.message).toBe("Unknown templates: welcome");
  });

  test("usedTemplates names each template once, from the step, its match, and nested branches", () => {
    const farewell = {
      ...send,
      id: "farewell",
      template: { use: "farewell", with: { hire: "{{employee}}" } },
    };
    expect(
      usedTemplates({
        ...workflow,
        steps: [...workflow.steps, farewell, { ...send, id: "again" }],
      }),
    ).toEqual(["welcome", "farewell"]);
  });
});
