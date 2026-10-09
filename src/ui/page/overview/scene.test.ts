/** Exercises the overview's run listings, subject picker, launch feedback, and empty state. */
import { test } from "bun:test";
import * as Option from "effect/Option";
import {
  Command,
  change,
  click,
  expect,
  given,
  label,
  role,
  scene,
  text,
  type,
} from "foldkit/scene";
import { onboarding, runOf, summaryOf } from "../../fixtures.ts";
import {
  LoadEventInput,
  LoadOverview,
  LoadSubjects,
  Message,
  PollOverview,
  StartRun,
  init,
  update,
  view,
} from "./index.ts";

const waiting = summaryOf(runOf({ status: "waiting", tasks: [] }));

const overview = update(
  init(0).model,
  Message.SucceededLoadOverview({
    session: 0,
    poll: 0,
    automations: [
      {
        id: "onboarding",
        name: "Manager onboarding",
        maybeTrigger: Option.some(onboarding.trigger),
        activeRuns: [{ ...waiting, openTasks: 1 }],
        maybeNextRunAt: Option.none(),
        maybeLastRun: Option.some(waiting),
        maybeError: Option.none(),
      },
      {
        id: "start-dates",
        name: "Start date reminders",
        maybeTrigger: Option.some({
          kind: "entity" as const,
          entity: "employee",
          fields: ["start_date"],
        }),
        activeRuns: [],
        maybeNextRunAt: Option.none(),
        maybeLastRun: Option.none(),
        maybeError: Option.none(),
      },
      {
        id: "orders",
        name: "Order summary",
        maybeTrigger: Option.none(),
        activeRuns: [],
        maybeNextRunAt: Option.none(),
        maybeLastRun: Option.none(),
        maybeError: Option.none(),
      },
    ],
  }),
).model;

test("the overview lists what's in flight and every automation with how it starts", () => {
  scene(
    { update, view },
    given(overview),
    expect(role("list", { name: "Running now" })).toContainText("Ari Cho"),
    expect(role("list", { name: "Running now" })).toContainText("1 open task"),
    expect(role("link", { name: /Ari Cho/ })).toHaveAttr(
      "href",
      "/?automation=onboarding&run=run-1",
    ),
    expect(role("link", { name: "Manager onboarding" })).toHaveAttr(
      "href",
      "/?automation=onboarding",
    ),
    expect(text("Started by hand for an employee")).toExist(),
    expect(text("When an employee is created or its start_date changes")).toExist(),
    expect(text("Not saved yet. Save it in the studio to run it.")).toExist(),
    expect(role("button", { name: "Run Manager onboarding" })).toExist(),
    expect(role("button", { name: "Run Start date reminders" })).toExist(),
    expect(role("button", { name: "Run Order summary" })).not.toExist(),
  );
});

test("starting a run by hand picks its employee and links to the new run", () => {
  scene(
    { update, view },
    given(overview),
    click(role("button", { name: "Run Manager onboarding" })),
    Command.expectExact(LoadSubjects({ automationId: "onboarding", entityType: "employee" })),
    expect(text("Loading employee records…")).toExist(),
    Command.resolve(
      LoadSubjects,
      Message.SucceededLoadSubjects({
        automationId: "onboarding",
        entityType: "employee",
        label: "Employee",
        subjects: [
          { id: "emp-1", title: "Dana Lee" },
          { id: "emp-2", title: "Ari Cho" },
        ],
      }),
    ),
    expect(role("button", { name: "Start run" })).toHaveAttr("aria-disabled", "true"),
    change(label("Employee"), "emp-1"),
    click(role("button", { name: "Start run" })),
    Command.expectExact(
      StartRun({ automationId: "onboarding", maybeSubjectId: Option.some("emp-1") }),
    ),
    expect(text("Starting a run…")).toExist(),
    Command.resolve(
      StartRun,
      Message.SucceededStartRun({ automationId: "onboarding", runId: "run-2" }),
    ),
    expect(text("Run started.")).toExist(),
    expect(role("link", { name: "Open run" })).toHaveAttr(
      "href",
      "/?automation=onboarding&run=run-2",
    ),
    Command.resolve(
      LoadOverview,
      Message.FailedLoadOverview({ session: 0, poll: 1, error: "Offline" }),
    ),
    Command.resolve(
      PollOverview,
      Message.FailedLoadOverview({ session: 0, poll: 0, error: "Offline" }),
    ),
  );
});

