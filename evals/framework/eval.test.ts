/** Checks datasets, trial execution, failure accounting, pass rates, and case filtering with stubbed models. */

import { describe, expect, test } from "bun:test";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  CallFailed,
  casePassRate,
  checkPassRate,
  CheckFailed,
  datasetJsonSchema,
  defineEval,
  evalPassed,
  EvalWorker,
  judged,
  loadEvals,
  runEval,
  runEvals,
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
  checks: {
    reads: {
      value: Schema.String,
      check: (criterion) => judged(criterion, (even) => (even ? "even" : "odd")),
    },
    above: {
      value: Schema.Finite,
      check: (floor) => (_even, input) => expect(input).toBeGreaterThan(floor),
    },
  },
});

const dataset = {
  cases: {
    two: { input: 2, checks: { "is positive": [{ above: 0 }, { reads: "even" }] } },
    three: { input: 3, checks: { "reads as even": { reads: "even" } } },
    minus: { input: -1 },
  },
};

const run = (filter?: string) =>
  Effect.runPromise(
    parity.load(dataset).pipe(
      Effect.flatMap((suite) =>
        runEval("parity", suite, {
          trials: 2,
          concurrency: 2,
          ...(filter === undefined ? {} : { filter }),
        }),
      ),
      Effect.provide(stubs),
    ),
  );

const loadError = (raw: unknown) =>
  Effect.runPromise(parity.load(raw).pipe(Effect.flip)).then((error) => error.message);

describe("evals", () => {
  test("run every check on each trial, and a failed call fails them all", async () => {
    const result = await run();
    const [two, three, minus] = result.cases;
    expect(two?.trials.map((trial) => trial.checks)).toEqual([
      [
        { name: "is even", pass: true },
        { name: "is positive", pass: true },
      ],
      [
        { name: "is even", pass: true },
        { name: "is positive", pass: true },
      ],
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
    expect(checkPassRate(result.cases)).toBeCloseTo(4 / 10);
    expect(evalPassed(result)).toBe(false);
    expect(evalPassed({ ...result, minimum: 0.25 })).toBe(true);
  });

  test("run only the cases the filter names", async () => {
    const result = await run("thr");
    expect(result.cases.map((each) => each.name)).toEqual(["three"]);
  });

  test("run every eval's trials from one queue, longest first, and report each eval when done", async () => {
    const started: Array<string> = [];
    const done: Array<string> = [];
    const echo = (name: string, timeout: Duration.Input) =>
      defineEval({
        call: {
          name,
          input: Schema.String,
          output: Schema.String,
          timeout,
          run: (input: string) => Effect.sync(() => started.push(input)).pipe(Effect.as(input)),
        },
        minimum: 1,
        checks: {},
      });
    const suites = await Effect.runPromise(
      Effect.all([
        echo("quick", "1 second").load({
          cases: { a: { input: "quick a" }, b: { input: "quick b" } },
        }),
        echo("slow", "1 minute").load({ cases: { c: { input: "slow c" } } }),
      ]),
    );
    const results = await Effect.runPromise(
      runEvals(
        [
          { name: "quick", suite: suites[0] },
          { name: "slow", suite: suites[1] },
        ],
        {
          trials: 1,
          concurrency: 1,
          // b ran longest last time; a and c count as their timeouts.
          estimate: (_name, caseName) => (caseName === "b" ? 120_000 : undefined),
          onEvalDone: (result) => Effect.sync(() => done.push(result.name)),
        },
      ).pipe(Effect.provide(stubs)),
    );
    expect(started).toEqual(["quick b", "slow c", "quick a"]);
    expect(done).toEqual(["slow", "quick"]);
    expect(results.map((result) => result.name)).toEqual(["quick", "slow"]);
    expect(results[0]?.cases.map((each) => each.name)).toEqual(["a", "b"]);
  });

  test("a check made of several fails when any of them does", async () => {
    const suite = await Effect.runPromise(
      parity.load({
        cases: { four: { input: 4, checks: { both: [{ above: 9 }, { reads: "x" }] } } },
      }),
    );
    const trial = await Effect.runPromise(suite.runTrial("four", 1).pipe(Effect.provide(stubs)));
    expect(trial.checks).toEqual([
      { name: "is even", pass: true },
      { name: "both", pass: false, note: expect.stringContaining("Expected: > 9") },
    ]);
  });

  test("a dataset must fit the eval's input and check kinds, with no unknown keys", async () => {
    expect(await loadError({ cases: { two: { input: "two" } } })).toContain("Expected number");
    expect(
      await loadError({ cases: { two: { input: 2, checks: { x: { below: 1 } } } } }),
    ).toContain("below");
    expect(
      await loadError({ cases: { two: { input: 2, checks: { x: { above: "1" } } } } }),
    ).toContain("Expected number");
    expect(await loadError({ cases: { two: { input: 2, notes: "?" } } })).toContain("notes");
  });

  test("the JSON Schema describes the same datasets", () => {
    expect(datasetJsonSchema(parity)).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: { cases: { additionalProperties: { required: ["input"] } } },
    });
  });
});

describe("the evals in evals/", () => {
  test("every dataset decodes, and has cases", async () => {
    const evals = await Effect.runPromise(loadEvals);
    expect(evals.map((each) => each.name)).toEqual([
      "agent",
      "assistant",
      "decide",
      "namer",
      "planner",
      "progress",
      "thread-namer",
    ]);
    for (const each of evals) {
      expect(each.suite.caseNames.length).toBeGreaterThan(0);
      // `mise run eval` writes these for editors before every run.
      expect(datasetJsonSchema(each.eval)).toHaveProperty("properties.cases");
    }
  });
});
