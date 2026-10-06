import type { Subject } from "../src/entities/model.ts";
import type { Catalog } from "../src/workflow/catalog.ts";
import { RunId } from "../src/workflow/run.ts";
import type { ExecutionValues } from "../src/workflow/execution.ts";
import type { Workflow } from "../src/workflow/model.ts";

/** What the evals work with: a People Ops team's entity store, its people, and drafts to edit. */

export const catalog: Catalog = {
  types: [
    {
      name: "employee",
      label: "Employee",
      title: "name",
      fields: [
        { name: "name", label: "Name", type: "text" },
        { name: "email", label: "Email", type: "text" },
        { name: "role", label: "Role", type: "text" },
        { name: "team", label: "Team", type: "text" },
        { name: "start_date", label: "Start date", type: "date" },
        { name: "manager", label: "Manager", type: "ref", to: "employee" },
      ],
    },
    {
      name: "contract",
      label: "Contract",
      title: "title",
      fields: [
        { name: "title", label: "Title", type: "text" },
        { name: "owner", label: "Owner", type: "ref", to: "employee" },
        { name: "ends_on", label: "Ends on", type: "date" },
        { name: "value", label: "Annual value", type: "number" },
      ],
    },
  ],
  templates: [
    {
      name: "welcome_engineer",
      label: "Engineering welcome",
      description: "Welcome email for a new engineer, sent to the new hire on their first day.",
      slots: [{ name: "hire", label: "New hire", type: "ref", to: "employee" }],
      content: {
        subject: "Welcome to engineering, {{hire.name}}",
        body: "Hi {{hire.name}}, welcome aboard! Your manager {{hire.manager}} will walk you through our dev setup on day one.",
      },
    },
    {
      name: "welcome_general",
      label: "General welcome",
      description:
        "Welcome email for a new hire who isn't an engineer, sent to the new hire on their first day.",
      slots: [{ name: "hire", label: "New hire", type: "ref", to: "employee" }],
      content: {
        subject: "Welcome, {{hire.name}}",
        body: "Hi {{hire.name}}, we're glad you're here. {{hire.manager}} will meet you on your first morning.",
      },
    },
    {
      name: "manager_heads_up",
      label: "Manager heads-up",
      description: "Slack message to a manager saying that their new report starts soon.",
      slots: [{ name: "hire", label: "New hire", type: "ref", to: "employee" }],
      content: { text: "Heads up: {{hire.name}} joins your team on {{hire.start_date}}." },
    },
    {
      name: "renewal_reminder",
      label: "Renewal reminder",
      description: "Email to a contract's owner reminding them to renew the contract.",
      slots: [{ name: "contract", label: "Contract", type: "ref", to: "contract" }],
      content: {
        subject: "Renew {{contract.title}}",
        body: "{{contract.title}} ends on {{contract.ends_on}}. Please start the renewal.",
      },
    },
  ],
  roles: [
    {
      name: "people_ops",
      label: "People Ops",
      members: [{ type: "employee", id: "pat" }],
    },
    { name: "legal", label: "Legal", members: [{ type: "employee", id: "lee" }] },
  ],
};

/** The same store before anyone has defined a role. */
export const catalogWithoutRoles: Catalog = { ...catalog, roles: [] };

export const ada: Subject = {
  type: "employee",
  id: "ada",
  data: {
    name: "Ada Lovelace",
    email: "ada@example.com",
    role: "Senior Backend Developer",
    team: "Payments",
    start_date: "2026-10-05",
    manager: "grace",
  },
};

export const values = (
  subject: Subject | null,
  steps: ExecutionValues["steps"] = {},
): ExecutionValues => ({ runId: RunId.make("eval"), subject, steps });

/** A draft that welcomes each hire on their start date, which the person set to run on its own. */
export const welcomeDraft: Workflow = {
  name: "Welcome new hires",
  trigger: {
    kind: "date",
    entity: "employee",
    on: "employee.start_date",
    time: "09:00",
    timezone: "Europe/London",
  },
  steps: [
    {
      id: "welcome",
      title: "Send the welcome email",
      kind: "action",
      use: "email.send",
      with: { to: "{{employee}}" },
      template: { use: "welcome_general", with: { hire: "{{employee}}" } },
    },
  ],
  // The person changed this from People Ops approving each email.
  permissions: { "email.send": "auto" },
};

/** A draft that tells the manager, waits for the start date, then welcomes the hire. */
export const headsUpDraft: Workflow = {
  name: "Prepare for new hires",
  trigger: { kind: "entity", entity: "employee" },
  steps: [
    {
      id: "heads_up",
      title: "Give the manager a heads-up",
      kind: "action",
      use: "slack.sendMessage",
      with: { to: "{{employee.manager}}" },
      template: { use: "manager_heads_up", with: { hire: "{{employee}}" } },
    },
    { id: "start", title: "Wait for the start date", kind: "wait", until: "employee.start_date" },
    {
      id: "welcome",
      title: "Send the welcome email",
      kind: "action",
      use: "email.send",
      with: { to: "{{employee}}" },
      template: { use: "welcome_general", with: { hire: "{{employee}}" } },
    },
  ],
  permissions: { "slack.sendMessage": { ask: "people_ops" }, "email.send": { ask: "people_ops" } },
};
