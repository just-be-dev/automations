/** Checks name cleanup and fallback behavior when the naming model fails, stalls, or answers poorly. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  AutomationNamer,
  fallbackName,
  nameAutomation,
  nameFromReply,
  NamerError,
  nameRequest,
} from "./namer.ts";

test("a reply's name drops the labels, quotes, and markup small models add", () => {
  expect(nameFromReply("Onboard new hires")).toEqual(Option.some("Onboard new hires"));
  expect(nameFromReply('Name: "Onboard new hires."')).toEqual(Option.some("Onboard new hires"));
  expect(nameFromReply("**summarize new orders**\nThis names the automation.")).toEqual(
    Option.some("Summarize new orders"),
  );
  expect(nameFromReply(`${"word ".repeat(30)}end`)).toEqual(
    Option.some(`Word ${"word ".repeat(14)}word`),
  );
  expect(nameFromReply('  ""  ')).toEqual(Option.none());
});

test("a Title Case name becomes sentence case, keeping the capitals of names", () => {
  expect(nameFromReply("Daily Sales Report")).toEqual(Option.some("Daily sales report"));
  expect(nameFromReply("Update Roadmap Every Monday")).toEqual(
    Option.some("Update roadmap every Monday"),
  );
  expect(nameFromReply("Sync HR Records To GitHub")).toEqual(
    Option.some("Sync HR records to GitHub"),
  );
  expect(nameFromReply("Post Slack Reminders")).toEqual(Option.some("Post Slack reminders"));
  expect(nameFromReply("Remind managers in Slack")).toEqual(
    Option.some("Remind managers in Slack"),
  );
  expect(nameFromReply("Quarterly Review Reminders sent to Managers")).toEqual(
    Option.some("Quarterly review reminders sent to managers"),
  );
  expect(nameFromReply("Remind Acme about renewals")).toEqual(
    Option.some("Remind Acme about renewals"),
  );
});

test("the description is marked as text to name, not instructions", () => {
  expect(nameRequest("expense approvals").messages.at(-1)?.content).toBe(
    "<description>\nexpense approvals\n</description>",
  );
});

test("without an answer, the name is the description's opening words", () => {
  expect(fallbackName("When an order arrives, summarize it and post it to Slack")).toBe(
    "When an order arrives, summarize it",
  );
  expect(fallbackName("   ")).toBe("New automation");
});

test("naming falls back when the model fails or answers with nothing", async () => {
  const name = (complete: AutomationNamer["Service"]["complete"]) =>
    Effect.runPromise(
      nameAutomation("ping the team daily").pipe(
        Effect.provideService(AutomationNamer, { complete }),
      ),
    );
  expect(await name(() => Effect.succeed("Daily team ping"))).toBe("Daily team ping");
  expect(await name(() => Effect.succeed(""))).toBe("Ping the team daily");
  expect(await name(() => Effect.fail(new NamerError({ message: "Down" })))).toBe(
    "Ping the team daily",
  );
});
