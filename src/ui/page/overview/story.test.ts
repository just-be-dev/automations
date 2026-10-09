/** Checks overview polling and stale replies, manual launches, and readable trigger descriptions. */
import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { onboarding, runOf, summaryOf } from "../../fixtures.ts";
import { EventInput } from "../../domain/index.ts";
import {
  LoadOverview,
  LoadSubjects,
  Message,
  OutMessage,
  PollOverview,
  StartRun,
  init,
  triggerSummary,
  update,
} from "./index.ts";

const ordersRow = {
  id: "orders",
  name: "Order summary",
  maybeTrigger: Option.some({ kind: "manual" as const }),
  activeRuns: [],
  maybeNextRunAt: Option.none(),
  maybeLastRun: Option.none(),
  maybeError: Option.none(),
};

test("late subject loads preserve event data and cancelled forms ignore them", () => {
  const listing = update(
    init(0).model,
    Message.SucceededLoadOverview({
      session: 0,
      poll: 0,
      automations: [
        {
          ...ordersRow,
          maybeTrigger: Option.some({ kind: "event", event: "order.paid", subject: "employee" }),
        },
      ],
    }),
  ).model;
  const choosing = update(listing, Message.ClickedRunNow({ automationId: "orders" })).model;
  const edited = update(
    choosing,
    Message.GotEventInputMessage({ message: EventInput.Message.ClickedAdd({ id: 0 }) }),
  ).model;
  const loaded = update(
    edited,
    Message.SucceededLoadSubjects({
      automationId: "orders",
      entityType: "employee",
      label: "Employee",
      subjects: [{ id: "emp-2", title: "Ari" }],
    }),
  ).model;
  expect(loaded.launch).toMatchObject({
    _tag: "Choosing",
    maybeEventInput: Option.some(
      EventInput.update(
        EventInput.initial({ kind: "event", event: "order.paid" }),
        EventInput.Message.ClickedAdd({ id: 0 }),
      ),
    ),
  });
  const failed = update(
    edited,
    Message.FailedLoadSubjects({
      automationId: "orders",
      entityType: "employee",
      error: "Offline",
    }),
  ).model;
  expect(failed.launch).toMatchObject({
    _tag: "Choosing",
    maybeEventInput: Option.some(
      EventInput.update(
        EventInput.initial({ kind: "event", event: "order.paid" }),
        EventInput.Message.ClickedAdd({ id: 0 }),
      ),
    ),
    subjects: { _tag: "Unavailable" },
  });
  const cancelled = update(edited, Message.ClickedCancelStart()).model;
  expect(
    update(
      edited,
      Message.SucceededLoadEventInput({
        automationId: "orders",
        editor: EventInput.initial({ kind: "event", event: "other" }),
      }),
    ).model,
  ).toEqual(edited);
  expect(
    update(
      cancelled,
      Message.SucceededLoadEventInput({
        automationId: "orders",
        editor: EventInput.initial({ kind: "event", event: "other" }),
      }),
    ).model,
  ).toEqual(cancelled);
  expect(
    update(
      cancelled,
      Message.SucceededLoadSubjects({
        automationId: "orders",
        entityType: "employee",
        label: "Employee",
        subjects: [],
      }),
    ).model,
  ).toBe(cancelled);
});

const onboardingRow = {
  id: "onboarding",
  name: "Manager onboarding",
  maybeTrigger: Option.some(onboarding.trigger),
  activeRuns: [summaryOf(runOf({ status: "waiting" }))],
  maybeNextRunAt: Option.none(),
  maybeLastRun: Option.some(summaryOf(runOf({ status: "waiting" }))),
  maybeError: Option.none(),
};

const loaded = (automations: ReadonlyArray<typeof ordersRow | typeof onboardingRow>) =>
  update(init(3).model, Message.SucceededLoadOverview({ session: 3, poll: 0, automations })).model;

test("the overview polls while any run is in flight and stops once none is", () => {
  expect(init(3).commands?.map((command) => [command.name, command.args])).toEqual([
    ["LoadOverview", { session: 3, poll: 0 }],
  ]);
  story(
    update,
    given(init(3).model),
    message(Message.SucceededLoadOverview({ session: 3, poll: 0, automations: [onboardingRow] })),
    Command.expectExact(PollOverview({ session: 3, poll: 0, delayMillis: 5000 })),
    Command.resolve(
      PollOverview,
      Message.SucceededLoadOverview({
        session: 3,
        poll: 0,
        automations: [{ ...onboardingRow, activeRuns: [] }],
      }),
    ),
    Command.expectNone(),
    model((current) => expect(current.listing._tag).toBe("Ready")),
  );
});

