/** Defines evals, loads their datasets, and runs repeated trials with named checks, failure capture, and pass rates. */

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { Call } from "./call.ts";

/**
 * Defining and running evals. An eval (`evals/<name>.eval.ts`) is the test: it sends each case's
 * input to one LLM call (`evals/calls/`) and runs named checks on what comes back. Its cases are
 * the dataset (`evals/datasets/<name>.yaml`): inputs, and the checks each asks for from the kinds
 * the eval defines. Models aren't deterministic, so a case can run several trials, and an eval
 * passes when enough of its checks pass.
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

/**
 * One kind of check a dataset can ask for. A case names it by its key in the eval's `checks`, with
 * a value `value` decodes, and `check` makes the check from that value.
 */
export interface CheckKind<A, I, O> {
  readonly value: Schema.Codec<A, unknown>;
  readonly check: (value: A) => Check<I, O>;
}

export interface EvalDefinition<I, O, K> {
  readonly call: Call<I, O>;
  /**
   * The share of checks, across every case and trial, that must pass. Set it a little under what
   * the models reach, so a regression fails the run and model noise doesn't. It belongs to the
   * eval, not its dataset, so a dataset can't lower the bar.
   */
  readonly minimum: number;
  /** Checks that apply to every case. */
  readonly every?: Checks<I, O>;
  /** The kinds of check a case in the dataset can ask for, by the key that names them. */
  readonly checks: { readonly [N in keyof K]: CheckKind<K[N], I, O> };
}

/** One case of a dataset, decoded: the call's input, and its checks by name. */
interface Case<I> {
  readonly input: I;
  /** Each check is one kind, `{ <kind>: <value> }`, or a list of them that must all hold. */
  readonly checks?: Readonly<Record<string, Request | ReadonlyArray<Request>>>;
}

/** A check a case asks for: one key, naming the kind, with its value. */
type Request = Readonly<Record<string, unknown>>;

export interface Dataset<I> {
  readonly cases: Readonly<Record<string, Case<I>>>;
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

export class InvalidDataset extends Schema.TaggedError<InvalidDataset>()("InvalidDataset", {
  message: Schema.String,
}) {}

/** Datasets are read strictly, so a misspelt key is an error rather than a check that never runs. */
const strict = { onExcessProperty: "error" } as const;

/** An eval's cases, ready to run, with their input and output types hidden. */
export interface Suite {
  readonly minimum: number;
  /** How long one trial may take, in milliseconds. */
  readonly timeoutMillis: number;
  readonly caseNames: ReadonlyArray<string>;
  readonly runTrial: (
    caseName: string,
    trial: number,
  ) => Effect.Effect<TrialResult, never, EvalWorker>;
}

/** An eval: a call, the checks it can make, and the bar it must reach. Its cases are a dataset. */
export class Eval<I = unknown> {
  constructor(
    readonly minimum: number,
    /** What a dataset for this eval holds. */
    readonly dataset: Schema.Codec<Dataset<I>, unknown>,
    private readonly suiteOf: (dataset: Dataset<I>) => Suite,
  ) {}

  /** Decodes a dataset, as parsed from YAML or JSON. */
  decode(raw: unknown): Effect.Effect<Dataset<I>, InvalidDataset> {
    return Schema.decodeUnknownEffect(this.dataset)(raw, strict).pipe(
      Effect.mapError((error) => new InvalidDataset({ message: error.message })),
    );
  }

