/** Guards structural RPC error messages and caller-specific fallbacks for unrecognized failures. */
import { expect, test } from "bun:test";
import { messageOf } from "./error.ts";

test("reads local and RPC errors without discarding empty messages", () => {
  expect(messageOf(new Error("Local failure"))).toBe("Local failure");
  expect(messageOf({ message: "Remote failure" })).toBe("Remote failure");
  expect(messageOf({ message: "" }, "The tool failed")).toBe("");
});

test("uses the caller's fallback only when no string message exists", () => {
  expect(messageOf(null)).toBe("Unexpected error");
  expect(messageOf("Failure")).toBe("Unexpected error");
  expect(messageOf({ message: 12 }, "The tool failed")).toBe("The tool failed");
  expect(messageOf({}, "The tool failed")).toBe("The tool failed");
});
