import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { onboarding, runOf, summaryOf } from "../../fixtures.ts";
import {
  LoadOverview,
  LoadSubjects,
  Message,
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
  maybeLastRun: Option.none(),
  maybeError: Option.none(),
};

const onboardingRow = {
  id: "onboarding",
  name: "Manager onboarding",
  maybeTrigger: Option.some(onboarding.trigger),
  activeRuns: [summaryOf(runOf({ status: "waiting" }))],
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
});