test("replies from an earlier overview or an older poll are dropped", () => {
  const current = loaded([ordersRow]);
  const earlier = update(
    current,
    Message.SucceededLoadOverview({ session: 2, poll: 0, automations: [onboardingRow] }),
  );
  expect(earlier.model).toBe(current);
  expect(earlier.commands).toBeUndefined();
  const failed = update(
    current,
    Message.FailedLoadOverview({ session: 3, poll: 0, error: "Offline" }),
  );
  expect(failed.model.listing._tag).toBe("Ready");
  expect(failed.commands?.map((command) => command.name)).toEqual(["PollOverview"]);
});

test("an automation without a subject starts at once and the overview reloads", () => {
  story(
    update,
    given(loaded([ordersRow])),
    message(Message.ClickedRunNow({ automationId: "orders" })),
    Command.expectExact(StartRun({ automationId: "orders", maybeSubjectId: Option.none() })),
    model((current) => {
      expect(current.launch._tag).toBe("Starting");
      const again = update(current, Message.ClickedRunNow({ automationId: "orders" }));
      expect(again.model).toBe(current);
      expect(again.commands).toBeUndefined();
    }),
    Command.resolve(
      StartRun,
      Message.SucceededStartRun({ automationId: "orders", runId: "run-7" }),
    ),
    Command.expectExact(LoadOverview({ session: 3, poll: 1 })),
    model((current) =>
      expect(current.launch).toEqual({ _tag: "Started", automationId: "orders", runId: "run-7" }),
    ),
    Command.resolve(
      LoadOverview,
      Message.SucceededLoadOverview({ session: 3, poll: 1, automations: [ordersRow] }),
    ),
  );
});

test("an automation about an employee asks which one, then starts for the one picked", () => {
  story(
    update,
    given(loaded([onboardingRow])),
    message(Message.ClickedRunNow({ automationId: "onboarding" })),
    Command.expectExact(LoadSubjects({ automationId: "onboarding", entityType: "employee" })),
    Command.resolve(
      LoadSubjects,
      Message.SucceededLoadSubjects({
        automationId: "onboarding",
        entityType: "employee",
        label: "Employee",
        subjects: [{ id: "emp-2", title: "Ari Cho" }],
      }),
    ),
    message(Message.ClickedStart()),
    Command.expectNone(),
    message(Message.SelectedSubject({ subjectId: "emp-2" })),
    message(Message.ClickedStart()),
    Command.expectExact(
      StartRun({ automationId: "onboarding", maybeSubjectId: Option.some("emp-2") }),
    ),
    Command.resolve(
      StartRun,
      Message.FailedStartRun({ automationId: "onboarding", error: "No employee emp-2" }),
    ),
    model((current) =>
      expect(current.launch).toEqual({
        _tag: "Failed",
        automationId: "onboarding",
        error: "No employee emp-2",
      }),
    ),
  );
});

test("an unsaved automation can't be started", () => {
  const unsaved = loaded([{ ...ordersRow, maybeTrigger: Option.none() }]);
  const clicked = update(unsaved, Message.ClickedRunNow({ automationId: "orders" }));
  expect(clicked.model).toBe(unsaved);
  expect(clicked.commands).toBeUndefined();
});

test("triggers read as a plain phrase", () => {
  expect(triggerSummary({ kind: "manual" })).toBe("Started by hand");
  expect(triggerSummary({ kind: "manual", subject: "employee" })).toBe(
    "Started by hand for an employee",
  );
  expect(
    triggerSummary({
      kind: "entity",
      entity: "employee",
      fields: ["start_date", "manager"],
      when: { ref: "employee.start_date", op: "exists" },
    }),
  ).toBe(
    "When an employee is created or its start_date or manager changes, if its condition holds",
  );
  expect(triggerSummary({ kind: "schedule", cron: "0 9 * * 1-5" })).toBe(
    "Every weekday at 9:00 (UTC)",
  );
  expect(
    triggerSummary({
      kind: "schedule",
      cron: "0 9 * * 1",
      timezone: "Europe/London",
      entity: "employee",
      when: { ref: "employee.start_date", op: "after", value: "now" },
    }),
  ).toBe("Every Monday at 9:00 (Europe/London), for each employee that meets its condition");
  expect(
    triggerSummary({
      kind: "date",
      entity: "employee",
      on: "employee.start_date",
      offset: "3 days",
      timezone: "Europe/London",
    }),
  ).toBe("3 days after each employee's start_date at 9:00 (Europe/London)");
});

test("New automation asks the parent to open the new automation dialog", () => {
  const clicked = update(loaded([]), Message.ClickedNewAutomation());
  expect(clicked.model).toEqual(loaded([]));
  expect(clicked.commands).toBeUndefined();
  expect(clicked.outMessage).toEqual(OutMessage.RequestedNewAutomation());
});
