/** Says, in a few plain words, where each step of a run stands: its mark and a short summary. */
import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { labelFromName, plural } from "@/lib/format";
import type { ActionStep, HumanTask, Run, Step } from "../../workflow.ts";

/** How a step's row is marked. `pending` has not been reached; `interrupted` never finished. */
export type StepMark =
  | "done"
  | "running"
  | "waiting"
  | "declined"
  | "skipped"
  | "failed"
  | "interrupted"
  | "pending";

export interface StepProgress {
  readonly mark: StepMark;
  readonly maybeSummary: Option.Option<string>;
}

export const stepMarkLabel: Record<StepMark, string> = {
  done: "Done",
  running: "Running",
  waiting: "Waiting",
  declined: "Declined",
  skipped: "Skipped",
  failed: "Failed",
  interrupted: "Didn't finish",
  pending: "Not started",
};

type JsonObject = { readonly [key: string]: Schema.Json };

const isJsonObject = (value: Schema.Json | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const field = (record: Schema.Json | undefined, name: string): Schema.Json | undefined =>
  isJsonObject(record) ? record[name] : undefined;

const textField = (record: Schema.Json | undefined, name: string) =>
  Option.filter(Option.fromNullishOr(field(record, name)), Predicate.isString);

const firstWord = (text: string) => text.trim().split(/\s+/)[0] ?? text;

/** A person's first name from an address: `grace.hopper@example.com` reads "Grace". */
const nameFromEmail = (email: string) => {
  const local = email.split("@")[0] ?? email;
  const first = local.split(/[._+-]/)[0] ?? local;
  return first === "" ? email : `${first.charAt(0).toUpperCase()}${first.slice(1)}`;
};

/** Who a message went to, by first name: from `Name <address>`, an address, or a channel. */
export const recipientName = (to: string) => {
  const named = /^\s*([^<]+?)\s*<[^>]+>\s*$/.exec(to);
  if (named?.[1] !== undefined) {
    return firstWord(named[1]);
  }
  const address = to.startsWith("@") ? to.slice(1) : to;
  return address.includes("@") ? nameFromEmail(address) : address;
};

/** A person as a task names them: an entity's `$title`, or text. */
const personName = (person: Schema.Json | null) =>
  Predicate.isString(person)
    ? Option.some(recipientName(person))
    : Option.map(textField(person ?? undefined, "$title"), firstWord);

const dayMillis = 86_400_000;

const isUtcMidnight = (millis: number) => millis % dayMillis === 0;

/**
 * A day and time as people read it: `Mon, Nov 2 at 10:00 AM`. The day and time are joined here,
 * because ICU builds join them differently.
 */
export const dayTimeText = (millis: number) => {
  const date = new Date(millis);
  const day = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
};

/** A date-only moment (midnight UTC, as dates are stored) reads as its day; others with the time. */
export const resumeText = (millis: number) =>
  isUtcMidnight(millis)
    ? new Date(millis).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : dayTimeText(millis);

const actionTarget = (step: ActionStep) => {
  const to = step.with["to"];
  return Predicate.isString(to) ? Option.some(to) : Option.none<string>();
};

const isReadableTarget = (name: string) => name.startsWith("#") || name.startsWith("@");

/** A live post records Slack's channel ID, so a literal `#channel` input names it instead. */
const slackSummary = (step: ActionStep, record: Schema.Json | undefined) =>
  Option.match(
    Option.orElse(Option.filter(textField(record, "channel"), isReadableTarget), () =>
      Option.filter(actionTarget(step), isReadableTarget),
    ),
    {
      onNone: () => "Sent",
      onSome: (name) =>
        name.startsWith("#")
          ? step.title.includes(name)
            ? "Posted"
            : `Posted in ${name}`
          : `Sent to ${recipientName(name)}`,
    },
  );

const actionSummary = (step: ActionStep, record: Schema.Json | undefined): string =>
  Match.value(step.use).pipe(
    Match.when("email.send", () =>
      Option.match(textField(record, "to"), {
        onNone: () => "Sent",
        onSome: (to) => `Sent to ${recipientName(to)}`,
      }),
    ),
    Match.when("slack.sendMessage", () => slackSummary(step, record)),
    Match.when("calendar.findTimes", () => {
      const times = field(record, "times");
      const count = Array.isArray(times) ? times.length : 0;
      return count === 0 ? "No open times" : plural(count, "open time", "open times");
    }),
    Match.when("calendar.createEvent", () =>
      Option.match(
        Option.filter(
          Option.map(textField(record, "start"), Date.parse),
          (millis) => !Number.isNaN(millis),
        ),
        { onNone: () => "Booked", onSome: (millis) => `Booked ${dayTimeText(millis)}` },
      ),
    ),
    Match.when("http.post", () => "Delivered"),
    Match.when("events.emit", () =>
      Option.match(textField(record, "name"), {
        onNone: () => "Event sent",
        onSome: (name) =>
          name === "entity.put" ? "Requested a record update" : `Sent the ${name} event`,
      }),
    ),
    Match.orElse(() => "Done"),
  );

const shortAnswerLength = 40;

const agentSummary = (record: Schema.Json | undefined) => {
  const output = isJsonObject(record) && "output" in record ? record["output"] : record;
  return Predicate.isString(output) &&
    output.trim() !== "" &&
    output.length <= shortAnswerLength &&
    !output.includes("\n")
    ? output.trim()
    : "Answered";
};

/**
 * Who answered a task, by first name: its assignee or a member of its role when the address is
 * theirs, since a person's address needn't spell their name. Otherwise read from the address.
 */
const responderName = (email: string, task: Option.Option<HumanTask>) => {
  const same = (other: string | undefined) => other?.toLowerCase() === email.toLowerCase();
  const known = Option.flatMap(task, (found) => {
    const assignee = found.assignee;
    if (same(Option.getOrUndefined(textField(assignee ?? undefined, "email")))) {
      return personName(assignee);
    }
    return Option.map(
      Option.fromNullishOr(found.approvers?.members.find((member) => same(member.email))),
      (member) => firstWord(member.name),
    );
  });
  return Option.getOrElse(known, () => recipientName(email));
};

const humanDoneSummary = (
  step: Extract<Step, { kind: "human" }>,
  record: Schema.Json | undefined,
  task: Option.Option<HumanTask>,
) => {
  const by = Option.match(textField(record, "respondedBy"), {
    onNone: () => "",
    onSome: (email) => ` by ${responderName(email, task)}`,
  });
  if (field(record, "timedOut") === true) {
    return step.response !== "approval" && isJsonObject(field(record, "values"))
      ? "Timed out, kept the defaults"
      : "Timed out";
  }
  const approved = field(record, "approved");
  if (step.response === "approval" || Predicate.isBoolean(approved)) {
    return approved === true ? `Approved${by}` : `Rejected${by}`;
  }
  return `Answered${by}`;
};

const ifSummary = (step: Extract<Step, { kind: "if" }>, record: Schema.Json | undefined) => {
  const matched = field(record, "matched");
  if (step.cases.length === 1) {
    return matched === 0 ? "Condition met" : "Condition not met";
  }
  return Predicate.isNumber(matched)
    ? `Case ${matched + 1} matched`
    : step.otherwise === undefined
      ? "No case matched"
      : "Otherwise";
};

const doneSummary = (
  step: Step,
  record: Schema.Json | undefined,
  task: Option.Option<HumanTask>,
): Option.Option<string> =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      action: (action) => Option.some(actionSummary(action, record)),
      agent: () => Option.some(agentSummary(record)),
      decide: () =>
        Option.map(textField(record, "choice"), (choice) => `Chose “${labelFromName(choice)}”`),
      if: (branch) => Option.some(ifSummary(branch, record)),
      human: (human) => Option.some(humanDoneSummary(human, record, task)),
      wait: (wait) =>
        Option.some(
          "until" in wait
            ? `Waited until ${labelFromName(wait.until.split(".").at(-1) ?? wait.until).toLowerCase()}`
            : `Waited ${wait.duration}`,
        ),
      parallel: () => Option.none(),
      stop: () => Option.some("Ended the run"),
    }),
  );

