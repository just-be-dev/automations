/** Compares two versions of a workflow by step ID: steps added, changed, moved, or removed, field-level
 * old values, and changes to the name, trigger, and permissions. */
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { flattenSteps, Permission, type Step, Trigger, type Workflow } from "./model.ts";

/**
 * One field of a step that changed, by dotted path into the step without its nested steps
 * (`title`, `with.channel`, `cases.0.when`). `before` is the old value, absent when the field is new
 * or the value was too large to keep.
 */
export const FieldChange = Schema.Struct({
  path: Schema.String,
  before: Schema.optionalKey(Schema.Json),
});
export interface FieldChange extends Schema.Schema.Type<typeof FieldChange> {}

/**
 * A step that is new, changed in its own fields or moved, or gone. Nested steps report their own
 * changes, so a container only counts as changed for its own fields: its title, conditions,
 * options, or number of branches. Only the outermost removed step is listed.
 */
export const StepChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("added"), id: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("changed"),
    id: Schema.String,
    fields: Schema.Array(FieldChange),
    moved: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("removed"), id: Schema.String, title: Schema.String }),
]);
export type StepChange = typeof StepChange.Type;

/** A permission the newer version sets differently. `before` is absent when it had none. */
export const PermissionChange = Schema.Struct({
  operation: Schema.String,
  before: Schema.optionalKey(Permission),
});
export interface PermissionChange extends Schema.Schema.Type<typeof PermissionChange> {}

/** What changed from one version of a workflow to the next. */
export const WorkflowChanges = Schema.Struct({
  name: Schema.optionalKey(Schema.Struct({ before: Schema.String })),
  trigger: Schema.optionalKey(Schema.Struct({ before: Trigger })),
  steps: Schema.Array(StepChange),
  permissions: Schema.Array(PermissionChange),
});
export interface WorkflowChanges extends Schema.Schema.Type<typeof WorkflowChanges> {}

/**
 * Old values beyond this many characters in all are dropped, so the changes stay well inside one
 * storage value beside the reply they're recorded with.
 */
const MAX_BEFORE_CHARS = 32_000;

// NOTE: workflows are decoded JSON, so every value in one is JSON.
const asJson = (value: unknown) => value as Schema.Json;

const isRecord = (value: unknown): value is Readonly<Record<string, Schema.Json>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether two JSON values are equal, whatever order their keys are in. */
export const sameJson = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => sameJson(left[key], right[key]));
  }
  return left === right;
};

/** A step's own fields, with its nested steps left out. */
const ownFields = (step: Step): Schema.Json =>
  Match.value(step).pipe(
    Match.discriminators("kind")({
      parallel: (parallel) => ({
        id: parallel.id,
        title: parallel.title,
        kind: parallel.kind,
        branches: parallel.branches.length,
      }),
      if: (branching) => ({
        id: branching.id,
        title: branching.title,
        kind: branching.kind,
        cases: branching.cases.map((branch) => ({ when: asJson(branch.when) })),
      }),
      decide: (decide) => ({
        id: decide.id,
        title: decide.title,
        kind: decide.kind,
        model: decide.model,
        question: decide.question,
        options: decide.options.map(({ id, description }) => ({ id, description })),
      }),
    }),
    Match.orElse(asJson),
  );

/** Conditions read as one value, so a changed condition is one field. */
const isLeafKey = (key: string) => key === "when";

const join = (path: string, key: string | number) => (path === "" ? String(key) : `${path}.${key}`);

const fieldChanges = (
  before: Schema.Json | undefined,
  after: Schema.Json | undefined,
  path: string,
): ReadonlyArray<FieldChange> => {
  if (sameJson(before, after)) {
    return [];
  }
  const key = path.split(".").at(-1) ?? "";
  if (isRecord(before) && isRecord(after) && !isLeafKey(key)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((inner) => fieldChanges(before[inner], after[inner], join(path, inner)));
  }
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.length === after.length &&
    before.every(isRecord) &&
    after.every(isRecord)
  ) {
    return before.flatMap((item, index) => fieldChanges(item, after[index], join(path, index)));
  }
  return [before === undefined ? { path } : { path, before }];
};

