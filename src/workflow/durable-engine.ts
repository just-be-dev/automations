/** Journals workflow activities, deferreds, and clocks in a key-value store and replays executions on host wakeups. */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { DurableClock, Workflow, WorkflowEngine } from "effect/workflow";
import { ExecutionId } from "./execution.ts";

/**
 * A replaying `effect/workflow` engine whose journal lives in a key-value store, such as a Durable
 * Object's storage. It doesn't keep runs alive between events: a replay runs the workflow from the
 * start, reusing every recorded Activity result and DurableDeferred completion, until it completes
 * or reaches something it has to wait for, and then returns. The host decides when to replay:
 * `wake` asks for one soon, and `wakeAt` asks for a durable clock to fire at a time.
 *
 * Journal keys, all prefixed with `wf:<executionId>:`, are persisted contracts:
 * `payload`, `result`, `interrupted`, `activity:<name>:<attempt>`, `deferred:<name>`, and
 * `clock:<name>`.
 * This journal is authoritative for replay; application run records are never read here.
 */
export interface EngineStore {
  readonly get: (key: string) => Effect.Effect<unknown>;
  readonly put: (key: string, value: unknown) => Effect.Effect<void>;
  /** Asks the host to replay the execution soon. */
  readonly wake: (executionId: ExecutionId) => Effect.Effect<void>;
  /** Asks the host to call `fireClock` for this deferred at `at`, in epoch milliseconds. */
  readonly wakeAt: (options: {
    readonly executionId: ExecutionId;
    readonly deferredName: string;
    readonly at: number;
  }) => Effect.Effect<void>;
}

export interface DurableEngine {
  readonly engine: WorkflowEngine.WorkflowEngine["Service"];
  /**
   * Runs the execution until it completes or suspends. Replays of one execution never overlap.
   * Returns `undefined` for an execution that was never started.
   */
  readonly replay: (
    workflow: Workflow.Any,
    executionId: ExecutionId,
  ) => Effect.Effect<Workflow.Result<unknown, unknown> | undefined>;
  /** Completes a durable clock's deferred, which wakes its execution. */
  readonly fireClock: (
    workflow: Workflow.Any,
    executionId: ExecutionId,
    deferredName: string,
  ) => Effect.Effect<void>;
  /**
   * When the named clock wakes its execution, in epoch milliseconds, and the deferred `fireClock`
   * completes for it. `undefined` unless the clock is scheduled and hasn't fired yet.
   */
  readonly pendingClock: (
    executionId: ExecutionId,
    clockName: string,
  ) => Effect.Effect<{ readonly at: number; readonly deferredName: string } | undefined>;
}

/** The deferred a durable clock completes when it fires, as `DurableClock` names it. */
const clockDeferredName = (clockName: string) =>
  DurableClock.make({ name: clockName, duration: 0 }).deferred.name;

/** Activity results and deferred completions, with their values already JSON-encoded. */
const StoredExit = Schema.toCodecJson(Schema.Exit(Schema.Json, Schema.Json, Schema.Defect()));
const encodeExit = (exit: Exit.Exit<unknown, unknown>) =>
  Schema.encodeUnknownEffect(StoredExit)(Exit.map(exit, (value) => value ?? null)).pipe(
    Effect.orDie,
  );
const decodeExit = (value: unknown) =>
  Schema.decodeUnknownEffect(StoredExit)(value).pipe(Effect.orDie);

const decodeWakeTime = Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.Finite));

const payloadCodec = (workflow: Workflow.Any) => Schema.toCodecJson(workflow.payloadSchema);
const resultCodec = (workflow: Workflow.Any) =>
  Schema.toCodecJson(
    Workflow.Complete.Schema({ success: workflow.successSchema, error: workflow.errorSchema }),
  );

