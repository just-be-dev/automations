/** Approve and Reject buttons on approval-task DMs, and deciding a task when someone clicks one. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Automations } from "../automation/service.ts";
import type { SlackButton } from "../connections/slack.ts";
import { messageOf } from "../error.ts";
import { RunId, type HumanTask } from "../workflow/run.ts";

/**
 * A click travels in two hops. The public Channels Worker checks Slack's signature, turns the
 * click into a `SlackTaskAction`, queues it, and acknowledges at once (`slack-interactivity.ts`).
 * The private Api takes it off the queue and runs `decideFromSlack`: it looks up the clicker's
 * email address and answers through `Automation.respond` as that person, as the studio does with
 * the Access email. Anyone who can answer in the studio may answer here.
 *
 * Slack may deliver a click more than once, and people click twice. Deciding is idempotent: the
 * first answer closes the task, and every later click of either button finds it closed and
 * redraws the message from the task's recorded `decision`.
 */

/** Action IDs are matched on every click Slack sends back. Changing them strands sent messages. */
export const APPROVE_ACTION = "task.approve";
export const REJECT_ACTION = "task.reject";
/** The block that says who decided. A redrawn message replaces it rather than adding another. */
export const DECISION_BLOCK = "task-decision";

/** The task a button answers. Slack hands the button's value back on every click. */
export const TaskRef = Schema.Struct({
  automation: Schema.String,
  run: Schema.String,
  step: Schema.String,
});
export interface TaskRef extends Schema.Schema.Type<typeof TaskRef> {}

/** A Block Kit block as Slack sends it back in a click, and accepts it again in `chat.update`. */
export const SlackBlockJson = Schema.Record(Schema.String, Schema.Json);
export type SlackBlockJson = typeof SlackBlockJson.Type;

/**
 * Approve and Reject, for the `actions` block of an approval task's DM, after "Open in Studio".
 * Slack shows `primary` green and `danger` red.
 */
export const approvalButtons = (ref: TaskRef): readonly [SlackButton, SlackButton] => {
  const value = JSON.stringify({ automation: ref.automation, run: ref.run, step: ref.step });
  return [
    {
      type: "button",
      action_id: APPROVE_ACTION,
      text: { type: "plain_text", text: "Approve" },
      style: "primary",
      value,
    },
    {
      type: "button",
      action_id: REJECT_ACTION,
      text: { type: "plain_text", text: "Reject" },
      style: "danger",
      value,
    },
  ];
};

/** One click of Approve or Reject, as the Channels Worker queues it for the Api. */
export const SlackTaskAction = Schema.Struct({
  task: TaskRef,
  approved: Schema.Boolean,
  /** The Slack user who clicked. Slack signed the request that named them. */
  user: Schema.String,
  /** The clicked message, for `chat.update`. */
  channel: Schema.String,
  ts: Schema.String,
  /** Slack's address for answering this click, such as with an ephemeral refusal. */
  responseUrl: Schema.String,
  /** The message as Slack shows it now; the update keeps every block but the buttons. */
  blocks: Schema.Array(SlackBlockJson),
});
export interface SlackTaskAction extends Schema.Schema.Type<typeof SlackTaskAction> {}

export class SlackTaskActionError extends Schema.TaggedError<SlackTaskActionError>()(
  "SlackTaskActionError",
  { message: Schema.String },
) {}

/** Durable hand-off from the Channels Worker to the Api: accepted means it will be decided. */
export class SlackTaskActions extends Context.Service<
  SlackTaskActions,
  { readonly send: (action: SlackTaskAction) => Effect.Effect<void, SlackTaskActionError> }
>()("automations/SlackTaskActions") {}

export class SlackWorkspaceError extends Schema.TaggedError<SlackWorkspaceError>()(
  "SlackWorkspaceError",
  { message: Schema.String },
) {}

/** What deciding needs from Slack. The Api provides it over the Web API with the bot token. */
export class SlackWorkspace extends Context.Service<
  SlackWorkspace,
  {
    /** The person's email address, or `undefined` for a bot or anyone Slack has none for. */
    readonly emailOf: (user: string) => Effect.Effect<string | undefined, SlackWorkspaceError>;
    readonly updateMessage: (
      channel: string,
      ts: string,
      message: { readonly text: string; readonly blocks: ReadonlyArray<SlackBlockJson> },
    ) => Effect.Effect<void, SlackWorkspaceError>;
    /** Answers only the person who clicked, leaving the message as it is. */
    readonly replyEphemeral: (
      responseUrl: string,
      text: string,
    ) => Effect.Effect<void, SlackWorkspaceError>;
  }
>()("automations/SlackWorkspace") {}