/** The step lists nested in a step, each named so it stays the same when siblings change. */
const childLanes = (step: Step): ReadonlyArray<readonly [string, ReadonlyArray<Step>]> =>
  Match.value(step).pipe(
    Match.discriminators("kind")({
      parallel: (parallel) =>
        parallel.branches.map((steps, index) => [`branch ${index}`, steps] as const),
      if: (branching) => [
        ...branching.cases.map((branch, index) => [`case ${index}`, branch.steps] as const),
        ...(branching.otherwise === undefined ? [] : [["otherwise", branching.otherwise] as const]),
      ],
      decide: (decide) =>
        decide.options.map((option) => [`option ${option.id}`, option.steps] as const),
    }),
    Match.orElse(() => []),
  );

interface Layout {
  /** The lane each step sits in: its parent's ID and which of its lists. */
  readonly laneOf: ReadonlyMap<string, string>;
  readonly parentOf: ReadonlyMap<string, string>;
  readonly lanes: ReadonlyMap<string, ReadonlyArray<string>>;
}

const layoutOf = (steps: ReadonlyArray<Step>): Layout => {
  const laneOf = new Map<string, string>();
  const parentOf = new Map<string, string>();
  const lanes = new Map<string, ReadonlyArray<string>>();
  const visit = (list: ReadonlyArray<Step>, lane: string, parent: string | undefined) => {
    lanes.set(
      lane,
      list.map((step) => step.id),
    );
    list.forEach((step) => {
      laneOf.set(step.id, lane);
      if (parent !== undefined) {
        parentOf.set(step.id, parent);
      }
      childLanes(step).forEach(([name, children]) =>
        visit(children, `${step.id}/${name}`, step.id),
      );
    });
  };
  visit(steps, "", undefined);
  return { laneOf, parentOf, lanes };
};

/** The longest common subsequence of two short ID lists. */
const longestCommon = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => {
  const lengths = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0),
  );
  left.forEach((leftId, i) =>
    right.forEach((rightId, j) => {
      const row = lengths[i + 1];
      if (row !== undefined) {
        row[j + 1] =
          leftId === rightId
            ? (lengths[i]?.[j] ?? 0) + 1
            : Math.max(lengths[i]?.[j + 1] ?? 0, row[j] ?? 0);
      }
    }),
  );
  const kept = new Set<string>();
  const walk = (i: number, j: number): void => {
    if (i === 0 || j === 0) {
      return;
    }
    if (left[i - 1] === right[j - 1]) {
      kept.add(left[i - 1] ?? "");
      return walk(i - 1, j - 1);
    }
    return (lengths[i - 1]?.[j] ?? 0) >= (lengths[i]?.[j - 1] ?? 0)
      ? walk(i - 1, j)
      : walk(i, j - 1);
  };
  walk(left.length, right.length);
  return kept;
};

/**
 * Steps found in both versions that sit in another lane, or out of order among the steps they
 * share it with. Inserting or removing a sibling moves nothing.
 */
const movedSteps = (before: Layout, after: Layout) => {
  const moved = new Set<string>();
  after.lanes.forEach((ids, lane) => {
    const stayed = ids.filter((id) => before.laneOf.get(id) === lane);
    ids
      .filter((id) => before.laneOf.has(id) && before.laneOf.get(id) !== lane)
      .forEach((id) => moved.add(id));
    const previousOrder = (before.lanes.get(lane) ?? []).filter((id) => stayed.includes(id));
    const kept = longestCommon(previousOrder, stayed);
    stayed.filter((id) => !kept.has(id)).forEach((id) => moved.add(id));
  });
  return moved;
};