test("an empty overview offers only a way to make an automation", () => {
  scene(
    { update, view },
    given(
      update(init(0).model, Message.SucceededLoadOverview({ session: 0, poll: 0, automations: [] }))
        .model,
    ),
    expect(text("No automations yet")).toExist(),
    expect(role("button", { name: "New automation" })).toExist(),
    expect(text("Nothing is running right now.")).not.toExist(),
    expect(role("heading", { name: "Automations" })).not.toExist(),
  );
});

test("event automations collect payload and subject, preserving input across loads and failures", () => {
  scene(
    { update, view },
    given(
      update(
        init(0).model,
        Message.SucceededLoadOverview({
          session: 0,
          poll: 0,
          automations: [
            {
              id: "paid-orders",
              name: "Paid orders",
              maybeTrigger: Option.some({
                kind: "event",
                event: "order.paid",
                subject: "employee",
                when: { ref: "event.data.total", op: "greaterThan", value: 100 },
              }),
              activeRuns: [],
              maybeNextRunAt: Option.none(),
              maybeLastRun: Option.none(),
              maybeError: Option.none(),
            },
          ],
        }),
      ).model,
    ),
    expect(text("When order.paid occurs for an employee, if its condition holds")).toExist(),
    click(role("button", { name: "Run Paid orders" })),
    Command.resolve(
      LoadEventInput,
      Message.FailedLoadEventInput({ automationId: "paid-orders", error: "Offline" }),
    ),
    Command.resolve(
      LoadSubjects,
      Message.SucceededLoadSubjects({
        automationId: "paid-orders",
        entityType: "employee",
        label: "Employee",
        subjects: [{ id: "emp-2", title: "Ari Cho" }],
      }),
    ),
    type(label("Total"), "137"),
    expect(label("Total")).toHaveValue("137"),
    expect(role("button", { name: "Start run" })).toHaveAttr("aria-disabled", "true"),
    change(label("Employee"), "emp-2"),
    click(role("button", { name: "Start run" })),
    Command.expectExact(
      StartRun({
        automationId: "paid-orders",
        maybeSubjectId: Option.some("emp-2"),
        event: { data: { total: 137 } },
      }),
    ),
    Command.resolve(
      StartRun,
      Message.FailedStartRun({ automationId: "paid-orders", error: "Offline" }),
    ),
    expect(role("alert")).toHaveText("Offline"),
    expect(label("Total")).toHaveValue("137"),
    expect(label("Employee")).toHaveValue("emp-2"),
    click(role("button", { name: "Cancel" })),
    expect(label("Total")).not.toExist(),
  );
});

test("an event without a subject validates field names and supports an empty value visually", () => {
  scene(
    { update, view },
    given(
      update(
        init(0).model,
        Message.SucceededLoadOverview({
          session: 0,
          poll: 0,
          automations: [
            {
              id: "ping",
              name: "Ping",
              maybeTrigger: Option.some({ kind: "event", event: "ping.received" }),
              activeRuns: [],
              maybeNextRunAt: Option.none(),
              maybeLastRun: Option.none(),
              maybeError: Option.none(),
            },
          ],
        }),
      ).model,
    ),
    click(role("button", { name: "Run Ping" })),
    Command.resolve(
      LoadEventInput,
      Message.FailedLoadEventInput({ automationId: "ping", error: "Offline" }),
    ),
    click(role("button", { name: "Add field to Event data" })),
    click(role("button", { name: "Start run" })),
    expect(role("alert")).toHaveText("Give each field in Event data a different name"),
    Command.expectNone(),
    change(label("Event data type"), "null"),
    click(role("button", { name: "Start run" })),
    Command.expectExact(
      StartRun({ automationId: "ping", maybeSubjectId: Option.none(), event: { data: null } }),
    ),
    Command.resolve(StartRun, Message.FailedStartRun({ automationId: "ping", error: "Offline" })),
  );
});
