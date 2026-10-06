/** Validates cron schedules, finds timezone-aware occurrences, and describes schedule and date triggers in words. */
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";

/** Runs a schedule starts can't come closer together than this. */
export const MIN_SCHEDULE_GAP_MINUTES = 15;

/**
 * The most runs one occurrence may start, one per matching entity. An occurrence that matches
 * more starts none, and says so.
 */
export const MAX_SCHEDULED_RUNS = 50;

/** Why an occurrence that matches too many entities starts no runs. */
export const tooManyRuns = (count: number) =>
  `${count} entities are due at once, but one occurrence can start at most ${MAX_SCHEDULED_RUNS} runs. Narrow the trigger's condition so fewer match.`;

/** Date triggers without a time check at 9:00. */
export const DEFAULT_TIME = "09:00";

/** Schedules without a time zone run in UTC. */
export const DEFAULT_TIMEZONE = "UTC";

export interface Schedule {
  readonly cron: string;
  readonly timezone?: string;
}

const parse = (schedule: Schedule) =>
  Cron.parse(schedule.cron, schedule.timezone ?? DEFAULT_TIMEZONE);

/** Whether a time zone is one the runtime knows by its IANA name, such as `Europe/London`. */
export const isTimeZone = (name: string) => Result.isSuccess(Cron.parse("0 0 * * *", name));

const sorted = (values: ReadonlySet<number>) => [...values].toSorted((a, b) => a - b);

/** Every value a field allows: an empty set allows them all. */
const allowed = (values: ReadonlySet<number>, size: number) =>
  values.size === 0 ? Array.from({ length: size }, (_, index) => index) : sorted(values);

/**
 * The shortest time, in minutes, between two occurrences. It assumes consecutive hours can both
 * occur, so it may be shorter than the real gap, never longer.
 */
const shortestGap = (cron: Cron.Cron) => {
  const minutes = allowed(cron.minutes, 60);
  const hours = new Set(allowed(cron.hours, 24));
  const between = minutes.slice(1).map((minute, index) => minute - (minutes[index] ?? 0));
  const first = minutes[0] ?? 0;
  const last = minutes.at(-1) ?? 0;
  const nextHour = [...hours].some((hour) => hours.has((hour + 1) % 24));
  return Math.min(...between, ...(nextHour ? [first + 60 - last] : []), 24 * 60);
};

/** What's wrong with a cron expression, or `undefined` when a schedule can use it. */
export const cronProblem = (cron: string): string | undefined => {
  if (cron.trim().split(/\s+/).length !== 5) {
    return 'A schedule is a cron expression with five fields: minute hour day-of-month month weekday, such as "0 9 * * 1-5"';
  }
  const parsed = Cron.parse(cron);
  if (Result.isFailure(parsed)) {
    return `"${cron}" isn't a cron expression: ${parsed.failure.message}`;
  }
  return shortestGap(parsed.success) < MIN_SCHEDULE_GAP_MINUTES
    ? `A schedule can run at most every ${MIN_SCHEDULE_GAP_MINUTES} minutes`
    : undefined;
};

/** The schedule that occurs every day at a 24-hour "HH:MM" time. */
export const dailyCron = (time: string) => {
  const [hour = "9", minute = "0"] = time.split(":");
  return `${Number(minute)} ${Number(hour)} * * *`;
};

/** The calendar day, `YYYY-MM-DD`, that an instant falls on in a time zone. */
export const localDate = (at: number, timezone = DEFAULT_TIMEZONE) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` day moved by whole days. */
export const shiftDate = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Whether a date, shifted by `days`, falls on the day of `at` in the time zone. A `YYYY-MM-DD`
 * value is that day; a datetime is the day it falls on in the time zone. Anything else is never
 * due.
 */
export const fallsOn = (value: unknown, days: number, at: number, timezone?: string) => {
  if (typeof value !== "string") {
    return false;
  }
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    return false;
  }
  const day = dateOnly.test(value) ? value : localDate(millis, timezone);
  return shiftDate(day, days) === localDate(at, timezone);
};

/** When the schedule next occurs strictly after `after`, in epoch milliseconds. */
export const nextOccurrence = (schedule: Schedule, after: number) =>
  Cron.next(Result.getOrThrow(parse(schedule)), new Date(after)).getTime();

/** Whether the schedule has an occurrence at `at`, to the minute. */
export const occursAt = (schedule: Schedule, at: number) =>
  Result.match(parse(schedule), {
    onFailure: () => false,
    onSuccess: (cron) => Cron.match(cron, new Date(at)),
  });

const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const listed = (items: ReadonlyArray<string>) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

const ordinal = (day: number) => {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  return `${day}${teen ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th")}`;
};

