/** Checks timed-trigger validation, timezone-aware occurrences, date offsets, and readable schedule descriptions. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { decodeWorkflow, workflowRefs } from "./model.ts";
import {
  checkTimePhrase,
  cronProblem,
  dailyCron,
  describeSchedule,
  fallsOn,
  nextOccurrence,
  occursAt,
  offsetPhrase,
} from "./schedule.ts";

const decodeTrigger = (trigger: unknown) =>
  Effect.runSyncExit(
    decodeWorkflow({
      name: "Weekly",
      trigger,
      steps: [{ id: "a", title: "A", kind: "agent", instruction: "Do it" }],
    }),
  );

describe("cron expressions", () => {
  test("take five fields and run at most every 15 minutes", () => {
    expect(cronProblem("0 9 * * 1-5")).toBeUndefined();
    expect(cronProblem("*/15 * * * *")).toBeUndefined();
    expect(cronProblem("0,59 9 * * *")).toBeUndefined();
    expect(cronProblem("0 0 9 * * *")).toContain("five fields");
    expect(cronProblem("every monday")).toContain("five fields");
    expect(cronProblem("0 25 * * *")).toContain("isn't a cron expression");
    expect(cronProblem("* 9 * * *")).toBe("A schedule can run at most every 15 minutes");
    expect(cronProblem("*/5 * * * *")).toBe("A schedule can run at most every 15 minutes");
    // 9:55 is followed by 10:05 when consecutive hours both run.
    expect(cronProblem("5,55 9-10 * * *")).toBe("A schedule can run at most every 15 minutes");
  });

  test("occur in their time zone", () => {
    const weekly = { cron: "0 9 * * 1", timezone: "America/New_York" };
    const monday = Date.parse("2026-10-05T13:00:00Z");
    expect(nextOccurrence(weekly, monday - 1)).toBe(monday);
    expect(nextOccurrence(weekly, monday)).toBe(Date.parse("2026-10-12T13:00:00Z"));
    expect(occursAt(weekly, monday)).toBe(true);
    expect(occursAt({ cron: weekly.cron }, monday)).toBe(false);
    expect(nextOccurrence({ cron: weekly.cron }, monday)).toBe(Date.parse("2026-10-12T09:00:00Z"));
  });

  test("read as plain phrases where they can", () => {
    expect(describeSchedule({ cron: "0 9 * * 1-5", timezone: "Europe/London" })).toBe(
      "Every weekday at 9:00 (Europe/London)",
    );
    expect(describeSchedule({ cron: "30 17 * * 0,5" })).toBe(
      "Every Friday and Sunday at 17:30 (UTC)",
    );
    expect(describeSchedule({ cron: "0 8,12 * * *" })).toBe("Every day at 8:00 and 12:00 (UTC)");
    expect(describeSchedule({ cron: "15 * * * *" })).toBe("Every hour at :15 (UTC)");
    expect(describeSchedule({ cron: "*/30 * * * *" })).toBe("Every 30 minutes (UTC)");
    expect(describeSchedule({ cron: "0 6 1,15 * *" })).toBe(
      "On the 1st and 15th of every month at 6:00 (UTC)",
    );
    expect(describeSchedule({ cron: "0 9 * 1 *" })).toBe('On the schedule "0 9 * 1 *" (UTC)');
  });
});

describe("dates", () => {
  test("fall on a day in a time zone, shifted by whole days", () => {
    const londonMorning = Date.parse("2026-10-08T08:00:00Z");
    expect(fallsOn("2026-10-05", 3, londonMorning, "Europe/London")).toBe(true);
    expect(fallsOn("2026-10-05", 2, londonMorning, "Europe/London")).toBe(false);
    expect(fallsOn("2026-10-15", -7, londonMorning, "Europe/London")).toBe(true);
    // 23:30 UTC on the 5th is still the 5th in New York, but already the 6th in Tokyo.
    const late = "2026-10-05T23:30:00Z";
    expect(fallsOn(late, 0, Date.parse("2026-10-05T13:00:00Z"), "America/New_York")).toBe(true);
    expect(fallsOn(late, 0, Date.parse("2026-10-06T00:00:00Z"), "Asia/Tokyo")).toBe(true);
    expect(fallsOn(null, 0, londonMorning)).toBe(false);
    expect(fallsOn("soon", 0, londonMorning)).toBe(false);
  });

  test("read as plain phrases", () => {
    expect(dailyCron("09:30")).toBe("30 9 * * *");
    expect(offsetPhrase(undefined)).toBe("On ");
    expect(offsetPhrase("0 days")).toBe("On ");
    expect(offsetPhrase("3 days")).toBe("3 days after ");
    expect(offsetPhrase("-1 week")).toBe("1 week before ");
    expect(checkTimePhrase()).toBe("at 9:00 (UTC)");
    expect(checkTimePhrase("17:05", "Europe/London")).toBe("at 17:05 (Europe/London)");
  });

  test("date triggers decode with whole-day offsets and 24-hour times", () => {
    const trigger = { kind: "date", entity: "employee", on: "employee.start_date" };
    expect(Exit.isSuccess(decodeTrigger({ ...trigger, offset: "-2 weeks", time: "17:30" }))).toBe(
      true,
    );
    expect(String(decodeTrigger({ ...trigger, offset: "3 hours" }))).toContain("whole days");
    expect(String(decodeTrigger({ ...trigger, time: "9am" }))).toContain("24-hour");
  });
});

describe("schedule triggers", () => {
  test("decode with a valid cron expression and time zone", () => {
    expect(Exit.isSuccess(decodeTrigger({ kind: "schedule", cron: "0 9 * * 1" }))).toBe(true);
    expect(String(decodeTrigger({ kind: "schedule", cron: "*/5 * * * *" }))).toContain(
      "at most every 15 minutes",
    );
    expect(
      String(decodeTrigger({ kind: "schedule", cron: "0 9 * * 1", timezone: "Mars/Base" })),
    ).toContain("IANA names");
  });

  test("read refs through their condition", () => {
    const workflow = Effect.runSync(
      decodeWorkflow({
        name: "Upcoming starts",
        trigger: {
          kind: "schedule",
          cron: "0 9 * * 1",
          entity: "employee",
          when: { ref: "employee.start_date", op: "after", value: "now" },
        },
        steps: [{ id: "a", title: "A", kind: "agent", instruction: "Greet {{employee.name}}" }],
      }),
    );
    expect(workflowRefs(workflow)).toEqual(["employee.start_date", "employee.name"]);
  });
});
