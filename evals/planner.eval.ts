/** The planner turns one chat message into a draft, and answers the person. */

import { expect } from "bun:test";
import { conditionRefs } from "../src/workflow/model.ts";
import {
  actions,
  exchange,
  humans,
  permission,
  planner,
  said,
  stepIds,
  steps,
  templates,
  type PlannerOutput,
} from "./calls/planner.ts";
import { defineEval, judged } from "./framework/eval.ts";
import { catalogWithoutRoles, headsUpDraft, welcomeDraft } from "./fixtures.ts";

const drafts = {
  "drafts a workflow": (output: PlannerOutput) => expect(output.workflow).toBeDefined(),
  "gets it right the first time": (output: PlannerOutput) => expect(output.retried).toBe(false),
};

const fulfills = (criterion: string) => ({ "does what was asked": judged(criterion, exchange) });

export default defineEval({
  call: planner,
  minimum: 0.75,
  every: {
    "replies in prose, not code": (output) =>
      expect(output.reply).not.toMatch(/```|^\s*[{[]|^\s*name:/m),
    "replies in plain words": judged(
      "The reply is written for someone who doesn't build software. It says what changed or asks a question in plain words, and doesn't mention tools, JSON, YAML, step IDs, refs, or internal checks.",
      (output) => output.reply,
    ),
  },
  cases: {
    "event-relay": {
      input: {
        message:
          "When the event order.paid arrives, emit order.fulfilled with exactly the same JSON payload. No entity subject is needed. Allow this event publication automatically.",
      },
      checks: {
        ...drafts,
        "listens for the named event": (output) =>
          expect(output.workflow?.trigger).toEqual({ kind: "event", event: "order.paid" }),
        "passes the payload through unchanged": (output) =>
          expect(actions(output, "events.emit")).toContainEqual(
            expect.objectContaining({ with: { name: "order.fulfilled", data: "{{event.data}}" } }),
          ),
        "publication is authorized": (output) =>
          expect(permission(output, "events.emit")).toBe("auto"),
      },
    },
    "entity-created-event": {
      input: {
        message:
          "Listen specifically for entity.created events about employee records. Publish onboarding.started with the creation event's payload. Allow this publication automatically; don't start this on updates or by hand.",
      },
      checks: {
        ...drafts,
        "uses a creation-only event trigger": (output) =>
          expect(output.workflow?.trigger).toMatchObject({
            kind: "event",
            event: "entity.created",
            subject: "employee",
          }),
        "emits the handoff": (output) =>
          expect(actions(output, "events.emit")).toContainEqual(
            expect.objectContaining({
              with: expect.objectContaining({ name: "onboarding.started" }),
            }),
          ),
      },
    },
    "slack-mention": {
      input: {
        message:
          "When someone asks our bot for help in Slack, have an agent summarize what they asked and email the summary to ops@example.com. Send it without asking anyone.",
      },
      checks: {
        ...drafts,
        "starts from a Slack mention": (output) =>
          expect(output.workflow?.trigger).toMatchObject({ kind: "event", event: "slack.mention" }),
        "reads what they wrote": (output) =>
          expect(JSON.stringify(steps(output))).toContain("event.data.text"),
        "sends the email": (output) => expect(actions(output, "email.send")).toHaveLength(1),
      },
    },
    onboarding: {
      input: {
        message:
          "When a new employee is added, email them a welcome on their start date and give their manager a heads-up on Slack a few days before.",
      },
      checks: {
        ...drafts,
        "starts from employees": (output) =>
          expect(output.workflow?.trigger).toMatchObject({ entity: "employee" }),
        "welcomes with the general template": (output) =>
          expect(templates(output, "email.send")).toContain("welcome_general"),
        "gives the heads-up with its template": (output) =>
          expect(templates(output, "slack.sendMessage")).toContain("manager_heads_up"),
        "People Ops approves the email": (output) =>
          expect(permission(output, "email.send")).toEqual({ ask: "people_ops" }),
        "People Ops approves the Slack message": (output) =>
          expect(permission(output, "slack.sendMessage")).toEqual({ ask: "people_ops" }),
        ...fulfills(
          "The workflow emails each new employee a welcome on their start date, and messages their manager on Slack a few days before that date.",
        ),
      },
    },
    "welcome-by-role": {
      input: {
        message:
          "When someone new joins, email them the right welcome on their start date: engineers get the engineering welcome, everyone else the general one.",
      },
      checks: {
        ...drafts,
        "one email action matches on who the hire is": (output) => {
          expect(actions(output, "email.send")).toHaveLength(1);
          expect(actions(output, "email.send")[0]?.match).toBeDefined();
        },
        "uses both welcome templates": (output) =>
          expect(templates(output, "email.send")).toEqual(
            expect.arrayContaining(["welcome_engineer", "welcome_general"]),
          ),
      },
    },
    "weekly-schedule": {
      input: {
        message:
          "Every Monday at 9am London time, post a reminder in #team on Slack to update the roadmap.",
      },
      checks: {
        ...drafts,
        "runs at 9:00 every Monday in London": (output) =>
          expect(output.workflow?.trigger).toEqual({
            kind: "schedule",
            cron: expect.stringMatching(/^0 9 \* \* (1|MON|mon)$/),
            timezone: "Europe/London",
          }),
        "posts in #team": (output) =>
          expect(actions(output, "slack.sendMessage")).toContainEqual(
            expect.objectContaining({ with: expect.objectContaining({ to: "#team" }) }),
          ),
      },
    },
    "contract-renewal": {
      input: {
        message:
          "A week before a contract ends, ask its owner whether we should renew it. If they say yes, send them the renewal reminder email; if not, let legal know in #legal on Slack.",
      },
      checks: {
        ...drafts,
        "starts a week before the contract ends": (output) =>
          expect(output.workflow?.trigger).toMatchObject({
            kind: "date",
            entity: "contract",
            on: "contract.ends_on",
            offset: expect.stringMatching(/^-(1 week|7 days)$/),
          }),
        "asks the owner": (output) =>
          expect(humans(output)).toContainEqual(
            expect.objectContaining({ assignee: "contract.owner" }),
          ),
        "branches on the owner's answer": (output) => {
          const answers = humans(output).map((step) => `steps.${step.id}`);
          const branchesOn = steps(output).flatMap((step) =>
            step.kind === "if" ? step.cases.flatMap((branch) => conditionRefs(branch.when)) : [],
          );
          expect(branchesOn.some((ref) => answers.some((answer) => ref.startsWith(answer)))).toBe(
            true,
          );
        },
        "emails the renewal reminder": (output) =>
          expect(templates(output, "email.send")).toContain("renewal_reminder"),
        "tells legal on Slack": (output) =>
          expect(actions(output, "slack.sendMessage")).not.toHaveLength(0),
      },
    },
    "asks-for-url": {
      input: {
        message: "When a new employee is added, send their details to our HR system's webhook.",
      },
      checks: {
        "doesn't invent a webhook": (output) =>
          expect(actions(output, "http.post")).toHaveLength(0),
        "asks for the URL": judged(
          "The assistant asks the person for the web address (URL) of the HR system's webhook, in a question or in its reply.",
          said,
        ),
      },
    },
    "asks-for-time-zone": {
      input: {
        message: "Every weekday at 8am, post a reminder in #standup to share your updates.",
      },
      checks: {
        "asks for the time zone": judged(
          "The assistant asks the person which time zone 8am is in, in a question or in its reply, or says which time zone it assumed and invites them to change it.",
          said,
        ),
      },
    },
    "keeps-permissions": {
      input: { draft: welcomeDraft, message: "Also give their manager a heads-up on Slack." },
      checks: {
        ...drafts,
        "keeps the welcome": (output) => expect(stepIds(output)).toContain("welcome"),
        "keeps the email running on its own": (output) =>
          expect(permission(output, "email.send")).toBe("auto"),
        "messages the manager": (output) =>
          expect(JSON.stringify(actions(output, "slack.sendMessage"))).toContain(
            "employee.manager",
          ),
      },
    },
    "removes-a-step": {
      input: {
        draft: headsUpDraft,
        message: "We don't need the Slack heads-up anymore, take it out.",
      },
      checks: {
        ...drafts,
        "removes the Slack message": (output) =>
          expect(actions(output, "slack.sendMessage")).toHaveLength(0),
        "keeps the rest": (output) =>
          expect(stepIds(output)).toEqual(expect.arrayContaining(["start", "welcome"])),
      },
    },
    "no-roles": {
      input: {
        catalog: catalogWithoutRoles,
        message:
          "When a new employee is added, email them the general welcome on their start date.",
      },
      checks: {
        ...drafts,
        "sends the email on its own": (output) =>
          expect(permission(output, "email.send")).toBe("auto"),
        "explains there's no approval": judged(
          "The reply tells the person the email will go out without anyone approving it, or suggests adding a role so someone can approve it first.",
          (output) => output.reply,
        ),
      },
    },
    "intro-meeting": {
      input: {
        message:
          "When someone joins, have their manager book a 30-minute intro with them in their first week. Suggest a time so the manager just has to confirm.",
      },
      checks: {
        ...drafts,
        "asks the manager, and tells them": (output) =>
          expect(humans(output)).toContainEqual(
            expect.objectContaining({ assignee: "employee.manager", notify: expect.any(String) }),
          ),
        "proposes a time the manager can keep": (output) =>
          expect(JSON.stringify(humans(output).map((step) => step.response))).toMatch(
            /"default":"[^"]*\{\{steps\./,
          ),
        "finds and books a time": (output) => {
          expect(actions(output, "calendar.findTimes")).not.toHaveLength(0);
          expect(actions(output, "calendar.createEvent")).not.toHaveLength(0);
        },
        "finds times on its own": (output) =>
          expect(permission(output, "calendar.findTimes")).toBe("auto"),
      },
    },
    "just-a-question": {
      input: {
        draft: headsUpDraft,
        message: "What happens if the start date changes after the heads-up went out?",
      },
      checks: {
        "leaves the draft as it is": (output) => expect(output.workflow).toBeUndefined(),
        "answers the question": judged(
          "The reply answers what happens when the start date changes after the heads-up was sent, given the workflow. It may offer to change the workflow but doesn't claim to have changed it.",
          exchange,
        ),
      },
    },
  },
});