const clock = (hour: number, minute: number) => `${hour}:${String(minute).padStart(2, "0")}`;

/** The days a schedule runs on, or `undefined` when they don't read as a phrase. */
const daysPhrase = (cron: Cron.Cron): string | undefined => {
  if (cron.months.size > 0) {
    return undefined;
  }
  if (cron.days.size === 0 && cron.weekdays.size === 0) {
    return "Every day";
  }
  if (cron.days.size === 0) {
    // Weeks read Monday first, so Sunday (0) goes last.
    const weekdays = sorted(cron.weekdays).toSorted((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    if (weekdays.join() === "1,2,3,4,5") {
      return "Every weekday";
    }
    return `Every ${listed(weekdays.map((day) => weekdayNames[day] ?? String(day)))}`;
  }
  if (cron.weekdays.size === 0) {
    return `On the ${listed(sorted(cron.days).map(ordinal))} of every month`;
  }
  return undefined;
};

/** The times of day a schedule runs at, or `undefined` when they don't read as a phrase. */
const timesPhrase = (cron: Cron.Cron): string | undefined => {
  const minutes = sorted(cron.minutes);
  const hours = sorted(cron.hours);
  const [minute] = minutes;
  if (minutes.length === 1 && minute !== undefined) {
    if (hours.length === 0) {
      return `every hour at :${String(minute).padStart(2, "0")}`;
    }
    return hours.length <= 4 ? `at ${listed(hours.map((hour) => clock(hour, minute)))}` : undefined;
  }
  const step = minutes[1];
  const even =
    minute === 0 &&
    step !== undefined &&
    60 % step === 0 &&
    minutes.every((value, index) => value === index * step);
  return even && hours.length === 0 ? `every ${step} minutes` : undefined;
};

/** A schedule in words, e.g. "Every weekday at 9:00 (Europe/London)". */
export const describeSchedule = (schedule: Schedule) => {
  const zone = schedule.timezone ?? DEFAULT_TIMEZONE;
  const parsed = parse(schedule);
  const cron = Result.isSuccess(parsed) ? parsed.success : undefined;
  const days = cron === undefined ? undefined : daysPhrase(cron);
  const times = cron === undefined ? undefined : timesPhrase(cron);
  if (days === undefined || times === undefined) {
    return `On the schedule "${schedule.cron}" (${zone})`;
  }
  const when = days === "Every day" && times.startsWith("every") ? times : `${days} ${times}`;
  return `${when.charAt(0).toUpperCase()}${when.slice(1)} (${zone})`;
};

/** How a date trigger's offset reads before its date: "On ", "3 days after ", "1 week before ". */
export const offsetPhrase = (offset: string | undefined) => {
  const [, sign = "", count = "0", unit = "day"] =
    /^(-?)(\d+) (day|week)s?$/.exec(offset ?? "") ?? [];
  const amount = Number(count);
  return amount === 0
    ? "On "
    : `${amount} ${unit}${amount === 1 ? "" : "s"} ${sign === "-" ? "before" : "after"} `;
};

/** When a date trigger checks on the day, e.g. "at 9:00 (Europe/London)". */
export const checkTimePhrase = (time = DEFAULT_TIME, timezone = DEFAULT_TIMEZONE) => {
  const [hour = 9, minute = 0] = time.split(":").map(Number);
  return `at ${clock(hour, minute)} (${timezone})`;
};
