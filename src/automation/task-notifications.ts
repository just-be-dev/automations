/** Sends a run's open tasks to the people who answer them as Slack DMs that link back to the studio. */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type {
  SlackBlock,
  SlackButton,
  SlackMessage,
  SlackSenderService,
} from "../connections/slack.ts";
import { approvalButtons } from "../channels/slack-approvals.ts";
import type { HumanTask, RunId, TaskNotification } from "../workflow/run.ts";
import type { StoredRun } from "./run-store.ts";
import { runUrl, type StudioLink } from "./studio-link.ts";

/**
 * A task reaches people in Slack when the deployment has a bot token: the members of the role an
 * ask-first action waits on, and a human step's assignee when the step says `notify: "slack"`.
 * Without a token nothing is sent, and the task only records `notify` as before. Email `notify`
 * stays recorded and unsent, because the email connection is simulated.
 *
 * Opening a task runs inside a journaled Activity, which a replay reruns until its exit is stored,
 * so a task can be "opened" more than once. Each recipient's delivery is recorded on the task:
 * `sending` before posting, then `sent` or `failed`. A recipient already `sent` or `failed` isn't
 * sent again. One left `sending` may have been posted before the record was written; Slack takes
 * no idempotency key, so the bot looks for the message's key in its DM with them and posts only
 * if it isn't there. Sending never fails the step: the task is answered in the studio either way.
 */

/** Someone a task is sent to. */
export interface TaskRecipient {
  readonly email: string;
  readonly name: string;
}

const fieldOf = (value: Schema.Json, name: string) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined;

/** A person value as a recipient: an entity with an `email` field, or an email address. */
const personOf = (value: Schema.Json): TaskRecipient | undefined => {
  const email = typeof value === "string" ? value : fieldOf(value, "email");
  const title = fieldOf(value, "$title");
  return typeof email === "string" && email.includes("@")
    ? { email, name: typeof title === "string" && title !== "" ? title : email }
    : undefined;
};

/**
 * Who a task is sent to: an approval's role members, as recorded when it opened, or a human
 * step's assignee when the step notifies on Slack. Each address appears once.
 */
