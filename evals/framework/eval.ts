/** Defines eval cases and runs repeated trials with named checks, failure capture, and pass rates. */

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { basename, join } from "node:path";
import type { Call } from "./call.ts";

/**
 * Defining and running evals. An eval (`evals/<name>.eval.ts`) sends each case's input to one LLM
 * call (`evals/calls/`) and runs named checks on what comes back. Models aren't deterministic, so
 * a case can run several trials, and an eval passes when enough of its checks pass.
 */

export class CallFailed extends Schema.TaggedError<CallFailed>()("CallFailed", {
  message: Schema.String,
}) {}

export class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {
  message: Schema.String,
}) {}

/** The Evals Worker (`worker.ts`), which runs the calls and the judge on the real models. */
export class EvalWorker extends Context.Service<
  EvalWorker,
  {
    readonly call: <I, O>(call: Call<I, O>, input: I) => Effect.Effect<O, CallFailed>;
    /** Fails with the judge's reason when the criterion doesn't hold, or it can't grade. */
    readonly judge: (criterion: string, material: string) => Effect.Effect<void, CheckFailed>;
  }
>()("evals/EvalWorker") {}

/**
 * One assertion about an output. It fails by throwing, usually through `expect` from `bun:test`,
 * or, for checks a model grades (`judged`), with an Effect that fails.
 */
export type Check<I, O> = (
  output: O,
  input: I,
) => void | Effect.Effect<void, CheckFailed, EvalWorker>;

/** A check the LLM judge grades, on the material `present` makes of the output. */
export const judged =
  <I, O>(criterion: string, present: (output: O, input: I) => string): Check<I, O> =>
  (output, input) =>
    EvalWorker.use((worker) => worker.judge(criterion, present(output, input)));

/** Checks by name. */
export type Checks<I, O> = Readonly<Record<string, Check<I, O>>>;

export interface EvalDefinition<I, O> {
  readonly call: Call<I, O>;
  /**
   * The share of checks, across every case and trial, that must pass. Set it a little under what
   * the models reach, so a regression fails the run and model noise doesn't.
   */
  readonly minimum: number;
  /** Checks that apply to every case. */
  readonly every?: Checks<I, O>;
  /** Cases by name. */
  readonly cases: Readonly<Record<string, { readonly input: I; readonly checks?: Checks<I, O> }>>;
}

export interface CheckResult {
  readonly name: string;
  readonly pass: boolean;
  /** Why it failed, or what the judge said. */
  readonly note?: string;
}

export interface TrialResult {
  readonly trial: number;
  readonly millis: number;
  readonly output?: unknown;
  /** The call failed, so every check did. */
  readonly error?: string;
  readonly checks: ReadonlyArray<CheckResult>;
}

export interface CaseResult {
  readonly name: string;
  readonly trials: ReadonlyArray<TrialResult>;
}

export interface EvalResult {
  readonly name: string;
  readonly minimum: number;
  readonly cases: ReadonlyArray<CaseResult>;
}

const messageOf = (error: unknown) =>
  Bun.stripANSI(
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error),
  );

/** Outputs are kept in the results file, so they become plain JSON. */
const plain = (output: unknown): unknown => JSON.parse(JSON.stringify(output ?? null));

const runCheck = <I, O>(check: Check<I, O>, output: O, input: I) =>
  Effect.try({
    try: () => check(output, input),
    catch: (error) => new CheckFailed({ message: messageOf(error) }),
  }).pipe(
    Effect.flatMap((result) => (Effect.isEffect(result) ? result : Effect.void)),
    Effect.match({
      onFailure: (failed): Omit<CheckResult, "name"> => ({ pass: false, note: failed.message }),
      onSuccess: (): Omit<CheckResult, "name"> => ({ pass: true }),
    }),
  );

/** An eval with its input and output types hidden, so evals of different calls run together. */
export class Eval {
  constructor(
    readonly minimum: number,
    readonly caseNames: ReadonlyArray<string>,
    readonly runTrial: (
      caseName: string,
      trial: number,
    ) => Effect.Effect<TrialResult, never, EvalWorker>,
  ) {}
}

