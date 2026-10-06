/** Loads run subjects, resolves references through related entities, and selects subjects due for timed triggers. */
import * as Effect from "effect/Effect";
import { EntityStore } from "../entities/store.ts";
import { readRef, type Subject } from "../entities/model.ts";
import type { ExecutionValues } from "../workflow/execution.ts";
import { isDue, triggerRefs, type TimedTrigger } from "../workflow/model.ts";

/** Reads entities as run subjects, and the refs a run or trigger reads through them. */
export const makeSubjects = Effect.fn("Automation.makeSubjects")(function* () {
  const entities = yield* EntityStore;

  const loadEntity = (type: string, id: string) =>
    entities
      .getEntity(type, id)
      .pipe(
        Effect.map((found): Subject | undefined =>
          found === undefined ? undefined : { type: found.type, id: found.id, data: found.data },
        ),
      );

  const resolve = (
    refs: ReadonlyArray<string>,
    known: Pick<ExecutionValues, "subject" | "steps">,
  ) =>
    Effect.gen(function* () {
      const types = yield* entities.listTypes;
      const values = yield* Effect.forEach(refs, (ref) =>
        readRef(types, known, ref, loadEntity).pipe(Effect.map((value) => [ref, value] as const)),
      );
      return Object.fromEntries(values);
    });

  /**
   * The subjects a timed trigger starts runs for at `at`, in order of ID: every entity of its
   * type that is due then, or one run without a subject when it names no type.
   */
  const due = Effect.fn("Automation.dueSubjects")(function* (trigger: TimedTrigger, at: number) {
    const type = trigger.entity;
    if (type === undefined) {
      return [null];
    }
    const records = yield* entities.listEntities(type);
    const candidates = records
      .map((record): Subject => ({ type: record.type, id: record.id, data: record.data }))
      .toSorted((left, right) => left.id.localeCompare(right.id));
    const refs = triggerRefs(trigger);
    return yield* Effect.filter(candidates, (subject) =>
      resolve(refs, { subject, steps: {} }).pipe(
        Effect.map((values) => isDue(trigger, (ref) => values[ref], at)),
      ),
    );
  });

  return { loadEntity, resolve, due };
});

export type Subjects = Effect.Success<ReturnType<typeof makeSubjects>>;
