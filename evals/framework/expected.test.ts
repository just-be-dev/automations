/** Checks how the values datasets expect match outputs, and how they decode. */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Expected, expectText, mismatches } from "./expected.ts";

// Datasets decode strictly, so a key no member allows is an error rather than dropped.
const decode = (value: unknown) =>
  Schema.decodeUnknownResult(Expected)(value, { onExcessProperty: "error" });

describe("expected values", () => {
  test("plain values, lists, and mappings must be equal", () => {
    expect(mismatches(17, 17)).toEqual([]);
    expect(mismatches("a", "b")).toEqual(['it is "b", not "a"']);
    expect(mismatches([1, 2], [1, 2, 3])).toEqual(["it has 3 items, not 2: [1,2,3]"]);
    expect(mismatches({ kind: "event" }, { kind: "event", subject: undefined })).toEqual([]);
    expect(mismatches({ kind: "event" }, { kind: "event", subject: "employee" })).toEqual([
      'it.subject is "employee", and shouldn\'t be there',
    ]);
    expect(mismatches({ a: { b: 1 } }, { a: { b: 2 } }, "trigger")).toEqual([
      "trigger.a.b is 2, not 1",
    ]);
  });

  test("$includes asks for at least these keys, items, or text", () => {
    expect(mismatches({ $includes: { a: 1 } }, { a: 1, b: 2 })).toEqual([]);
    // Inside $includes, values are still compared exactly unless they say otherwise.
    expect(mismatches({ $includes: { a: { b: 1 } } }, { a: { b: 1, c: 2 } })).toHaveLength(1);
    expect(
      mismatches({ $includes: { a: { $includes: { b: 1 } } } }, { a: { b: 1, c: 2 } }),
    ).toEqual([]);
    expect(mismatches({ $includes: ["x", "z"] }, ["x", "y"])).toEqual([
      'it has nothing matching "z": it is ["x","y"]',
    ]);
    expect(mismatches({ $includes: "Grace" }, "Hi from Grace Hopper")).toEqual([]);
    expect(mismatches({ $includes: "Grace" }, 3)).toHaveLength(1);
  });

  test("$matches, $oneOf, and $type", () => {
    expect(mismatches({ $matches: "/^team$/i" }, "Team")).toEqual([]);
    expect(mismatches({ $matches: "/^team$/" }, "Team")).toEqual([
      'it is "Team", which doesn\'t match /^team$/',
    ]);
    expect(mismatches({ $oneOf: ["timing", "planning"] }, "planning")).toEqual([]);
    expect(mismatches({ $oneOf: ["timing", "planning"] }, "people")).toHaveLength(1);
    expect(mismatches({ $type: "string" }, "slack")).toEqual([]);
    expect(mismatches({ $type: "object" }, [])).toEqual(["it is [], not a object"]);
  });

  test("text is contained, or matches a pattern", () => {
    expect(() => expectText("steps.ask.values", "steps.ask")).not.toThrow();
    expect(() => expectText("steps.ask", { $matches: "/^steps\\./" })).not.toThrow();
    expect(() => expectText("employee", "manager")).toThrow("doesn't contain");
  });

  test("operators must be well formed, and plain keys can't start with $", () => {
    expect(decode({ $includes: { a: [1, { $type: "array" }] } })._tag).toBe("Success");
    expect(decode({ $matches: "team" })._tag).toBe("Failure");
    expect(decode({ $matches: "/(/" })._tag).toBe("Failure");
    expect(decode({ $type: "date" })._tag).toBe("Failure");
    expect(decode({ $unknown: 1 })._tag).toBe("Failure");
  });
});
