import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { ExecutionId } from "./execution.ts";
import { RunId } from "./run.ts";

describe("run identifiers", () => {
  test("decode and encode without changing the wire value", () => {
    for (const id of ["scheduled-1760000000000", "event-slack:message:T1", "change:abc"]) {
      expect(Schema.encodeSync(RunId)(Schema.decodeSync(RunId)(id))).toBe(id);
    }
    const execution = "4f8c2a";
    expect(Schema.encodeSync(ExecutionId)(Schema.decodeSync(ExecutionId)(execution))).toBe(
      execution,
    );
  });

  test("reject an empty identifier", () => {
    expect(() => Schema.decodeSync(RunId)("")).toThrow();
    expect(() => Schema.decodeSync(ExecutionId)("")).toThrow();
    expect(() => RunId.make("")).toThrow();
  });
});
