/** Selects and runs eval trials, compares saved results, and fails suites below their minimum. */

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  checkPassRate,
  evalPassed,
  loadEvalDefinitions,
  matchingCases,
  runEvals,
  withDatasets,
  writeDatasetSchemas,
  type EvalResult,
} from "./eval.ts";
import * as Client from "./client.ts";
import { latestRun, percent, printResult, saveRun } from "./report.ts";

/**
 * Runs the evals against Workers AI and prints how often each check passed. It starts the Evals
 * Worker locally first (`client.ts`), which needs the same Cloudflare profile as `mise run dev`.
 *
 *   mise run eval [eval ...] [--trials 3] [--concurrency 4] [--case <name part>] [--no-save]
 *   mise run eval [eval ...] [--case <name part>] --list
 *   mise run eval -- --help
 *
 * Runs every `evals/*.eval.ts` when none is named, on the cases in its `evals/datasets/<name>.yaml`.
 * Every run, `--list` included, first writes each dataset's JSON Schema beside it for editors.
 * Every eval's trials share one queue, `--concurrency` at a time, slowest first. Each run is
 * saved to `evals/results/`, and the report compares each case with the latest saved run. The run fails when an eval passes fewer of
 * its checks than its minimum. `--list` prints the evals and cases that would run, and calls no
 * model.
 */

const positive = (name: string, fallback: number, description: string) =>
  Flag.Int(name).pipe(
    Flag.filter(
      (value) => value >= 1,
      (value) => `--${name} must be at least 1, got ${value}`,
    ),
    Flag.withDefault(fallback),
    Flag.withDescription(description),
  );

const options = {
  names: Argument.String("eval").pipe(
    Argument.variadic(),
    Argument.withDescription("Evals to run, by file name without .eval.ts; every eval when none"),
  ),
  trials: positive("trials", 1, "Times to run each case"),
  concurrency: positive("concurrency", 4, "Trials to run at once, across every eval"),
  case: Flag.String("case").pipe(
    Flag.optional,
    Flag.withDescription("Only run cases whose name contains this text"),
  ),
  save: Flag.Boolean("save").pipe(
    Flag.withDefault(true),
    Flag.withDescription("Save the run to evals/results/ (--no-save to skip)"),
  ),
  list: Flag.Boolean("list").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the evals and cases that would run, without calling a model"),
  ),
};

class UnknownEvals extends Schema.TaggedError<UnknownEvals>()("UnknownEvals", {
  message: Schema.String,
}) {}

class BelowMinimum extends Schema.TaggedError<BelowMinimum>()("BelowMinimum", {
  message: Schema.String,
}) {}

const program = Effect.fn("Evals.run")(function* (
  input: Command.Command.Config.Infer<typeof options>,
) {
  const positionals = input.names;
  const filter = Option.getOrUndefined(input.case);
  // The schemas come first, so an editor can point out what's wrong with a dataset that won't load.
  const definitions = yield* loadEvalDefinitions;
  yield* writeDatasetSchemas(definitions);
  const evals = yield* withDatasets(definitions);
  const unknown = positionals.filter((name) => !evals.some((each) => each.name === name));
  if (unknown.length > 0) {
    return yield* new UnknownEvals({
      message: `Unknown evals: ${unknown.join(", ")}. Choose from ${evals.map((each) => each.name).join(", ")}.`,
    });
  }
  // With --case, an eval none of whose cases match doesn't run, so it can't miss its minimum.
  const chosen = evals.filter(
    (each) =>
      (positionals.length === 0 || positionals.includes(each.name)) &&
      matchingCases(each.suite, filter).length > 0,
  );

  if (input.list) {
    for (const { name, suite: target } of chosen) {
      const cases = matchingCases(target, filter);
      yield* Console.log(
        `${name} (${cases.length} ${cases.length === 1 ? "case" : "cases"}, minimum ${percent(target.minimum)})`,
      );
      yield* Effect.forEach(cases, (caseName) => Console.log(`  ${caseName}`));
    }
    return;
  }

  const { trials, concurrency } = input;
  const previous = yield* latestRun;
  const startedAt = new Date().toISOString();
  const previousCase = (name: string, caseName: string) =>
    previous?.evals
      .find((each) => each.name === name)
      ?.cases.find((each) => each.name === caseName);
  const jobs = chosen.reduce(
    (sum, { suite }) => sum + matchingCases(suite, filter).length * trials,
    0,
  );
  yield* Console.log(
    `Running ${jobs} ${jobs === 1 ? "trial" : "trials"} of ${chosen.length} ${chosen.length === 1 ? "eval" : "evals"}, ${concurrency} at a time…`,
  );
  const results = yield* runEvals(chosen, {
    trials,
    concurrency,
    ...(filter === undefined ? {} : { filter }),
    // The last run's mean time for the case, when it has one.
    estimate: (name, caseName) => {
      const times = previousCase(name, caseName)?.trials.map((trial) => trial.millis) ?? [];
      return times.length === 0
        ? undefined
        : times.reduce((sum, millis) => sum + millis, 0) / times.length;
    },
    onEvalDone: (result) =>
      printResult(
        result,
        previous?.evals.find((other) => other.name === result.name),
      ),
  }).pipe(Effect.provide(Client.layer));

  if (input.save) {
    const file = yield* saveRun({ startedAt, trials, evals: results });
    yield* Console.log(`\nSaved ${file}`);
  }

  const below = results.filter((result: EvalResult) => !evalPassed(result));
  if (below.length > 0) {
    return yield* new BelowMinimum({
      message: `Below their minimum: ${below.map((result) => `${result.name} (${percent(checkPassRate(result.cases))} < ${percent(result.minimum)})`).join(", ")}`,
    });
  }
});

Command.make("eval", options, program).pipe(
  Command.withDescription(
    "Run the evals against Workers AI and report how often each check passed",
  ),
  Command.run({ version: "0.0.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