export const taskRecipients = (task: HumanTask): ReadonlyArray<TaskRecipient> => {
  const people =
    task.approvers !== undefined
      ? task.approvers.members
      : task.notify === "slack" && task.assignee !== null
        ? [personOf(task.assignee)].filter((person) => person !== undefined)
        : [];
  const seen = new Set<string>();
  return people.filter((person) => {
    const key = person.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Slack reads `&`, `<` and `>` as markup, so text from the run escapes them. */
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** One line, cut to `limit` characters with an ellipsis. */
const excerpt = (text: string, limit: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
};

/** A value as people read it: a person or entity by its title, a list joined by commas. */
const readable = (value: Schema.Json): string => {
  if (Array.isArray(value)) return value.map(readable).join(", ");
  if (typeof value === "string") return value;
  const title = fieldOf(value, "$title");
  if (typeof title === "string") return title;
  const email = fieldOf(value, "email");
  if (typeof email === "string") return email;
  return value === null ? "" : JSON.stringify(value);
};

/** What an ask-first operation produces, for "approve an email before it goes to Ada". */
const approvalNoun: Readonly<Record<string, string>> = {
  "email.send": "an email",
  "slack.sendMessage": "a Slack message",
  "calendar.createEvent": "a calendar invitation",
};

const capitalized = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** Prefixes each line so Slack shows the text as a quote. */
const quoted = (lines: ReadonlyArray<string>) => lines.map((line) => `>${line}`).join("\n");

export interface TaskMessageInput {
  /** The automation's name. */
  readonly automation: string;
  readonly runId: RunId;
  readonly task: HumanTask;
  /** The run's subject as people know it, such as the new hire's name. */
  readonly subject: string | null;
  /** Where the studio is and which automation this is; without it the message has no link. */
  readonly link: Required<StudioLink> | undefined;
  /** More buttons after "Open in Studio", in the same actions block. */
  readonly actions?: ReadonlyArray<SlackButton>;
}

/** The headline, with `strong` marking the automation's name and the task's title. */
const headline = (
  { automation, task, subject }: TaskMessageInput,
  strong: (text: string) => string,
  text: (text: string) => string,
) => {
  const forSubject = subject === null ? "" : ` for ${text(subject)}`;
  if (task.action !== undefined) {
    const role = text(task.approvers?.label ?? "someone");
    const noun = approvalNoun[task.action.use];
    const to = task.action.inputs["to"];
    const recipient = to === undefined ? "" : readable(to);
    if (noun === undefined) {
      return `${strong(automation)} needs ${role} to approve ${strong(task.title)}${forSubject}.`;
    }
    return recipient === ""
      ? `${strong(automation)} needs ${role} to approve ${noun}${forSubject}.`
      : `${strong(automation)} needs ${role} to approve ${noun} before it goes to ${text(recipient)}.`;
  }
  const wants = task.response === "approval" ? "your approval" : "your answers";
  return `${strong(automation)} needs ${wants}${forSubject}: ${strong(task.title)}`;
};

/** What the person is asked to look at: the action's exact content, or the step's prompt. */
const details = (task: HumanTask): ReadonlyArray<string> => {
  if (task.action !== undefined) {
    return [
      ...(task.action.template === undefined ? [] : [`Template: ${escape(task.action.template)}`]),
      ...Object.entries(task.action.inputs)
        // The headline already says who it goes to.
        .filter(([name]) => !(name === "to" && approvalNoun[task.action?.use ?? ""] !== undefined))
        .map(([name, value]) => `${capitalized(name)}: ${escape(excerpt(readable(value), 200))}`),
    ];
  }
  const prompt = task.prompt.trim();
  return prompt === ""
    ? []
    : (prompt.length > 600 ? `${prompt.slice(0, 599).trimEnd()}…` : prompt).split("\n").map(escape);
};

/**
 * The DM for one open task: who needs to do what and for whom, the exact content an approval
 * would send, and an "Open in Studio" button to the run. The last block is the actions block
 * (`task-actions`), so buttons such as Approve and Reject go in `actions` after the link.
 */
export const taskMessage = (input: TaskMessageInput): SlackMessage => {
  const { task, link } = input;
  const lines = details(task);
  const url = link === undefined ? undefined : runUrl(link.origin, link.automationId, input.runId);
  const buttons: ReadonlyArray<SlackButton> = [
    ...(url === undefined
      ? []
      : [
          {
            type: "button" as const,
            action_id: "task.open",
            text: { type: "plain_text" as const, text: "Open in Studio" },
            url,
          },
        ]),
    ...(input.actions ?? []),
  ];
  const fields =
    task.response === "approval" ? [] : task.response.fields.map((field) => field.label);
  const blocks: ReadonlyArray<SlackBlock> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: headline(input, (text) => `*${escape(text)}*`, escape) },
    },
    ...(lines.length === 0
      ? []
      : [{ type: "section" as const, text: { type: "mrkdwn" as const, text: quoted(lines) } }]),
    ...(fields.length === 0
      ? []
      : [
          {
            type: "context" as const,
            elements: [
              { type: "mrkdwn" as const, text: `You'll fill in: ${escape(fields.join(", "))}` },
            ],
          },
        ]),
    ...(url === undefined
      ? [
          {
            type: "context" as const,
            elements: [
              {
                type: "mrkdwn" as const,
                text: `Answer it in the studio, on this run of ${escape(input.automation)}.`,
              },
            ],
          },
        ]
      : []),
    ...(buttons.length === 0
      ? []
      : [{ type: "actions" as const, block_id: "task-actions", elements: buttons }]),
  ];
  return {
    text: headline(
      input,
      (text) => text,
      (text) => text,
    ),
    blocks,
  };
};

/** Identifies one task's message in Slack, across automations and runs. */
export const taskMessageKey = (automationId: string | undefined, runId: RunId, step: string) =>
  `${automationId ?? "-"}/${runId}/${step}`;

