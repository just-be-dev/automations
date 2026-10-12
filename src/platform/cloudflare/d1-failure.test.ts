import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { failWith } from "./d1-failure.ts";

class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
}) {}

const typed = failWith("List types", (message) => new StoreError({ message }));

describe("failWith", () => {
  test("turns a defect into the typed error with its own message", async () => {
    const error = await Effect.runPromise(
      typed(Effect.die(new Error("D1_ERROR: no such table"))).pipe(Effect.flip),
    );
    expect(error.message).toBe("List types: D1_ERROR: no such table");
  });

  test("turns a typed failure into the typed error", async () => {
    const error = await Effect.runPromise(typed(Effect.fail("busy")).pipe(Effect.flip));
    expect(error.message).toBe("List types: busy");
  });

  test("keeps an interruption an interruption", async () => {
    const exit = await Effect.runPromiseExit(typed(Effect.interrupt));
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  });
});
