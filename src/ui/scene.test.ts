import { test } from "bun:test";
import * as Option from "effect/Option";
import { modifyFields } from "foldkit/struct";
import { Command, click, expect, given, label, role, scene, text, type } from "foldkit/scene";
import type { Url } from "foldkit/url";
import {
  LoadAutomations,
  Message,
  SendMessage,
  init,
  update,
  view,
  type Workflow,
} from "./main.ts";

const studioUrl: Url = {
  protocol: "http:",
  host: "localhost:1338",
  port: Option.some("1338"),
  pathname: "/",
  search: Option.none(),
  hash: Option.none(),
};

const loaded = update(
  init(studioUrl).model,
  Message.SucceededLoadAutomation({
    revision: 0,
    maybeDraft: Option.none(),
    hasSaved: false,
    conversation: [],
  }),
).model;

test("the accessible message input drives chat and safely renders the workflow", () => {
  scene(
    { update, view },
    given(loaded),
    expect(label("Automation ID")).toHaveValue("my-automation"),
    type(label("Your message"), "Summarize orders"),
    click(role("button", { name: "Send message" })),
    Command.expectExact(
      SendMessage({ automationId: "my-automation", revision: 0, message: "Summarize orders" }),
    ),
    Command.resolve(
      SendMessage,
      Message.SucceededSendMessage({
        revision: 0,
        sentMessage: "Summarize orders",
        reply: "Ready to review.",
        workflow: {
          name: "Orders",
          event: null,
          steps: [
            {
              id: "summary",
              kind: "agent",
              title: "<script>alert('unsafe')</script>",
              instruction: "Summarize",
            },
          ],
        },
      }),
    ),
    expect(text("Manual start")).toExist(),
    expect(text("<script>alert('unsafe')</script>")).toExist(),
    expect(label("Your message")).toHaveValue(""),
    Command.resolve(LoadAutomations, Message.SucceededLoadAutomations({ automations: [] })),
  );
});

test("a truncated step description expands to show the full text", () => {
  const instruction =
    "Read the order payload and write a two-sentence summary of what was bought, the total, and anything unusual about shipping or payment.";
  const draft: Workflow = {
    name: "Orders",
    event: null,
    steps: [{ id: "summary", kind: "agent", title: "Summarize the order", instruction }],
  };
  const draftModel = modifyFields(loaded, { maybeDraft: () => Option.some(draft) });
  const stepToggle = role("button", { name: /Summarize the order/ });

  scene(
    { update, view },
    given(draftModel),
    expect(stepToggle).toHaveAttr("aria-expanded", "false"),
    expect(text(instruction)).toHaveClass("line-clamp-2"),
    click(stepToggle),
    expect(stepToggle).toHaveAttr("aria-expanded", "true"),
    expect(text(instruction)).not.toHaveClass("line-clamp-2"),
    expect(text(instruction)).toHaveClass("whitespace-pre-wrap"),
    click(stepToggle),
    expect(stepToggle).toHaveAttr("aria-expanded", "false"),
    expect(text(instruction)).toHaveClass("line-clamp-2"),
  );
});

test("the sidebar links to every automation and marks the open one", () => {
  scene(
    { update, view },
    given(
      update(
        loaded,
        Message.SucceededLoadAutomations({
          automations: [
            { id: "my-automation", name: "Manager onboarding" },
            { id: "orders", name: "Order summaries" },
          ],
        }),
      ).model,
    ),
    expect(role("link", { name: /Manager onboarding/ })).toHaveAttr(
      "href",
      "/?automation=my-automation",
    ),
    expect(role("link", { name: /Manager onboarding/ })).toHaveAttr("aria-current", "page"),
    expect(role("link", { name: /Order summaries/ })).toHaveAttr("href", "/?automation=orders"),
    expect(role("link", { name: /Order summaries/ })).not.toHaveAttr("aria-current"),
  );
});

test("variables render as chips in steps and as trigger inputs", () => {
  const draft: Workflow = {
    name: "Onboarding",
    event: "new_hire.confirmed",
    steps: [
      {
        id: "it",
        kind: "agent",
        title: "Order a laptop for {{new_hire}}",
        instruction: "File an IT ticket for {{new_hire}} starting {{start_date}}.",
      },
    ],
  };
  const inputs = role("list", { name: "Inputs" });

  scene(
    { update, view },
    given(modifyFields(loaded, { maybeDraft: () => Option.some(draft) })),
    expect(inputs).toHaveText("new_hirestart_date"),
    expect(role("button", { name: /Order a laptop for new_hire$/ })).toExist(),
    expect(text("File an IT ticket for new_hire starting start_date.")).toExist(),
    expect(text("{{new_hire}}", { exact: false })).not.toExist(),
  );
});

test("the JSON toggle shows the draft's raw workflow", () => {
  const draft: Workflow = {
    name: "Orders",
    event: null,
    steps: [{ id: "summary", kind: "agent", title: "Summarize", instruction: "For {{order_id}}" }],
  };
  const toggle = role("button", { name: "JSON" });

  scene(
    { update, view },
    given(modifyFields(loaded, { maybeDraft: () => Option.some(draft) })),
    expect(toggle).toHaveAttr("aria-pressed", "false"),
    expect(label("Draft JSON")).not.toExist(),
    click(toggle),
    expect(toggle).toHaveAttr("aria-pressed", "true"),
    expect(label("Draft JSON")).toHaveText(JSON.stringify(draft, null, 2)),
    expect(role("list", { name: "Steps" })).not.toExist(),
    click(toggle),
    expect(role("list", { name: "Steps" })).toExist(),
  );
});

test("nested steps render as labelled lanes with readable conditions and settings", () => {
  const draft: Workflow = {
    name: "Onboarding",
    event: "new_hire.confirmed",
    steps: [
      {
        id: "prep",
        title: "Prep",
        kind: "parallel",
        branches: [
          [{ id: "laptop", title: "Order laptop", kind: "agent", instruction: "Order it" }],
          [
            {
              id: "week-out",
              title: "One week out",
              kind: "wait",
              until: "input.start_date",
              offset: "-7 days",
            },
          ],
        ],
      },
      {
        id: "route",
        title: "Route",
        kind: "decide",
        model: "clef-flash",
        question: "Is {{manager}} around?",
        options: [
          { id: "around", description: "Available", steps: [] },
          {
            id: "away",
            description: "Out of office",
            steps: [
              {
                id: "ask",
                title: "Ask for cover",
                kind: "human",
                prompt: "Who covers?",
                assignee: "{{manager}}",
                response: "approval",
                timeout: "2 days",
              },
            ],
          },
        ],
      },
      {
        id: "check",
        title: "Check",
        kind: "if",
        cases: [
          {
            when: { ref: "steps.ask.approved", op: "equals", value: true },
            steps: [{ id: "pause", title: "Pause", kind: "wait", duration: "3 days" }],
          },
        ],
      },
    ],
  };

  scene(
    { update, view },
    given(modifyFields(loaded, { maybeDraft: () => Option.some(draft) })),
    expect(role("list", { name: "Branch 1" })).toExist(),
    expect(role("list", { name: "Branch 2" })).toExist(),
    expect(text("Until 7 days before start_date")).toExist(),
    expect(role("list", { name: "Option away" })).toExist(),
    expect(role("button", { name: /Ask for cover$/ })).toExist(),
    expect(text("Assignee: manager")).toExist(),
    expect(text("Times out after 2 days")).toExist(),
    expect(text("If ask.approved is true")).toExist(),
    expect(text("Pauses for 3 days")).toExist(),
    expect(role("list", { name: "Inputs" })).toHaveText("start_datemanager"),
  );
});
