/** Selects and runs eval trials, compares saved results, and fails suites below their minimum. */

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseArgs } from "node:util";
import {
  checkPassRate,
  evalPassed,
  loadEvals,
  matchingCases,
  runEval,
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
 *
 * Runs every `evals/*.eval.ts` when none is named. Each run is saved to `evals/results/`, and the
 * report compares each case with the latest saved run. The run fails when an eval passes fewer of
 * its checks than its minimum. `--list` prints the evals and cases that would run, and calls no
 * model.
 */

const { values: flags, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    trials: { type: "string", default: "1" },
    concurrency: { type: "string", default: "4" },
    case: { type: "string" },
    "no-save": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
  },
});

class UnknownEvals extends Schema.TaggedError<UnknownEvals>()("UnknownEvals", {
  message: Schema.String,
}) {}

class BelowMinimum extends Schema.TaggedError<BelowMinimum>()("BelowMinimum", {
  message: Schema.String,
}) {}

const program = Effect.gen(function* () {
  const evals = yield* loadEvals;
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
      matchingCases(each.eval, flags.case).length > 0,
  );

  if (flags.list) {
    for (const { name, eval: target } of chosen) {
      const cases = matchingCases(target, flags.case);
      yield* Console.log(
        `${name} (${cases.length} ${cases.length === 1 ? "case" : "cases"}, minimum ${percent(target.minimum)})`,
      );
      yield* Effect.forEach(cases, (caseName) => Console.log(`  ${caseName}`));
    }
    return;
  }

  const trials = Math.max(1, Number(flags.trials) || 1);
  const concurrency = Math.max(1, Number(flags.concurrency) || 1);
  const previous = yield* latestRun;
  const startedAt = new Date().toISOString();
  const results = yield* Effect.forEach(chosen, ({ name, eval: target }) =>
    Effect.gen(function* () {
      yield* Console.log(`Running ${name}…`);
      const result = yield* runEval(name, target, {
        trials,
        concurrency,
        ...(flags.case === undefined ? {} : { filter: flags.case }),
      });
      yield* printResult(
        result,
        previous?.evals.find((other) => other.name === name),
      );
      return result;
    }),
  ).pipe(Effect.provide(Client.layer));

  if (!flags["no-save"]) {
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

program.pipe(BunRuntime.runMain);