const openTaskOf = (run: Run, step: Step) =>
  Array.findFirst(run.tasks, (task) => task.step === step.id && task.status === "open");

const lastTaskOf = (run: Run, step: Step) =>
  Array.findLast(run.tasks, (task) => task.step === step.id);

const waitingOnTask = (task: HumanTask) =>
  task.approvers !== undefined
    ? `Waiting for ${task.approvers.label}`
    : Option.match(personName(task.assignee), {
        onNone: () =>
          task.response === "approval" ? "Waiting for approval" : "Waiting for an answer",
        onSome: (name) => `Waiting for ${name}`,
      });

const waitingSummary = (step: Step, run: Run, resumesAt: Readonly<Record<string, number>>) =>
  Option.match(openTaskOf(run, step), {
    onSome: waitingOnTask,
    onNone: () =>
      Option.match(Option.fromNullishOr(resumesAt[step.id]), {
        onNone: () => "Waiting",
        onSome: (at) => `Resumes ${resumeText(at)}`,
      }),
  });

/** A step whose own steps carry the news, such as a parallel step waiting on one branch. */
const hasLanes = (step: Step) =>
  step.kind === "parallel" || step.kind === "if" || step.kind === "decide";

const isActive = (run: Run) => run.status === "running" || run.status === "waiting";

