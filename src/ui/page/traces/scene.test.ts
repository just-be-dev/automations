import { test } from "bun:test";
import { Command, click, expect, given, role, scene, text } from "foldkit/scene";
import * as Option from "effect/Option";
import { plannerOpen } from "./fixtures.ts";
import { LoadAutomations, LoadRuns, LoadTrace, Message, update, view } from "./index.ts";

test("the planner's trace shows its prompt, reasoning, tool calls and failed results", () => {
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
    expect(text("Welcome new hires")).toExist(),
    expect(text("Reasoning · 22 characters")).toExist(),
    expect(text("put_steps()")).toExist(),
    expect(text("put_steps failed")).toExist(),
    expect(text("Step welcome needs a title")).toExist(),
    expect(text("I drafted the welcome email.")).toExist(),
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