const withoutBefore = (changes: WorkflowChanges): WorkflowChanges => ({
  ...changes,
  steps: changes.steps.map((change) =>
    change.kind === "changed"
      ? { ...change, fields: change.fields.map(({ path }) => ({ path })) }
      : change,
  ),
});

const beforeChars = (changes: WorkflowChanges) =>
  changes.steps.reduce(
    (sum, change) =>
      change.kind === "changed"
        ? change.fields.reduce(
            (fieldSum, field) =>
              fieldSum + (field.before === undefined ? 0 : JSON.stringify(field.before).length),
            sum,
          )
        : sum,
    0,
  );

/** What changed from `before` to `after`, matching steps by ID wherever they sit in the tree. */
export const diffWorkflows = (before: Workflow, after: Workflow): WorkflowChanges => {
  const beforeSteps = new Map(flattenSteps(before.steps).map((step) => [step.id, step]));
  const afterSteps = flattenSteps(after.steps);
  const afterIds = new Set(afterSteps.map((step) => step.id));
  const beforeLayout = layoutOf(before.steps);
  const moved = movedSteps(beforeLayout, layoutOf(after.steps));
  const current = afterSteps.flatMap((step): ReadonlyArray<StepChange> => {
    const previous = beforeSteps.get(step.id);
    if (previous === undefined) {
      return [{ kind: "added", id: step.id }];
    }
    const fields = fieldChanges(ownFields(previous), ownFields(step), "");
    return fields.length === 0 && !moved.has(step.id)
      ? []
      : [{ kind: "changed", id: step.id, fields, moved: moved.has(step.id) }];
  });
  const removed = [...beforeSteps.values()].flatMap((step): ReadonlyArray<StepChange> => {
    const parent = beforeLayout.parentOf.get(step.id);
    const parentRemoved = parent !== undefined && !afterIds.has(parent);
    return afterIds.has(step.id) || parentRemoved
      ? []
      : [{ kind: "removed", id: step.id, title: step.title }];
  });
  const beforePermissions = before.permissions ?? {};
  const afterPermissions = after.permissions ?? {};
  const permissions = [
    ...new Set([...Object.keys(beforePermissions), ...Object.keys(afterPermissions)]),
  ].flatMap((operation): ReadonlyArray<PermissionChange> => {
    const previous = beforePermissions[operation];
    return sameJson(previous, afterPermissions[operation])
      ? []
      : [previous === undefined ? { operation } : { operation, before: previous }];
  });
  const changes: WorkflowChanges = {
    ...(before.name === after.name ? {} : { name: { before: before.name } }),
    ...(sameJson(before.trigger, after.trigger) ? {} : { trigger: { before: before.trigger } }),
    steps: [...current, ...removed],
    permissions,
  };
  return beforeChars(changes) > MAX_BEFORE_CHARS ? withoutBefore(changes) : changes;
};

export const isUnchanged = (changes: WorkflowChanges) =>
  changes.name === undefined &&
  changes.trigger === undefined &&
  changes.steps.length === 0 &&
  changes.permissions.length === 0;

/**
 * The part of `changes` the saved version doesn't have yet: the steps, trigger, name, and
 * permissions that still differ between `saved` and `draft`. Without a saved version, all of it.
 */
export const unsavedChanges = (
  changes: WorkflowChanges,
  saved: Workflow | undefined,
  draft: Workflow,
): WorkflowChanges => {
  if (saved === undefined) {
    return changes;
  }
  const pending = diffWorkflows(saved, draft);
  const pendingSteps = new Set(pending.steps.map((change) => change.id));
  const pendingPermissions = new Set(pending.permissions.map((change) => change.operation));
  return {
    ...(changes.name !== undefined && pending.name !== undefined ? { name: changes.name } : {}),
    ...(changes.trigger !== undefined && pending.trigger !== undefined
      ? { trigger: changes.trigger }
      : {}),
    steps: changes.steps.filter((change) => pendingSteps.has(change.id)),
    permissions: changes.permissions.filter((change) => pendingPermissions.has(change.operation)),
  };
};