  /** Decodes a dataset into the cases this eval runs. */
  load(raw: unknown): Effect.Effect<Suite, InvalidDataset> {
    return this.decode(raw).pipe(Effect.map((dataset) => this.suiteOf(dataset)));
  }
}

const datasetOf = <I, O>(
  call: Call<I, O>,
  kinds: Readonly<Record<string, CheckKind<unknown, I, O>>>,
): Schema.Codec<Dataset<I>, unknown> => {
  const request = Schema.Union(
    Object.entries(kinds).map(([kind, { value }]) =>
      Schema.Struct({ [kind]: value }).annotate({ title: kind }),
    ),
  );
  const unchecked: Schema.Codec<unknown, unknown> = Schema.Struct({
    cases: Schema.Record(
      Schema.String,
      Schema.Struct({
        input: call.input,
        checks: Schema.optionalKey(
          Schema.Record(Schema.String, Schema.Union([request, Schema.Array(request)])).annotate({
            description: "Checks by name. Each is one kind of check, or a list that must all hold.",
          }),
        ),
      }),
    ),
  });
  // The kinds' keys are only known at run time, so the decoded type is asserted here.
  return unchecked as Schema.Codec<Dataset<I>, unknown>;
};

export const defineEval = <I, O, K>(definition: EvalDefinition<I, O, K>): Eval<I> => {
  const kinds = definition.checks as Readonly<Record<string, CheckKind<unknown, I, O>>>;
  /** The check one request makes; the dataset's Schema decoded its value with the kind's. */
  const checkOf = (request: Request): Check<I, O> => {
    const [kind, value] = Object.entries(request)[0] ?? [];
    const found = kind === undefined ? undefined : kinds[kind];
    if (found === undefined) {
      throw new Error(`No check kind ${kind}`);
    }
    return found.check(value);
  };
  const checksOf = (found: Case<I>): Checks<I, O> => ({
    ...definition.every,
    ...Object.fromEntries(
      Object.entries(found.checks ?? {}).map(([name, requests]): [string, Check<I, O>] => {
        const all = (Array.isArray(requests) ? requests : [requests]).map(checkOf);
        // Plain checks throw here, inside `runCheck`; the judged ones run after.
        return [
          name,
          (output, input) =>
            Effect.all(
              all.map((check) => check(output, input)).filter((result) => Effect.isEffect(result)),
              { discard: true },
            ),
        ];
      }),
    ),
  });
  const suiteOf = (dataset: Dataset<I>): Suite => {
    const cases = dataset.cases;
    const trialFailure = (caseName: string, trial: number, millis: number, error: string) => {
      const found = cases[caseName];
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
        const found = cases[caseName];
        if (found === undefined) {
          return trialFailure(caseName, trial, 0, `No case ${caseName}`);
        }
        const checks = Object.entries(checksOf(found));
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
    return {
      minimum: definition.minimum,
      timeoutMillis: Duration.toMillis(definition.call.timeout),
      caseNames: Object.keys(cases),
      runTrial,
    };
  };
  return new Eval(definition.minimum, datasetOf(definition.call, kinds), suiteOf);
};

export interface RunOptions {
  readonly trials: number;
  /** How many trials run at once, across every eval. */
  readonly concurrency: number;
  /** Runs only the cases whose name contains this. */
  readonly filter?: string;
  /**
   * How long a case's trial is expected to take, such as its time in the last run. Longer trials
   * start first, so a slow one doesn't start last and hold up the end of the run. A case without
   * an estimate counts as its call's timeout.
   */
  readonly estimate?: (evalName: string, caseName: string) => number | undefined;
  /** Runs as soon as each eval's last trial is done, such as to print its result. */
  readonly onEvalDone?: (result: EvalResult) => Effect.Effect<void>;
}

/** The cases whose name contains `filter`, or every case. */
export const matchingCases = (target: Suite, filter: string | undefined) =>
  target.caseNames.filter((name) => filter === undefined || name.includes(filter));

/**
 * Runs the evals' trials from one queue, longest first, so a short eval doesn't wait for a long
 * one and a long eval's few cases don't leave the other slots idle. Results keep the evals' order.
 */
export const runEvals = Effect.fn("Eval.runAll")(function* (
  evals: ReadonlyArray<{ readonly name: string; readonly suite: Suite }>,
  options: RunOptions,
) {
  const planned = evals.map(({ name, suite }) => ({
    name,
    suite,
    caseNames: matchingCases(suite, options.filter),
  }));
  const jobs = planned
    .flatMap(({ name, suite, caseNames }) =>
      caseNames.flatMap((caseName) =>
        Array.from({ length: options.trials }, (_, trial) => ({
          name,
          suite,
          caseName,
          trial: trial + 1,
          expected: options.estimate?.(name, caseName) ?? suite.timeoutMillis,
        })),
      ),
    )
    .toSorted((a, b) => b.expected - a.expected);
  const trials = new Map<
    string,
    Array<{ readonly caseName: string; readonly result: TrialResult }>
  >(planned.map(({ name }) => [name, []]));
  const resultOf = ({ name, suite, caseNames }: (typeof planned)[number]): EvalResult => {
    const done = trials.get(name) ?? [];
    return {
      name,
      minimum: suite.minimum,
      cases: caseNames.map((caseName) => ({
        name: caseName,
        trials: done
          .flatMap((each) => (each.caseName === caseName ? [each.result] : []))
          .toSorted((a, b) => a.trial - b.trial),
      })),
    };
  };
  yield* Effect.forEach(
    jobs,
    ({ name, suite, caseName, trial }) =>
      suite.runTrial(caseName, trial).pipe(
        Effect.annotateSpans({ eval: name }),
        Effect.flatMap((result) => {
          const done = trials.get(name) ?? [];
          done.push({ caseName, result });
          const target = planned.find((each) => each.name === name);
          const finished =
            target !== undefined && done.length === target.caseNames.length * options.trials;
          return finished && options.onEvalDone !== undefined
            ? options.onEvalDone(resultOf(target))
            : Effect.void;
        }),
      ),
    { concurrency: options.concurrency, discard: true },
  );
  return planned.map(resultOf);
});

/** Runs one eval's trials. */
export const runEval = (name: string, suite: Suite, options: RunOptions) =>
  runEvals([{ name, suite }], options).pipe(
    Effect.map(([result]) => result ?? { name, minimum: suite.minimum, cases: [] }),
  );

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

const evalsDir = join(import.meta.dir, "..");

/** Where an eval's dataset lives: `evals/datasets/<name>.yaml`. */
export const datasetPath = (name: string) => join(evalsDir, "datasets", `${name}.yaml`);

/** Where an eval's dataset JSON Schema lives, beside the dataset. */
export const datasetSchemaPath = (name: string) =>
  join(evalsDir, "datasets", `${name}.schema.json`);

/**
 * A JSON Schema for `target`'s datasets, which editors use to check and complete them. The Effect
 * Schema stays the authority: it decodes every dataset before a run.
 */
export const datasetJsonSchema = (target: { readonly dataset: Schema.Constraint }) => {
  const document = Schema.toJsonSchemaDocument(target.dataset, strict);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
  };
};

/** Reads a dataset file, without decoding it. YAML anchors and merge keys (`<<`) are resolved. */
export const readDataset = Effect.fn("Eval.readDataset")(function* (path: string) {
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (error) => new InvalidDataset({ message: `Can't read ${path}: ${messageOf(error)}` }),
  });
  return yield* Effect.try({
    try: (): unknown => parse(text, { merge: true }),
    catch: (error) => new InvalidDataset({ message: `${path}: ${messageOf(error)}` }),
  });
});

