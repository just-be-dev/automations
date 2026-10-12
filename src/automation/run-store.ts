/** Persists application run records, serializes progress updates, and settles status from engine outcomes. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { DurableEngine } from "../workflow/durable-engine.ts";
import type { ExecutionId } from "../workflow/execution.ts";
import { RunStopped, StepFailed, type StepEvent } from "../workflow/interpreter.ts";
import { Run, RunId, type HumanTask } from "../workflow/run.ts";
import { AutomationHost, decodeStored } from "./host.ts";

/** The application record with its ID branded internally; its persisted/wire shape is unchanged. */
export const StoredRun = Schema.Struct({ ...Run.fields, id: RunId });
export type StoredRun = typeof StoredRun.Type;

const runPrefix = "run:";
const runKey = (id: RunId) => `${runPrefix}${id}`;
const executionKey = (id: ExecutionId) => `execution:${id}`;
const decodeRunId = Schema.decodeUnknownEffect(Schema.UndefinedOr(RunId));
const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(StoredRun));

const causeMessage = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause);
  return failure instanceof StepFailed
    ? `Step ${failure.step} failed: ${failure.message}`
    : Cause.pretty(cause);
};

/**
 * Owns application run records and their execution lookup, not the `wf:` replay journal.
 * Reports update what people see. Only an engine outcome settles the run's overall status.
 */
export const makeRunStore = Effect.fn("Automation.makeRunStore")(function* () {
  const { storage } = yield* AutomationHost;
  const read = (id: RunId) => storage.get(runKey(id)).pipe(Effect.flatMap(decodeStored(StoredRun)));
  const write = (run: StoredRun) => storage.put(runKey(run.id), run);

  // Steps in parallel branches report at the same time, so updates to a run take turns.
  const lock = Semaphore.makeUnsafe(1);
  const update = (id: RunId, transform: (run: StoredRun) => StoredRun) =>
    lock.withPermit(
      Effect.gen(function* () {
        const run = yield* read(id);
        if (run === undefined) {
          return;
        }
        const next = transform(run);
        if (next !== run) {
          yield* write(next);
        }
      }),
    );

  const report = (event: StepEvent) =>
    update(event.runId, (run) => {
      const current = run.steps[event.step];
      // A replay reports finished steps again on its way through them.
      if (current?.status === "done" && event.status !== "done") {
        return run;
      }
      const steps = {
        ...run.steps,
        [event.step]:
          event.record === undefined
            ? { status: event.status }
            : { status: event.status, record: event.record },
      };
      const tasks =
        event.status === "done"
          ? run.tasks.map((task): HumanTask =>
              task.step === event.step ? { ...task, status: "closed" } : task,
            )
          : run.tasks;
      return { ...run, steps, tasks };
    });

  const settle = (id: RunId, result: Effect.Success<ReturnType<DurableEngine["replay"]>>) =>
    update(id, (run): StoredRun => {
      if (result === undefined) {
        return run;
      }
      if (result._tag === "Suspended") {
        return { ...run, status: "waiting" };
      }
      // A run that ended answers no more tasks, such as those in branches a stop step cut off.
      const ended = {
        ...run,
        tasks: run.tasks.map((task): HumanTask => ({ ...task, status: "closed" })),
      };
      if (Exit.isSuccess(result.exit)) {
        return { ...ended, status: "completed" };
      }
      const failure = Cause.squash(result.exit.cause);
      return failure instanceof RunStopped
        ? { ...ended, status: "stopped", stopReason: failure.reason }
        : { ...ended, status: "failed", error: causeMessage(result.exit.cause) };
    });

  const all = storage.list({ prefix: runPrefix }).pipe(
    Effect.flatMap((entries) => decodeRuns([...entries.values()])),
    Effect.orDie,
    Effect.map((runs) => runs.toSorted((left, right) => right.startedAt - left.startedAt)),
  );

  return {
    read,
    write,
    update,
    report,
    settle,
    all,
    linkExecution: (executionId: ExecutionId, runId: RunId) =>
      storage.put(executionKey(executionId), runId),
    runForExecution: (id: ExecutionId) =>
      storage.get(executionKey(id)).pipe(Effect.flatMap(decodeRunId), Effect.orDie),
  };
});