const progress = (mark: StepMark, summary?: string): StepProgress => ({
  mark,
  maybeSummary: Option.fromNullishOr(summary),
});

/**
 * Where one step of the run stands, from its run step, its task, and the run's status.
 * `resumesAt` says when each wait step waiting on a clock resumes, by step ID, as the engine
 * scheduled it (`GET /api/automations/:id/runs/:runId`).
 */
export const stepProgress = (
  step: Step,
  run: Run,
  resumesAt: Readonly<Record<string, number>>,
): StepProgress => {
  const runStep = run.steps[step.id];
  if (runStep === undefined) {
    return progress("pending");
  }
  return Match.value(runStep.status).pipe(
    Match.when("done", (): StepProgress => ({
      mark: "done",
      maybeSummary: doneSummary(step, runStep.record, lastTaskOf(run, step)),
    })),
    Match.when("skipped", () => progress("skipped", "Skipped")),
    Match.when("declined", () =>
      Option.match(
        Option.flatMap(lastTaskOf(run, step), (task) => Option.fromNullishOr(task.approvers)),
        {
          onNone: () => progress("declined", "Declined"),
          onSome: (approvers) => progress("declined", `Declined by ${approvers.label}`),
        },
      ),
    ),
    Match.when("running", () =>
      isActive(run)
        ? progress("running", hasLanes(step) ? undefined : "Running…")
        : run.status === "failed"
          ? progress("failed", "Failed")
          : progress("interrupted", "Didn't finish"),
    ),
    Match.when("waiting", () =>
      isActive(run)
        ? progress("waiting", waitingSummary(step, run, resumesAt))
        : progress("interrupted", "Didn't finish"),
    ),
    Match.exhaustive,
  );
};

/**
 * Which of a branching step's lanes to list: once an `if` or `decide` has chosen, only the lane
 * it took; before then, or for `parallel`, every lane.
 */
export const shownLaneIndexes = (
  step: Step,
  run: Run,
  laneCount: number,
): ReadonlyArray<number> => {
  const all = Array.range(0, laneCount - 1);
  const runStep = run.steps[step.id];
  if (laneCount === 0) {
    return [];
  }
  if (runStep === undefined || runStep.status !== "done") {
    return all;
  }
  return Match.value(step).pipe(
    Match.discriminators("kind")({
      if: (branch) => {
        const matched = field(runStep.record, "matched");
        return Predicate.isNumber(matched)
          ? [matched]
          : branch.otherwise === undefined || Array.isReadonlyArrayEmpty(branch.otherwise)
            ? []
            : [branch.cases.length];
      },
      decide: (decide) =>
        Option.match(
          Option.flatMap(textField(runStep.record, "choice"), (choice) =>
            Array.findFirstIndex(decide.options, (option) => option.id === choice),
          ),
          { onNone: () => all, onSome: (index) => [index] },
        ),
    }),
    Match.orElse(() => all),
  );
};
