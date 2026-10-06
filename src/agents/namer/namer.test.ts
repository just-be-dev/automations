import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  AutomationNamer,
  fallbackName,
  nameAutomation,
  nameFromReply,
  NamerError,
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
