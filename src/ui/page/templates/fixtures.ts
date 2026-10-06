/** Supplies welcome wording, entity slots, and automation usage for template-page tests. */
import * as Option from "effect/Option";
import type { EntityType, Template } from "../../../entities.ts";
import type { TemplateUsage } from "../../../workflow.ts";
import { Message, init, update, type Model } from "./index.ts";

export const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "start_date", label: "Start date", type: "date" },
  ],
};

export const welcome: Template = {
  name: "welcome_email",
  label: "Welcome email",
  description: "The standard welcome email for every new hire.",
  slots: [{ name: "hire", label: "New hire", type: "ref", to: "employee" }],
  content: {
    subject: "Welcome, {{hire.name}}",
    body: "Hi {{hire.name}}, you start on {{hire.start_date}}.",
  },
};

export const welcomeUsage: TemplateUsage = {
  automations: [
    { id: "onboarding", name: "Onboard new hires", updatedAt: 0, saved: true, draft: true },
    { id: "reminders", name: "Remind hires", updatedAt: 0, saved: false, draft: true },
  ],
  unchecked: [{ id: "broken", name: "Broken automation", updatedAt: 0, error: "Reset" }],
};

const applied = (start: Model, messages: ReadonlyArray<Message>) =>
  messages.reduce((current, next) => update(current, next).model, start);

export const welcomeOpen = applied(init(Option.some("welcome_email")).model, [
  Message.SucceededLoadCatalog({ templates: [welcome], types: [employee] }),
  Message.SucceededLoadUsage({ name: "welcome_email", usage: welcomeUsage }),
]);
