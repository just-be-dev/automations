/** The demo's known state: its people, entity type, templates, role, and saved onboarding workflow. */
import * as Schema from "effect/Schema";
import type { EntityData, EntityType } from "../src/entities/model.ts";
import type { Template } from "../src/entities/templates.ts";
import { Workflow } from "../src/workflow/model.ts";
import onboarding from "./onboarding.json" with { type: "json" };

/**
 * The fallback copy of the onboarding workflow the storyboard builds, for when the live planner
 * misbehaves on stage. It lives under its own ID, so it never collides with the automation the
 * presenter creates.
 */
export const fallbackId = "first-week";
export const fallback: Workflow = Schema.decodeUnknownSync(Workflow)(onboarding);

/** The new hire's ID. Their start date moves with the calendar, so the demo never goes stale. */
export const newHire = "ada";

/** Shown wherever the demo has no configured address. These go nowhere. */
const placeholderDomain = "example.com";

/** A person in the demo. `email` is a placeholder unless `.env` sets `emailKey`. */
interface Person {
  readonly id: string;
  readonly emailKey: string;
  readonly data: (startDate: string) => Omit<EntityData, "email">;
}

const person = (id: string, data: Person["data"]): Person => ({
  id,
  emailKey: `DEMO_${id.toUpperCase()}_EMAIL`,
  data,
});

/** Managers come before their reports. */
export const people: ReadonlyArray<Person> = [
  person("grace", () => ({
    name: "Grace Hopper",
    role: "Engineering manager",
    start_date: "2019-03-04",
    manager: null,
  })),
  person("mary", () => ({
    name: "Mary Jackson",
    role: "People Ops partner",
    start_date: "2020-06-01",
    manager: null,
  })),
  person("katherine", () => ({
    name: "Katherine Johnson",
    role: "Senior software engineer",
    start_date: "2021-09-13",
    manager: "grace",
  })),
  person(newHire, (startDate) => ({
    name: "Ada Lovelace",
    role: "Software engineer",
    start_date: startDate,
    manager: "grace",
  })),
];

/** `YYYY-MM-DD` for a calendar date, without a time zone shifting it. */
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/** The first Monday at least two weeks after `today`, the date in the person's own calendar. */
export const startDateFrom = (today: Date) => {
  const twoWeeksOut = new Date(
    Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + 14),
  );
  const daysToMonday = (8 - twoWeeksOut.getUTCDay()) % 7;
  twoWeeksOut.setUTCDate(twoWeeksOut.getUTCDate() + daysToMonday);
  return isoDate(twoWeeksOut);
};

/** Each person's record, with the address `.env` gives them or a placeholder. */
export const employees = (
  emails: Readonly<Record<string, string | undefined>>,
  startDate: string,
): ReadonlyArray<{ readonly id: string; readonly data: EntityData }> =>
  people.map((each) => ({
    id: each.id,
    data: {
      ...each.data(startDate),
      email: emails[each.emailKey] ?? `${each.id}@${placeholderDomain}`,
    },
  }));

/** The demo's sample `employee` type, which the reset writes through the studio. */
export const employeeType: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "text" },
    { name: "role", label: "Role", type: "text" },
    { name: "start_date", label: "Start date", type: "date" },
    { name: "manager", label: "Manager", type: "ref", to: "employee" },
  ],
};

/**
 * What the reset tells the presenter about approving. Anyone in the studio may approve; a local
 * studio knows the presenter only by `DEV_USER_EMAIL`, and records approvals under it.
 */
export const approverNote = (
  devUser: string | undefined,
  seeded: ReadonlyArray<{ readonly id: string; readonly data: EntityData }>,
) => {
  if (devUser === undefined) {
    return "Approvals in the studio name no one. Set DEV_USER_EMAIL to your address, restart dev, and reset again.";
  }
  const you = seeded.find(
    (each) => String(each.data["email"]).toLowerCase() === devUser.toLowerCase(),
  );
  return you === undefined
    ? `You approve as ${devUser}.`
    : `You approve as ${String(you.data["name"])} (${devUser}).`;
};

/** The two welcome emails, which the reset writes through the studio. */
export const templates: ReadonlyArray<Template> = [
  {
    name: "engineering_welcome_email",
    label: "Engineering welcome email",
    description:
      "The standard welcome email for new engineers: software engineers, engineering managers, and other engineering roles. Send it to the new hire before they start.",
    slots: [
      { name: "hire", label: "New hire", type: "ref", to: "employee" },
      { name: "manager", label: "Their manager", type: "ref", to: "employee" },
    ],
    content: {
      subject: "Welcome to engineering, {{hire.name}}",
      body: "Hi {{hire.name}},\n\nWelcome to the engineering team! You start on {{hire.start_date}}, and {{manager.name}} will be your manager.\n\nIn your first week you'll set up your development environment, pair with a teammate on a small change, and ship it to production. {{manager.name}} will walk you through the engineering handbook on day one.\n\nIf you have questions before you start, write to {{manager.email}}.\n\nSee you soon!",
    },
  },
  {
    name: "welcome_email",
    label: "Welcome email",
    description:
      "The standard welcome email for any new hire without a more specific welcome template. Send it to the new hire before they start.",
    slots: [{ name: "hire", label: "New hire", type: "ref", to: "employee" }],
    content: {
      subject: "Welcome aboard, {{hire.name}}",
      body: "Hi {{hire.name}},\n\nWe're excited to have you join us as {{hire.role}} on {{hire.start_date}}.\n\nOn your first day you'll meet your manager, {{hire.manager}}, get your accounts set up, and spend some time getting to know the team.\n\nIf you have any questions before then, just reply to this email.\n\nSee you soon!",
    },
  },
];
