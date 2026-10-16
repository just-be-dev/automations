/**
 * What the calls work with whatever the dataset: a People Ops team's entity store, and the run a
 * step's input describes. The cases, and the records and drafts they use, are in `datasets/`.
 */

import * as Schema from "effect/Schema";
import { Subject } from "../src/entities/model.ts";
import { Event } from "../src/events/model.ts";
import type { Catalog } from "../src/workflow/catalog.ts";
import type { ExecutionValues } from "../src/workflow/execution.ts";
import { RunId } from "../src/workflow/run.ts";

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

/** What an agent or decide step's run holds when the step starts. */
export const RunState = {
  /** The run's subject; it has none when left out. */
  subject: Schema.optionalKey(Schema.NullOr(Subject)),
  /** The event that started the run, if one did. */
  event: Schema.optionalKey(Event),
  /** Earlier steps' records, by step ID. */
  steps: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
};

/** The interpreter's values for a run in `RunState`. */
export const values = (state: {
  readonly subject?: Subject | null;
  readonly event?: Event;
  readonly steps?: ExecutionValues["steps"];
}): ExecutionValues => ({
  runId: RunId.make("eval"),
  subject: state.subject ?? null,
  ...(state.event === undefined ? {} : { event: state.event }),
  steps: state.steps ?? {},
});
