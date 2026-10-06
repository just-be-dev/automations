import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { stringify } from "yaml";
import {
  ActionStep,
  AgentStep,
  Condition,
  DecisionModel,
  decodeWorkflow,
  flattenSteps,
  HumanStep,
  InvalidWorkflow,
  Permissions,
  StepId,
  StepTitle,
  StopStep,
  Trigger,
  WaitForStep,
  WaitUntilStep,
  type Permission,
  type Step,
  type Workflow,
} from "../../workflow/model.ts";

/**
 * The planner's working copy of a workflow while it answers a message. Its tools edit one step at
 * a time, so a step that holds other steps names them by ID instead of nesting them, and every
 * step is kept once in `stepsById`. `assemblePlan` rebuilds the tree a `Workflow` decodes from.
 */

const StepIds = Schema.Array(StepId);

// Container steps are only checked for their shape here: counts and texts are checked when the
// assembled tree decodes as a `Workflow`.
const PlanParallelStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("parallel"),
  branches: Schema.Array(StepIds),
});

const PlanIfStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("if"),
  cases: Schema.Array(Schema.Struct({ when: Condition, steps: StepIds })),
  otherwise: Schema.optionalKey(StepIds),
});

const PlanDecideStep = Schema.Struct({
  id: StepId,
  title: StepTitle,
  kind: Schema.Literal("decide"),
  model: DecisionModel,
  question: Schema.String,
  options: Schema.Array(Schema.Struct({ id: StepId, description: Schema.String, steps: StepIds })),
});

export const PlanStep = Schema.Union([
  AgentStep,
  ActionStep,
  WaitForStep,
  WaitUntilStep,
  PlanParallelStep,
  PlanIfStep,
  PlanDecideStep,
  HumanStep,
  StopStep,
]);
export type PlanStep = typeof PlanStep.Type;

export const Plan = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(Trigger),
  /** The top-level steps, in order. */
  steps: StepIds,
  stepsById: Schema.Record(Schema.String, PlanStep),
  permissions: Permissions,
});
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

const ids = (steps: ReadonlyArray<Step>) => steps.map((step) => step.id);

const planStep = (step: Step): PlanStep => {
  switch (step.kind) {
    case "parallel":
      return { ...step, branches: step.branches.map(ids) };
    case "if": {
      const { otherwise, ...rest } = step;
      return {
        ...rest,
        cases: step.cases.map((branch) => ({ when: branch.when, steps: ids(branch.steps) })),
        ...(otherwise === undefined ? {} : { otherwise: ids(otherwise) }),
      };
    }
    case "decide":
      return {
        ...step,
        options: step.options.map((option) => ({ ...option, steps: ids(option.steps) })),
      };
    default:
      return step;
  }
};

/** The working copy of a draft, or an empty one when there is none yet. */
export const planOf = (workflow: Workflow | undefined): Plan =>
  workflow === undefined
    ? { steps: [], stepsById: {}, permissions: {} }
    : {
        name: workflow.name,
        trigger: workflow.trigger,
        steps: ids(workflow.steps),
        stepsById: Object.fromEntries(
          flattenSteps(workflow.steps).map((step) => [step.id, planStep(step)]),
        ),
        permissions: workflow.permissions ?? {},
      };

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([key, inner]) => [key, canonical(inner)]),
        )
      : value;

/** Whether two working copies hold the same workflow, whatever order their keys are in. */
export const samePlan = (left: Plan, right: Plan) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** The step lists nested directly inside a step. */
const childLists = (step: PlanStep): ReadonlyArray<ReadonlyArray<string>> => {
  switch (step.kind) {
    case "parallel":
      return step.branches;
    case "if":
      return [...step.cases.map((branch) => branch.steps), step.otherwise ?? []];
    case "decide":
      return step.options.map((option) => option.steps);
    default:
      return [];
  }
};

/** Rewrites every step list nested directly inside a step: with other IDs, or with the steps. */
function mapChildLists(
  step: PlanStep,
  map: (list: ReadonlyArray<string>) => ReadonlyArray<string>,
): PlanStep;
function mapChildLists(
  step: PlanStep,
  map: (list: ReadonlyArray<string>) => ReadonlyArray<unknown>,
): unknown;
function mapChildLists(
  step: PlanStep,
  map: (list: ReadonlyArray<string>) => ReadonlyArray<unknown>,
): unknown {
  switch (step.kind) {
    case "parallel":
      return { ...step, branches: step.branches.map(map) };
    case "if":
      return {
        ...step,
        cases: step.cases.map((branch) => ({ ...branch, steps: map(branch.steps) })),
        ...(step.otherwise === undefined ? {} : { otherwise: map(step.otherwise) }),
      };
    case "decide":
      return {
        ...step,
        options: step.options.map((option) => ({ ...option, steps: map(option.steps) })),
      };
    default:
      return step;
  }
}

