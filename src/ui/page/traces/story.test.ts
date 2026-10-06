/** Checks trace selection and refresh transitions, preserving visible data and ignoring outdated replies. */
import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { plannerOpen, plannerTrace } from "./fixtures.ts";
import {
  LoadAutomations,
  LoadRuns,
  LoadTrace,
  Message,
  Runs,
  TraceState,
  init,
  reflectUrl,
  update,
} from "./index.ts";

const named = (commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> = []) =>
  commands.map(({ name, args }) => ({ name, args }));

const planner = Option.some({ automationId: "welcome", maybeRunId: Option.none() });
const firstRun = Option.some({ automationId: "welcome", maybeRunId: Option.some("run-1") });

test("opening an automation loads its runs and its planner's trace", () => {
  const opened = init(planner);
  expect(named(opened.commands)).toEqual(
    named([
      LoadAutomations(),
      LoadRuns({ automationId: "welcome" }),
      LoadTrace({ load: 0, automationId: "welcome", maybeRunId: Option.none() }),
    ]),
  );
  expect(named(init(Option.none()).commands)).toEqual(named([LoadAutomations()]));
});

test("opening one of its runs keeps the run list and drops the planner's late trace", () => {
  const opened = init(planner);
  const loaded = update(
    opened.model,
    Message.SucceededLoadRuns({ automationId: "welcome", runs: [] }),
  ).model;
  const moved = reflectUrl(loaded, firstRun);
  expect(named(moved.commands)).toEqual(
    named([LoadTrace({ load: 1, automationId: "welcome", maybeRunId: Option.some("run-1") })]),
  );
  expect(moved.model.runs).toEqual(Runs.Ready({ automationId: "welcome", runs: [] }));
  const late = update(moved.model, Message.SucceededLoadTrace({ load: 0, trace: plannerTrace }));
  expect(late.model.trace).toEqual(TraceState.Loading());
  expect(reflectUrl(moved.model, firstRun).commands).toBeUndefined();
});

test("another automation's runs are ignored", () => {
  const opened = init(planner).model;
  const other = update(opened, Message.SucceededLoadRuns({ automationId: "other", runs: [] }));
  expect(other.model.runs).toEqual(Runs.Loading({ automationId: "welcome" }));
});

test("refreshing keeps the trace on screen until the new one arrives", () => {
  story(
    update,
    given(plannerOpen),
    message(Message.ClickedRefresh()),
    Command.expectHas(LoadTrace({ load: 1, automationId: "welcome", maybeRunId: Option.none() })),
    model((current) =>
      expect(current.trace).toEqual(TraceState.Refreshing({ trace: plannerTrace })),
    ),
    Command.resolveAll(
      [LoadAutomations, Message.SucceededLoadAutomations({ automations: [] })],
      [LoadRuns, Message.SucceededLoadRuns({ automationId: "welcome", runs: [] })],
      [LoadTrace, Message.SucceededLoadTrace({ load: 1, trace: { events: [], truncated: false } })],
    ),
    model((current) =>
      expect(current.trace).toEqual(TraceState.Ready({ trace: { events: [], truncated: false } })),
    ),
  );
});