/** Slack reads `&`, `<` and `>` in mrkdwn as markup. */
const escapeMrkdwn = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slack shows the time in each reader's own time zone; the fallback is UTC. */
const slackTime = (at: number) => {
  const fallback = `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return {
    mrkdwn: `<!date^${Math.floor(at / 1000)}^{date_short_pretty} at {time}|${fallback}>`,
    plain: fallback,
  };
};

/**
 * "Approved by ada@example.com". A task opened while approvals named a role recorded its members,
 * so one of them is named by name.
 */
export const decisionLine = (task: HumanTask) => {
  const decision = task.decision;
  if (decision === undefined) return { mrkdwn: "Already answered", plain: "Already answered" };
  const verb =
    decision.approved === undefined ? "Answered" : decision.approved ? "Approved" : "Rejected";
  const icon =
    decision.approved === undefined ? "" : decision.approved ? ":white_check_mark: " : ":x: ";
  const by = decision.by?.toLowerCase();
  const name =
    by === undefined
      ? undefined
      : (task.approvers?.members.find((member) => member.email.toLowerCase() === by)?.name ??
        decision.by);
  const who = name === undefined ? " in the studio" : ` by ${name}`;
  const when = slackTime(decision.at);
  return {
    mrkdwn: `${icon}*${verb}*${escapeMrkdwn(who)} · ${when.mrkdwn}`,
    plain: `${verb}${who} on ${when.plain}`,
  };
};

/**
 * The message once decided: every block it had, without the Approve and Reject buttons (an
 * actions block left empty goes too), and a closing line saying who decided and when.
 */
export const decidedMessage = (blocks: ReadonlyArray<SlackBlockJson>, task: HumanTask) => {
  const line = decisionLine(task);
  const kept = blocks.flatMap((block): ReadonlyArray<SlackBlockJson> => {
    if (block["block_id"] === DECISION_BLOCK) return [];
    const elements = block["elements"];
    if (block["type"] !== "actions" || !Array.isArray(elements)) return [block];
    const remaining = elements.filter(
      (element) =>
        typeof element !== "object" ||
        element === null ||
        Array.isArray(element) ||
        (element["action_id"] !== APPROVE_ACTION && element["action_id"] !== REJECT_ACTION),
    );
    return remaining.length === 0 ? [] : [{ ...block, elements: remaining }];
  });
  return {
    text: line.plain,
    blocks: [
      ...kept,
      {
        type: "context",
        block_id: DECISION_BLOCK,
        elements: [{ type: "mrkdwn", text: line.mrkdwn }],
      },
    ],
  };
};

export class SlackDecisionError extends Schema.TaggedError<SlackDecisionError>()(
  "SlackDecisionError",
  { message: Schema.String },
) {}

const refusals = {
  noEmail:
    "Slack has no email address for you, so the studio can't check that you may answer this. Open it in the studio instead.",
  gone: "That task isn't waiting for an answer",
  notApproval: "Answer this one in the studio.",
};

/**
 * Decides the task one click names, as the person who clicked. A closed task, decided by this
 * click or an earlier one, redraws the message from its recorded decision. A click that can't be
 * answered from Slack is told why, only they see it, and the message stays. Any other failure
 * fails the effect, so the queue retries the whole click, which repeats nothing.
 */
export const decideFromSlack = Effect.fn("SlackApprovals.decide")(function* (
  action: SlackTaskAction,
) {
  const slack = yield* SlackWorkspace;
  const automation = (yield* Automations).get(action.task.automation);
  const runId = RunId.make(action.task.run);
  const taskNow = automation
    .run(runId)
    .pipe(Effect.map((run) => run?.tasks.find((candidate) => candidate.step === action.task.step)));
  const redraw = (task: HumanTask) =>
    slack.updateMessage(action.channel, action.ts, decidedMessage(action.blocks, task));
  const refuse = (text: string) =>
    Effect.logInfo("Refused a Slack approval click").pipe(
      Effect.annotateLogs({ automation: action.task.automation, run: action.task.run }),
      Effect.andThen(slack.replyEphemeral(action.responseUrl, text)),
    );

  const task = yield* taskNow;
  if (task?.status === "closed") return yield* redraw(task);
  if (task === undefined) return yield* refuse(refusals.gone);
  if (task.response !== "approval") return yield* refuse(refusals.notApproval);
  // Never answer without an email address: the decision records who answered.
  const email = yield* slack.emailOf(action.user);
  if (email === undefined) return yield* refuse(refusals.noEmail);
  const answered = yield* automation
    .respond(runId, action.task.step, { approved: action.approved }, email)
    .pipe(Effect.result);
  // Closed by this answer, or by another that got there first.
  const after = yield* taskNow;
  if (after?.status === "closed") return yield* redraw(after);
  return yield* new SlackDecisionError({
    message: Result.isFailure(answered)
      ? messageOf(answered.failure)
      : "An answered task is still open",
  });
});