/** Reads and decodes a dataset file into the cases `target` runs. */
export const loadDataset = (target: Eval, path: string) =>
  readDataset(path).pipe(
    Effect.flatMap((raw) => target.load(raw)),
    Effect.mapError((error) => new InvalidDataset({ message: `${path}:\n${error.message}` })),
  );

/** Every `evals/<name>.eval.ts`, by name, in name order. Each must export a `defineEval` default. */
export const loadEvalDefinitions = Effect.gen(function* () {
  const files = yield* Effect.promise(() =>
    Array.fromAsync(new Bun.Glob("*.eval.ts").scan(evalsDir)),
  );
  return yield* Effect.forEach(files.toSorted(), (file) =>
    Effect.gen(function* () {
      const module: { readonly default?: unknown } = yield* Effect.promise(
        () => import(join(evalsDir, file)),
      );
      if (!(module.default instanceof Eval)) {
        return yield* new InvalidEval({ message: `${file} must export default defineEval({ … })` });
      }
      return { name: basename(file, ".eval.ts"), eval: module.default };
    }),
  );
});

/** The evals, each with the cases of its dataset, `evals/datasets/<name>.yaml`. */
export const withDatasets = (
  evals: ReadonlyArray<{ readonly name: string; readonly eval: Eval }>,
) =>
  Effect.forEach(evals, (each) =>
    loadDataset(each.eval, datasetPath(each.name)).pipe(
      Effect.map((suite) => ({ ...each, suite })),
    ),
  );

/** Every eval, with the cases of its dataset. */
export const loadEvals = loadEvalDefinitions.pipe(Effect.flatMap(withDatasets));

/**
 * Writes each eval's dataset JSON Schema beside its dataset, as `<name>.schema.json`, for editors.
 * They're generated, so git ignores them; `mise run eval` writes them before it reads a dataset.
 */
export const writeDatasetSchemas = (
  evals: ReadonlyArray<{ readonly name: string; readonly eval: Eval }>,
) =>
  Effect.forEach(
    evals,
    ({ name, eval: target }) =>
      Effect.promise(() =>
        Bun.write(
          datasetSchemaPath(name),
          `${JSON.stringify(datasetJsonSchema(target), null, 2)}\n`,
        ),
      ),
    { discard: true },
  );