export interface TaskNotifierOptions {
  /** The deployment's Slack sender, or `null` when Slack is simulated. */
  readonly slack: SlackSenderService | null;
  readonly readRun: (id: RunId) => Effect.Effect<StoredRun | undefined>;
  readonly updateRun: (id: RunId, change: (run: StoredRun) => StoredRun) => Effect.Effect<unknown>;
  /** The automation's ID and its studio origin, either of which may be unknown. */
  readonly link: Effect.Effect<{ readonly automationId?: string; readonly origin?: string }>;
  /** The run's subject as people know it. */
  readonly subjectTitle: (run: StoredRun) => Effect.Effect<string | null>;
}

/** Sends open tasks on Slack once per recipient, recording each delivery on the task. */
export const makeTaskNotifier = ({
  slack,
  readRun,
  updateRun,
  link,
  subjectTitle,
}: TaskNotifierOptions) => {
  const record = (runId: RunId, step: string, delivery: TaskNotification) =>
    updateRun(runId, (run) => ({
      ...run,
      tasks: run.tasks.map((task): HumanTask => {
        if (task.step !== step) return task;
        const others = (task.notifications ?? []).filter(
          (existing) => existing.to.toLowerCase() !== delivery.to.toLowerCase(),
        );
        return { ...task, notifications: [...others, delivery] };
      }),
    }));

  const deliver = Effect.fn("Automation.deliverTask")(function* (
    sender: SlackSenderService,
    runId: RunId,
    step: string,
    recipient: TaskRecipient,
    message: SlackMessage & { readonly key: string },
    previous: TaskNotification | undefined,
  ) {
    const person = { via: "slack" as const, to: recipient.email, name: recipient.name };
    if (previous?.status === "sending") {
      // An earlier delivery may have posted before it could record that it had.
      const found = yield* sender.findPosted(recipient.email, message.key).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Couldn't check Slack for an earlier task message", error),
        ),
        Effect.orElseSucceed(() => undefined),
      );
      if (found !== undefined) {
        return yield* record(runId, step, { ...person, status: "sent", ...found });
      }
    } else {
      yield* record(runId, step, { ...person, status: "sending" });
    }
    const posted = yield* sender
      .post({ kind: "person", email: recipient.email }, message)
      .pipe(Effect.result);
    yield* record(
      runId,
      step,
      Result.isSuccess(posted)
        ? { ...person, status: "sent", ...posted.success }
        : { ...person, status: "failed", error: posted.failure.message },
    );
  });

  /**
   * Sends one open task to everyone it hasn't reached yet. Does nothing when Slack is
   * simulated or the task has closed, and never fails.
   */
  const notify = Effect.fn("Automation.notifyTask")(
    function* (runId: RunId, step: string) {
      if (slack === null) return;
      const run = yield* readRun(runId);
      const task = run?.tasks.find((candidate) => candidate.step === step);
      if (run === undefined || task === undefined || task.status !== "open") return;
      const recipients = taskRecipients(task);
      if (recipients.length === 0) {
        if (task.notify === "slack") {
          yield* Effect.logWarning(`Task ${step} has no assignee with an email address to DM`);
        }
        return;
      }
      const { automationId, origin } = yield* link;
      if (automationId === undefined || origin === undefined) {
        yield* Effect.logWarning(
          "Task messages have no studio link: set STUDIO_URL, or save the automation from the studio",
        );
      }
      const message = {
        ...taskMessage({
          automation: run.workflow.name,
          runId,
          task,
          subject: yield* subjectTitle(run),
          link:
            automationId === undefined || origin === undefined
              ? undefined
              : { automationId, origin },
          // Only a role's approvals get buttons: a click is checked against the role's members.
          ...(task.approvers === undefined || automationId === undefined
            ? {}
            : { actions: approvalButtons({ automation: automationId, run: runId, step }) }),
        }),
        key: taskMessageKey(automationId, runId, step),
      };
      for (const recipient of recipients) {
        const previous = task.notifications?.find(
          (existing) => existing.to.toLowerCase() === recipient.email.toLowerCase(),
        );
        if (previous?.status === "sent" || previous?.status === "failed") continue;
        yield* deliver(slack, runId, step, recipient, message, previous);
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("Couldn't send a task on Slack", cause)),
  );

  return { notify };
};
