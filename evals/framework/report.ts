import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  casePassRate,
  checkPassRate,
  durationLabel,
  evalPassed,
  trialPassed,
  type EvalResult,
} from "./eval.ts";

/** What a run prints, and the results it keeps in `evals/results/` to compare the next run with. */

const resultsDir = join(import.meta.dir, "..", "results");

export interface SavedRun {
  readonly startedAt: string;
  readonly trials: number;
  readonly evals: ReadonlyArray<EvalResult>;
}

export const percent = (rate: number) => `${Math.round(rate * 100)}%`;

export const latestRun = Effect.promise(async (): Promise<SavedRun | undefined> => {
  const files = await readdir(resultsDir).catch(() => []);
  const latest = files
    .filter((file) => file.endsWith(".json"))
    .sort()
    .at(-1);
  return latest === undefined ? undefined : Bun.file(join(resultsDir, latest)).json();
});

export const saveRun = (run: SavedRun) =>
  Effect.promise(async () => {
    const file = join(resultsDir, `${run.startedAt.replaceAll(":", "-")}.json`);
    await mkdir(resultsDir, { recursive: true });
    await Bun.write(file, JSON.stringify(run, null, 2));
    return file;
  });

const change = (now: number, before: number | undefined) => {
  if (before === undefined || before === now) {
    return "";
  }
  return now > before ? `  ▲ from ${percent(before)}` : `  ▼ from ${percent(before)}`;
};

/** Indents a note, which may be an `expect` diff over several lines. */
const indented = (note: string, prefix: string) =>
  note
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, 8)
    .map((line) => `${prefix}${line}`)
    .join("\n");

export const printResult = (result: EvalResult, previous: EvalResult | undefined) =>
  Effect.gen(function* () {
    const passed = result.cases.filter((each) => casePassRate(each) === 1).length;
    yield* Console.log(
      `\n${evalPassed(result) ? "✓" : "✗"} ${result.name}: ${passed}/${result.cases.length} cases passed every trial, ${percent(checkPassRate(result.cases))} of checks passed (minimum ${percent(result.minimum)})`,
    );
    for (const each of result.cases) {
      const rate = casePassRate(each);
      const before = previous?.cases.find((other) => other.name === each.name);
      const millis = each.trials.reduce((sum, trial) => sum + trial.millis, 0) / each.trials.length;
      yield* Console.log(
        `  ${rate === 1 ? "✓" : "✗"} ${each.name.padEnd(28)} ${percent(rate).padStart(4)}  ${durationLabel(Math.round(millis)).padStart(8)}${change(rate, before === undefined ? undefined : casePassRate(before))}`,
      );
      for (const trial of each.trials.filter((candidate) => !trialPassed(candidate))) {
        const label = each.trials.length > 1 ? `trial ${trial.trial}: ` : "";
        if (trial.error !== undefined) {
          yield* Console.log(indented(`${label}error: ${trial.error}`, "      "));
          continue;
        }
        for (const failed of trial.checks.filter((candidate) => !candidate.pass)) {
          yield* Console.log(`      ${label}✗ ${failed.name}`);
          if (failed.note !== undefined) {
            yield* Console.log(indented(failed.note, "          "));
          }
        }
      }
    }
  });