export const defineEval = <I, O>(definition: EvalDefinition<I, O>): Eval => {
  const trialFailure = (caseName: string, trial: number, millis: number, error: string) => {
    const found = definition.cases[caseName];
    const checks = Object.keys({ ...definition.every, ...found?.checks });
    return {
      trial,
      millis,
      error,
      checks: checks.map((name) => ({ name, pass: false, note: error })),
    } satisfies TrialResult;
  };
  const runTrial = Effect.fn("Eval.trial")(
    function* (caseName: string, trial: number) {
      yield* Effect.annotateCurrentSpan({ case: caseName, trial });
      const found = definition.cases[caseName];
      if (found === undefined) {
        return trialFailure(caseName, trial, 0, `No case ${caseName}`);
      }
      const checks = Object.entries({ ...definition.every, ...found.checks });
      const started = yield* Clock.currentTimeMillis;
      const outcome = yield* EvalWorker.use((worker) =>
        worker.call(definition.call, found.input),
      ).pipe(
        Effect.timeoutOrElse({
          duration: definition.call.timeout,
          orElse: () => Effect.fail({ message: "Timed out" }),
        }),
        Effect.result,
      );
      const millis = (yield* Clock.currentTimeMillis) - started;
      if (outcome._tag === "Failure") {
        return trialFailure(caseName, trial, millis, messageOf(outcome.failure));
      }
      const results = yield* Effect.forEach(
        checks,
        ([name, check]) =>
          runCheck(check, outcome.success, found.input).pipe(
            Effect.map((result) => ({ name, ...result })),
          ),
        { concurrency: "unbounded" },
      );
      return {
        trial,
        millis,
        output: plain(outcome.success),
        checks: results,
      } satisfies TrialResult;
    },
    // A defect shows up as a failed trial instead of stopping the other evals.
    (effect, caseName, trial) =>
      Effect.catchCause(effect, (cause) =>
        Effect.succeed(
          trialFailure(caseName, trial, 0, `Crashed: ${messageOf(Cause.squash(cause))}`),
        ),
      ),
  );
  return new Eval(definition.minimum, Object.keys(definition.cases), runTrial);
};

export interface RunOptions {
  readonly trials: number;
  readonly concurrency: number;
  /** Runs only the cases whose name contains this. */
  readonly filter?: string;
}

/** The cases whose name contains `filter`, or every case. */
export const matchingCases = (target: Eval, filter: string | undefined) =>
  target.caseNames.filter((name) => filter === undefined || name.includes(filter));

export const runEval = Effect.fn("Eval.run")(function* (
  name: string,
  target: Eval,
  options: RunOptions,
) {
  yield* Effect.annotateCurrentSpan({ eval: name });
  const names = matchingCases(target, options.filter);
  const jobs = names.flatMap((caseName) =>
    Array.from({ length: options.trials }, (_, trial) => ({ caseName, trial: trial + 1 })),
  );
  const results = yield* Effect.forEach(
    jobs,
    ({ caseName, trial }) =>
      target.runTrial(caseName, trial).pipe(Effect.map((result) => ({ caseName, result }))),
    { concurrency: options.concurrency },
  );
  const cases: ReadonlyArray<CaseResult> = names.map((caseName) => ({
    name: caseName,
    trials: results.flatMap((each) => (each.caseName === caseName ? [each.result] : [])),
  }));
  return { name, minimum: target.minimum, cases } satisfies EvalResult;
});

/** A trial passes when its call succeeded and every check passed. */
export const trialPassed = (trial: TrialResult) =>
  trial.error === undefined && trial.checks.every((each) => each.pass);

export const casePassRate = (result: CaseResult) =>
  result.trials.length === 0 ? 0 : result.trials.filter(trialPassed).length / result.trials.length;

export const checkPassRate = (cases: ReadonlyArray<CaseResult>) => {
  const all = cases.flatMap((each) => each.trials.flatMap((trial) => trial.checks));
  return all.length === 0 ? 0 : all.filter((each) => each.pass).length / all.length;
};

export const evalPassed = (result: EvalResult) => checkPassRate(result.cases) >= result.minimum;

export const durationLabel = (millis: number) => Duration.format(Duration.millis(millis));

export class InvalidEval extends Schema.TaggedError<InvalidEval>()("InvalidEval", {
  message: Schema.String,
}) {}

/** Every `evals/<name>.eval.ts`, by name, in name order. Each must export a `defineEval` default. */
export const loadEvals = Effect.gen(function* () {
  const dir = join(import.meta.dir, "..");
  const files = yield* Effect.promise(() => Array.fromAsync(new Bun.Glob("*.eval.ts").scan(dir)));
  return yield* Effect.forEach(files.toSorted(), (file) =>
    Effect.promise(() => import(join(dir, file))).pipe(
      Effect.flatMap((module: { readonly default?: unknown }) =>
        module.default instanceof Eval
          ? Effect.succeed({ name: basename(file, ".eval.ts"), eval: module.default })
          : Effect.fail(
              new InvalidEval({ message: `${file} must export default defineEval({ … })` }),
            ),
      ),
    ),
  );
});