// NOTE: type-erased workflow schemas could need services to encode or decode. RunAutomation's
// schemas need none, and the engine runs nothing else.
const withoutServices = <A>(effect: Effect.Effect<A, Schema.SchemaError, unknown>) =>
  Effect.orDie(effect) as Effect.Effect<A>;

const keys = {
  payload: (id: string) => `wf:${id}:payload`,
  result: (id: string) => `wf:${id}:result`,
  interrupted: (id: string) => `wf:${id}:interrupted`,
  activity: (id: string, name: string, attempt: number) => `wf:${id}:activity:${name}:${attempt}`,
  deferred: (id: string, name: string) => `wf:${id}:deferred:${name}`,
  clock: (id: string, name: string) => `wf:${id}:clock:${name}`,
};

type Execute = (
  payload: object,
  executionId: string,
) => Effect.Effect<
  unknown,
  unknown,
  WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
>;

export const makeDurableEngine = (store: EngineStore): DurableEngine => {
  const registered = new Map<string, Execute>();
  const deferredState = WorkflowEngine.makeDeferredState();
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (executionId: string) => {
    const existing = locks.get(executionId);
    if (existing !== undefined) {
      return existing;
    }
    const created = Semaphore.makeUnsafe(1);
    locks.set(executionId, created);
    return created;
  };

  const readResult = (workflow: Workflow.Any, executionId: string) =>
    store
      .get(keys.result(executionId))
      .pipe(
        Effect.flatMap((stored) =>
          stored === undefined
            ? Effect.succeed(undefined)
            : withoutServices(Schema.decodeUnknownEffect(resultCodec(workflow))(stored)),
        ),
      );

  const writeResult = (
    workflow: Workflow.Any,
    executionId: string,
    result: Workflow.Complete<unknown, unknown>,
  ) =>
    withoutServices(Schema.encodeUnknownEffect(resultCodec(workflow))(result)).pipe(
      Effect.flatMap((encoded) => store.put(keys.result(executionId), encoded)),
    );

  const deferredDone = (options: {
    readonly executionId: string;
    readonly deferredName: string;
    readonly exit: Exit.Exit<unknown, unknown>;
  }) =>
    Effect.gen(function* () {
      const key = keys.deferred(options.executionId, options.deferredName);
      if ((yield* store.get(key)) !== undefined) {
        return;
      }
      yield* store.put(key, yield* encodeExit(options.exit));
      yield* store.wake(ExecutionId.make(options.executionId));
    });

  const engine = WorkflowEngine.makeUnsafe({
    register: (workflow, execute) =>
      Effect.sync(() => {
        registered.set(workflow._tag, execute);
      }),
    execute: (workflow, options) =>
      Effect.gen(function* () {
        // Effect Workflow's interface uses plain strings. Brand its IDs at this boundary.
        const executionId = ExecutionId.make(options.executionId);
        const key = keys.payload(executionId);
        if ((yield* store.get(key)) === undefined) {
          const payload = yield* withoutServices(
            Schema.encodeUnknownEffect(payloadCodec(workflow))(options.payload),
          );
          yield* store.put(key, payload);
        }
        if (options.discard) {
          yield* store.wake(executionId);
          return;
        }
        const result = yield* replay(workflow, executionId);
        return result ?? new Workflow.Suspended({});
      }) as never,
    poll: (workflow, executionId) =>
      readResult(workflow, executionId).pipe(Effect.map(Option.fromNullishOr)),
    interrupt: (_workflow, executionId) =>
      store
        .put(keys.interrupted(executionId), true)
        .pipe(Effect.andThen(store.wake(ExecutionId.make(executionId)))),
    interruptUnsafe: (_workflow, executionId) =>
      store
        .put(keys.interrupted(executionId), true)
        .pipe(Effect.andThen(store.wake(ExecutionId.make(executionId)))),
    resume: (_workflow, executionId) => store.wake(ExecutionId.make(executionId)),
    activityExecute: (activity, attempt) =>
      Effect.gen(function* () {
        const instance = yield* WorkflowEngine.WorkflowInstance;
        const key = keys.activity(instance.executionId, activity.name, attempt);
        const stored = yield* store.get(key);
        if (stored !== undefined) {
          return new Workflow.Complete({ exit: yield* decodeExit(stored) });
        }
        const activityInstance = WorkflowEngine.WorkflowInstance.initial(
          instance.workflow,
          instance.executionId,
        );
        activityInstance.interrupted = instance.interrupted;
        const result = yield* activity.executeEncoded.pipe(
          Workflow.intoResult,
          Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
        );
        // An interrupted attempt has no result to keep; the next replay runs it again.
        if (
          result._tag === "Complete" &&
          !(Exit.isFailure(result.exit) && Cause.hasInterrupts(result.exit.cause))
        ) {
          yield* store.put(key, yield* encodeExit(result.exit));
        }
        return result;
      }),
    deferredResult: (deferred) =>
      Effect.gen(function* () {
        const instance = yield* WorkflowEngine.WorkflowInstance;
        const stored = yield* store.get(keys.deferred(instance.executionId, deferred.name));
        return stored === undefined ? Option.none() : Option.some(yield* decodeExit(stored));
      }),
    deferredDone,
    scheduleClock: (_workflow, options) =>
      Effect.gen(function* () {
        const key = keys.clock(options.executionId, options.clock.name);
        // A replay reaches the same clock again; keep the first wake time.
        if ((yield* store.get(key)) !== undefined) {
          return;
        }
        const at = (yield* Clock.currentTimeMillis) + Duration.toMillis(options.clock.duration);
        yield* store.put(key, at);
        yield* store.wakeAt({
          executionId: ExecutionId.make(options.executionId),
          deferredName: options.clock.deferred.name,
          at,
        });
      }),
  });

  const replay = (workflow: Workflow.Any, executionId: ExecutionId) =>
    lockFor(executionId).withPermit(
      Effect.gen(function* () {
        const finished = yield* readResult(workflow, executionId);
        if (finished !== undefined) {
          return finished as Workflow.Result<unknown, unknown>;
        }
        const execute = registered.get(workflow._tag);
        if (execute === undefined) {
          return yield* Effect.die(`Workflow ${workflow._tag} is not registered`);
        }
        const stored = yield* store.get(keys.payload(executionId));
        if (stored === undefined) {
          return undefined;
        }
        if ((yield* store.get(keys.interrupted(executionId))) === true) {
          const interrupted = new Workflow.Complete({ exit: Exit.interrupt() });
          yield* writeResult(workflow, executionId, interrupted);
          return interrupted;
        }
        const payload = yield* withoutServices(
          Schema.decodeUnknownEffect(payloadCodec(workflow))(stored),
        );
        const instance = WorkflowEngine.WorkflowInstance.initial(workflow, executionId);
        const result = yield* execute(payload as object, executionId).pipe(
          Workflow.intoResult,
          Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
          (effect) => deferredState.trackRun(instance, effect),
        );
        if (result._tag === "Complete") {
          yield* writeResult(workflow, executionId, result);
        }
        return result;
      }),
    );

  const fireClock = (_workflow: Workflow.Any, executionId: ExecutionId, deferredName: string) =>
    deferredDone({ executionId, deferredName, exit: Exit.void });

  const pendingClock = (executionId: ExecutionId, clockName: string) =>
    Effect.gen(function* () {
      const at = yield* store
        .get(keys.clock(executionId, clockName))
        .pipe(Effect.flatMap(decodeWakeTime), Effect.orDie);
      const deferredName = clockDeferredName(clockName);
      if (at === undefined) {
        return undefined;
      }
      if ((yield* store.get(keys.deferred(executionId, deferredName))) !== undefined) {
        return undefined;
      }
      return { at, deferredName };
    });

  return { engine, replay, fireClock, pendingClock };
};
