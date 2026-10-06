import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  CallFailed,
  casePassRate,
  checkPassRate,
  CheckFailed,
  defineEval,
  evalPassed,
  EvalWorker,
  judged,
  runEval,
} from "./eval.ts";
import { WorkersAi } from "./models.ts";

/**
 * Runs evals without the Evals Worker: calls run in this process with no model, and the judge
 * fails what mentions "odd".
 */

const stubs = Layer.succeed(EvalWorker, {
  call: (call, input) =>
    call.run(input).pipe(
      Effect.provideService(WorkersAi, { binding: {} as Ai, model: "none" }),
      Effect.mapError((error) => new CallFailed({ message: error.message })),
    ),
  judge: (criterion, material) =>
    material.includes("odd")
      ? Effect.fail(new CheckFailed({ message: `Not ${criterion}` }))
      : Effect.void,
});

const parity = defineEval({
  call: {
    name: "parity",
    input: Schema.Finite,
    output: Schema.Boolean,
    timeout: "1 second",
    run: (input: number) =>
      input < 0 ? Effect.fail({ message: "Negative" }) : Effect.succeed(input % 2 === 0),
  },
  minimum: 0.5,
  every: {
    "is even": (even) => expect(even).toBe(true),
  },
  cases: {
    two: { input: 2 },
    three: {
      input: 3,
      checks: { "reads as even": judged("even", (even) => (even ? "even" : "odd")) },
    },
    minus: { input: -1 },
  },
});

const run = (filter?: string) =>
  Effect.runPromise(
    runEval("parity", parity, {
      trials: 2,
      concurrency: 2,
      ...(filter === undefined ? {} : { filter }),
    }).pipe(Effect.provide(stubs)),
  );

describe("evals", () => {
  test("run every check on each trial, and a failed call fails them all", async () => {
    const result = await run();
    const [two, three, minus] = result.cases;
    expect(two?.trials.map((trial) => trial.checks)).toEqual([
      [{ name: "is even", pass: true }],
      [{ name: "is even", pass: true }],
    ]);
    expect(three?.trials[0]?.checks).toEqual([
      { name: "is even", pass: false, note: expect.stringContaining("Expected: true") },
      { name: "reads as even", pass: false, note: "Not even" },
    ]);
    expect(minus?.trials[0]).toMatchObject({
      error: "Negative",
      checks: [{ name: "is even", pass: false, note: "Negative" }],
    });
    expect(result.cases.map(casePassRate)).toEqual([1, 0, 0]);
    expect(checkPassRate(result.cases)).toBeCloseTo(2 / 8);
    expect(evalPassed(result)).toBe(false);
    expect(evalPassed({ ...result, minimum: 0.25 })).toBe(true);
  });

  test("run only the cases the filter names", async () => {
    const result = await run("thr");
    expect(result.cases.map((each) => each.name)).toEqual(["three"]);
  });
});
