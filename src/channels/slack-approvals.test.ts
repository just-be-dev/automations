/** Checks how a decided approval DM is redrawn: buttons gone, everything else kept, one decision line. */
import { expect, test } from "bun:test";
import type { HumanTask } from "../workflow/run.ts";
import * as Schema from "effect/Schema";
import {
  approvalButtons,
  decidedMessage,
  DECISION_BLOCK,
  SlackBlockJson,
} from "./slack-approvals.ts";

const at = Date.parse("2026-10-14T10:05:00Z");
const task = (decision: HumanTask["decision"]): HumanTask => ({
  step: "send",
  token: "token",
  title: "Send the welcome email",
  prompt: "Send an email with the details below?",
  assignee: null,
  response: "approval",
  defaults: {},
  approvers: {
    role: "people-ops",
    label: "People Ops",
    members: [{ name: "Grace <Hopper> & co", email: "grace@example.com" }],
  },
  ...(decision === undefined ? {} : { decision }),
  status: "closed",
});
const [approve, reject] = approvalButtons({ automation: "a1", run: "run-1", step: "send" });
const openInStudio = {
  type: "button",
  action_id: "open",
  text: { type: "plain_text", text: "Open" },
};
const section = { type: "section", text: { type: "mrkdwn", text: "Approve the welcome email?" } };
/** Blocks as Slack sends them back in a click: plain JSON. */
const received = Schema.decodeUnknownSync(Schema.Array(SlackBlockJson));

test("buttons carry the task, and Slack styles Approve green and Reject red", () => {
  expect(approve).toMatchObject({ action_id: "task.approve", style: "primary" });
  expect(reject).toMatchObject({ action_id: "task.reject", style: "danger" });
  expect(JSON.parse(String(approve?.["value"]))).toEqual({
    automation: "a1",
    run: "run-1",
    step: "send",
  });
});

test("a decided message keeps its other blocks and buttons, and says who decided and when", () => {
  const decided = decidedMessage(
    received([
      section,
      { type: "actions", block_id: "task-actions", elements: [openInStudio, approve, reject] },
    ]),
    task({ approved: true, by: "GRACE@example.com", at }),
  );
  expect(decided.blocks.slice(0, 2)).toEqual([
    section,
    { type: "actions", block_id: "task-actions", elements: [openInStudio] },
  ]);
  expect(decided.blocks[2]).toMatchObject({ type: "context", block_id: DECISION_BLOCK });
  // A member is named, escaped for mrkdwn; the time reads in each person's own zone.
  expect(decided.blocks[2]?.["elements"]).toEqual([
    {
      type: "mrkdwn",
      text: ":white_check_mark: *Approved* by Grace &lt;Hopper&gt; &amp; co · <!date^1791972300^{date_short_pretty} at {time}|2026-10-14 10:05 UTC>",
    },
  ]);
  expect(decided.text).toBe("Approved by Grace <Hopper> & co on 2026-10-14 10:05 UTC");
});

test("redrawing a decided message replaces its decision line instead of adding another", () => {
  const first = decidedMessage(
    received([section, { type: "actions", elements: [approve, reject] }]),
    task({ approved: false, by: "someone@example.com", at }),
  );
  // The actions block held only the two buttons, so it goes.
  expect(first.blocks).toHaveLength(2);
  expect(first.text).toBe("Rejected by someone@example.com on 2026-10-14 10:05 UTC");
  const again = decidedMessage(
    first.blocks,
    task({ approved: false, by: "someone@example.com", at }),
  );
  expect(again).toEqual(first);
});

test("a decision made where the studio didn't know who answered says so", () => {
  expect(decidedMessage([], task({ approved: true, at })).text).toBe(
    "Approved in the studio on 2026-10-14 10:05 UTC",
  );
  expect(decidedMessage([], task(undefined)).text).toBe("Already answered");
});