/** How the working copy's lists fit together, and the step tree they make. */
interface Layout {
  readonly steps: ReadonlyArray<unknown>;
  /** IDs a list names that no step has. */
  readonly missing: ReadonlyArray<string>;
  /** Steps named in more than one list. */
  readonly repeated: ReadonlyArray<string>;
  /** Steps no list names, which would never run. */
  readonly unplaced: ReadonlyArray<string>;
}

const layout = (plan: Plan): Layout => {
  const placed = new Set<string>();
  const missing = new Set<string>();
  const repeated = new Set<string>();
  // Each step is placed once, so a step that names itself, directly or not, can't loop.
  const build = (list: ReadonlyArray<string>): ReadonlyArray<unknown> =>
    list.flatMap((id) => {
      const step = plan.stepsById[id];
      if (step === undefined) {
        missing.add(id);
        return [];
      }
      if (placed.has(id)) {
        repeated.add(id);
        return [];
      }
      placed.add(id);
      return [mapChildLists(step, build)];
    });
  const steps = build(plan.steps);
  return {
    steps,
    missing: [...missing],
    repeated: [...repeated],
    unplaced: Object.keys(plan.stepsById).filter((id) => !placed.has(id)),
  };
};

/** What keeps the working copy's lists from making one tree, in words the planner acts on. */
export const layoutProblems = (plan: Plan): ReadonlyArray<string> => {
  const { missing, repeated, unplaced } = layout(plan);
  return [
    ...missing.map((id) => `A list names step ${id}, which doesn't exist: put it, or take it out`),
    ...repeated.map((id) => `Step ${id} is in more than one list; a step belongs to exactly one`),
    ...unplaced.map(
      (id) => `Step ${id} isn't in any list, so it would never run: list it, or remove it`,
    ),
  ];
};

/** The workflow the working copy holds, or every reason it doesn't make one yet. */
export const assemblePlan = (plan: Plan): Effect.Effect<Workflow, InvalidWorkflow> => {
  const problems = [
    ...(plan.name === undefined ? ["The workflow has no name yet"] : []),
    ...(plan.trigger === undefined ? ["The workflow has no trigger yet"] : []),
    ...layoutProblems(plan),
  ];
  return problems.length > 0
    ? Effect.fail(new InvalidWorkflow({ message: problems.join("\n") }))
    : decodeWorkflow({
        name: plan.name,
        trigger: plan.trigger,
        steps: layout(plan).steps,
        ...(Object.keys(plan.permissions).length === 0 ? {} : { permissions: plan.permissions }),
      });
};

/**
 * The working copy as the planner reads it: YAML of the step tree, with nested steps in place.
 * Steps no list names are left out; `layoutProblems` reports them.
 */
export const planYaml = (plan: Plan) =>
  stringify(
    {
      ...(plan.name === undefined ? {} : { name: plan.name }),
      ...(plan.trigger === undefined ? {} : { trigger: plan.trigger }),
      steps: layout(plan).steps,
      ...(Object.keys(plan.permissions).length === 0 ? {} : { permissions: plan.permissions }),
    },
    // Long lines stay whole, and repeated values are written out rather than aliased.
    { lineWidth: 0, aliasDuplicateObjects: false },
  ).trimEnd();

export interface WorkflowChange {
  readonly name?: string;
  readonly trigger?: Trigger;
  readonly steps?: ReadonlyArray<string>;
}

export const changeWorkflow = (plan: Plan, change: WorkflowChange): Plan => ({
  ...plan,
  ...(change.name === undefined ? {} : { name: change.name }),
  ...(change.trigger === undefined ? {} : { trigger: change.trigger }),
  ...(change.steps === undefined ? {} : { steps: change.steps }),
});

/** Adds steps, or replaces the ones with the same IDs. */
export const putSteps = (plan: Plan, steps: ReadonlyArray<PlanStep>): Plan => ({
  ...plan,
  stepsById: {
    ...plan.stepsById,
    ...Object.fromEntries(steps.map((step) => [step.id, step])),
  },
});

/** Removes steps and every step nested in them, and takes them out of every list. */
export const removeSteps = (plan: Plan, removing: ReadonlyArray<string>): Plan => {
  const removed = new Set<string>();
  const remove = (id: string): void => {
    if (removed.has(id)) {
      return;
    }
    removed.add(id);
    const step = plan.stepsById[id];
    if (step !== undefined) {
      childLists(step).flat().forEach(remove);
    }
  };
  removing.forEach(remove);
  const keep = (list: ReadonlyArray<string>) => list.filter((id) => !removed.has(id));
  return {
    ...plan,
    steps: keep(plan.steps),
    stepsById: Object.fromEntries(
      Object.entries(plan.stepsById)
        .filter(([id]) => !removed.has(id))
        .map(([id, step]) => [id, mapChildLists(step, keep)]),
    ),
  };
};

export const setPermissions = (
  plan: Plan,
  permissions: Readonly<Record<string, Permission>>,
): Plan => ({ ...plan, permissions: { ...plan.permissions, ...permissions } });
