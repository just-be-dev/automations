/** Exercises the trace debugger's conversation lines and their details, usage totals, source links, and failed refresh feedback. */
import { test } from "bun:test";
import { Command, click, expect, given, role, scene, text } from "foldkit/scene";
import * as Option from "effect/Option";
import { plannerOpen } from "./fixtures.ts";
import { LoadAutomations, LoadRuns, LoadTrace, Message, update, view } from "./index.ts";

test("the planner's trace lists its prompt, reasoning, tool calls and failed results, and opens their details", () => {
  scene(
    { update, view },
    given(plannerOpen),
    expect(role("link", { name: "Welcome hires" })).toHaveAttr("aria-current", "page"),
    expect(role("link", { name: /Ada Lovelace/ })).toHaveAttr(
      "href",
      "/traces?automation=welcome&run=run-1",
    ),
    expect(role("heading", { name: "Planner conversation" })).toExist(),
    expect(
      text("2 model responses · 1 tool call · 2,500 in · 100 out · 2,200 cached · kimi"),
    ).toExist(),
    expect(role("button", { name: /^System prompt/ })).toHaveAttr("aria-expanded", "false"),
    expect(text("Welcome new hires")).toExist(),
    expect(text("Reasoning")).toExist(),
    expect(text("22 characters")).toExist(),
    expect(text('put_steps({ "steps": [] })')).toExist(),
    expect(text("put_steps failed: Step welcome needs a title")).toExist(),
    expect(text("I drafted the welcome email.")).toExist(),
    expect(text("A hire needs an email.")).toBeAbsent(),
    click(role("button", { name: /^Reasoning/ })),
    expect(text("A hire needs an email.")).toBeVisible(),
    click(role("button", { name: /^System prompt/ })),
    expect(text("Added set_workflow, put_steps")).toExist(),
    expect(text("You design automations.")).toBeVisible(),
    click(role("button", { name: /^Reasoning/ })),
    expect(text("A hire needs an email.")).toBeAbsent(),
    expect(text("You design automations.")).toBeVisible(),
    click(role("button", { name: "Refresh" })),
    Command.expectExact(
      LoadAutomations(),
      LoadRuns({ automationId: "welcome" }),
      LoadTrace({ load: 1, automationId: "welcome", maybeRunId: Option.none() }),
    ),
    expect(role("button", { name: "Refresh" })).toBeDisabled(),
    Command.resolveAll(
      [LoadAutomations, Message.SucceededLoadAutomations({ automations: [] })],
      [LoadRuns, Message.SucceededLoadRuns({ automationId: "welcome", runs: [] })],
      [LoadTrace, Message.FailedLoadTrace({ load: 1, error: "Unknown pi conversation 7" })],
    ),
    expect(text("Couldn't load the trace: Unknown pi conversation 7")).toExist(),
  );
});
