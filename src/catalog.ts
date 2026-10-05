import * as Effect from "effect/Effect";
import { connections, findOperation, type OperationInput } from "./connections.ts";
import { pathTarget, type EntityType } from "./entities.ts";
import {
  InvalidWorkflow,
  conditionRefs,
  isPublicHttpsUrl,
  loneRef,
  stepRefs,
  subjectType,
  templateRefs,
  type ActionStep,
  type Step,
  type Workflow,
} from "./workflow.ts";

/**
 * What a workflow can draw on beyond its own steps: the entity types in the store. The connections are
 * static (`src/connections.ts`). The schema in `src/workflow.ts` checks a workflow's shape; this
 * module checks that it makes sense against the catalog, and describes the catalog to the
 * designer agent.
 */
export interface Catalog {
  readonly types: ReadonlyArray<EntityType>;
}

const findType = (catalog: Catalog, name: string | undefined) =>
  catalog.types.find((type) => type.name === name);

/**
 * Checks one ref. `available` holds the IDs of the steps that have finished on every path to the
 * step reading it, so a step can't read one that may not have run.
 */
const refProblems = (
  catalog: Catalog,
  subject: EntityType | undefined,
  available: ReadonlyMap<string, Step>,
  ref: string,
  where: string,
): ReadonlyArray<string> => {
  const [root = "", ...path] = ref.split(".");
  if (root === "steps") {
    const [stepId] = path;
    if (stepId === undefined) {
      return [`${where}: ${ref} must name a step, as in steps.<id>.<field>`];
    }
    const step = available.get(stepId);
    return step === undefined
      ? [
          `${where}: ${ref} reads step ${stepId}, which doesn't finish before this point on every path. Move the reader after it, outside the branch that contains it.`,
        ]
      : recordProblems(step, path.slice(1), `${where}: ${ref}`);
  }
  if (subject === undefined) {
    const roots = catalog.types.map((type) => type.name).join(", ");
    return [
      `${where}: ${ref} starts with ${root}, but this workflow has no subject. Refs start with steps., or with the trigger's entity type (the manual trigger's subject, or an entity trigger). Entity types: ${roots || "none"}.`,
    ];
  }
  if (root !== subject.name) {
    return [`${where}: ${ref} must start with ${subject.name} or steps.`];
  }
  const target = pathTarget(catalog.types, subject, path);
  return target.kind === "error" ? [`${where}: ${ref}: ${target.message}`] : [];
};

/** The fields a step's record has, as `steps.<id>.<field>` reads them. */
const recordFields = (step: Step): ReadonlyArray<string> => {
  switch (step.kind) {
    case "agent":
      return ["output"];
    case "action":
      return findOperation(step.use)?.recordFields ?? [];
    case "decide":
      return ["choice", "confidence", "probabilities"];
    case "human":
      return ["approved", "values", "respondedBy", "timedOut"];
    case "if":
      return ["matched"];
    default:
      return [];
  }
};

/** Fields a step fills in itself: an agent's output fields, or a human form's fields. */
const ownFields = (step: Step, field: string): ReadonlyArray<string> | undefined => {
  if (step.kind === "agent" && field === "output") {
    return step.output?.fields.map((output) => output.name) ?? [];
  }
  if (step.kind === "human" && field === "values" && step.response !== "approval") {
    return step.response.fields.map((input) => input.name);
  }
  return undefined;
};

const recordProblems = (
  step: Step,
  path: ReadonlyArray<string>,
  where: string,
): ReadonlyArray<string> => {
  const [field, inner] = path;
  if (field === undefined) {
    return [];
  }
  const fields = recordFields(step);
  if (!fields.includes(field)) {
    return [
      `${where}: step ${step.id} records ${fields.length === 0 ? "nothing" : fields.join(", ")}`,
    ];
  }
  const own = ownFields(step, field);
  if (inner === undefined || own === undefined || own.includes(inner)) {
    return [];
  }
  return [
    own.length === 0
      ? `${where}: steps.${step.id}.${field} is text, with no fields`
      : `${where}: steps.${step.id}.${field} has fields ${own.join(", ")}`,
  ];
};

const isPersonRef = (catalog: Catalog, subject: EntityType | undefined, ref: string) => {
  const [root, ...path] = ref.split(".");
  if (root === "steps" || subject === undefined) {
    return true;
  }
  const target = pathTarget(catalog.types, subject, path);
  return (
    target.kind === "error" ||
    (target.kind === "entity" && target.type.fields.some((field) => field.type === "email")) ||
    (target.kind === "field" && target.field.type === "email")
  );
};

const inputProblems = (
  catalog: Catalog,
  subject: EntityType | undefined,
  step: ActionStep,
  input: OperationInput,
): ReadonlyArray<string> => {
  const where = `Step ${step.id} input ${input.name}`;
  const value = step.with[input.name];
  if (value === undefined) {
    return input.required ? [`${where} is required by ${step.use}`] : [];
  }
  if ((input.type === "people") !== Array.isArray(value)) {
    return [
      input.type === "people"
        ? `${where} is a list, such as ["{{employee}}", "{{employee.manager}}"]`
        : `${where} is a single value, not a list`,
    ];
  }
  const values = typeof value === "string" ? [value] : value;
  if (input.type === "url") {
    return values.every((url) => templateRefs(url).length === 0 && isPublicHttpsUrl(url))
      ? []
      : [`${where} must be a literal public HTTPS URL without credentials`];
  }
  if (input.type === "person" || input.type === "people") {
    return values.flatMap((person) => {
      const ref = loneRef(person);
      if (ref === undefined) {
        return person.includes("@") || templateRefs(person).length > 0
          ? []
          : [`${where}: ${person} is neither a {{ref}} to a person nor an email address`];
      }
      return isPersonRef(catalog, subject, ref)
        ? []
        : [`${where}: ${ref} isn't a person; point it at an entity with an email field`];
    });
  }
  return [];
};

const actionProblems = (
  catalog: Catalog,
  subject: EntityType | undefined,
  step: ActionStep,
): ReadonlyArray<string> => {
  const operation = findOperation(step.use);
  if (operation === undefined) {
    return [`Step ${step.id} uses unknown operation ${step.use}`];
  }
  const unknown = Object.keys(step.with).filter(
    (name) => !operation.inputs.some((input) => input.name === name),
  );
  return [
    ...unknown.map((name) => `Step ${step.id}: ${step.use} has no input ${name}`),
    ...operation.inputs.flatMap((input) => inputProblems(catalog, subject, step, input)),
  ];
};

const ownProblems = (
  catalog: Catalog,
  subject: EntityType | undefined,
  available: ReadonlyMap<string, Step>,
  step: Step,
): ReadonlyArray<string> => [
  ...stepRefs(step).flatMap((ref) =>
    refProblems(catalog, subject, available, ref, `Step ${step.id}`),
  ),
  ...(step.kind === "action" ? actionProblems(catalog, subject, step) : []),
  ...(step.kind === "human" &&
  step.assignee !== undefined &&
  !isPersonRef(catalog, subject, step.assignee)
    ? [`Step ${step.id}: assignee ${step.assignee} isn't a person`]
    : []),
];

interface Checked {
  readonly problems: ReadonlyArray<string>;
  /** Steps that have finished once the sequence ends. */
  readonly available: ReadonlyMap<string, Step>;
}

/**
 * Checks a sequence of steps in order. After a parallel step, everything its branches ran is
 * available; after an if or decide step, only the step itself, because each branch may not run.
 */
const checkSequence = (
  catalog: Catalog,
  subject: EntityType | undefined,
  steps: ReadonlyArray<Step>,
  available: ReadonlyMap<string, Step>,
): Checked =>
  steps.reduce<Checked>(
    (checked, step) => {
      const own = ownProblems(catalog, subject, checked.available, step);
      const before =
        step.kind === "parallel"
          ? checked.available
          : new Map([...checked.available, [step.id, step] as const]);
      const children = childResults(catalog, subject, step, before);
      const after =
        step.kind === "parallel"
          ? new Map([
              ...checked.available,
              [step.id, step] as const,
              ...children.flatMap((child) => [...child.available]),
            ])
          : before;
      return {
        problems: [...checked.problems, ...own, ...children.flatMap((child) => child.problems)],
        available: after,
      };
    },
    { problems: [], available },
  );

const childResults = (
  catalog: Catalog,
  subject: EntityType | undefined,
  step: Step,
  available: ReadonlyMap<string, Step>,
): ReadonlyArray<Checked> => {
  switch (step.kind) {
    case "parallel":
      return step.branches.map((branch) => checkSequence(catalog, subject, branch, available));
    case "if":
      return [...step.cases.map((branch) => branch.steps), step.otherwise ?? []].map((branch) =>
        checkSequence(catalog, subject, branch, available),
      );
    case "decide":
      return step.options.map((option) => checkSequence(catalog, subject, option.steps, available));
    default:
      return [];
  }
};

const triggerProblems = (catalog: Catalog, workflow: Workflow): ReadonlyArray<string> => {
  const name = subjectType(workflow.trigger);
  if (name === undefined) {
    return [];
  }
  const subject = findType(catalog, name);
  if (subject === undefined) {
    const names = catalog.types.map((type) => type.name).join(", ");
    return [`The trigger names unknown entity type ${name} (types: ${names || "none"})`];
  }
  if (workflow.trigger.kind !== "entity") {
    return [];
  }
  return [
    ...(workflow.trigger.fields ?? []).flatMap((field) =>
      subject.fields.some((candidate) => candidate.name === field)
        ? []
        : [`The trigger watches ${name}.${field}, which doesn't exist`],
    ),
    ...(workflow.trigger.when === undefined
      ? []
      : conditionRefs(workflow.trigger.when).flatMap((ref) =>
          ref.startsWith("steps.")
            ? [`The trigger's condition can't read ${ref}; no step has run yet`]
            : refProblems(catalog, subject, new Map(), ref, "The trigger's condition"),
        )),
  ];
};

/** Everything wrong with a workflow given the catalog, or nothing. */
export const workflowProblems = (catalog: Catalog, workflow: Workflow): ReadonlyArray<string> => {
  const subject = findType(catalog, subjectType(workflow.trigger));
  return [
    ...triggerProblems(catalog, workflow),
    ...checkSequence(catalog, subject, workflow.steps, new Map()).problems,
  ];
};

export const checkWorkflow = (catalog: Catalog, workflow: Workflow) => {
  const problems = workflowProblems(catalog, workflow);
  return problems.length === 0
    ? Effect.succeed(workflow)
    : Effect.fail(new InvalidWorkflow({ message: problems.join("\n") }));
};

const describeType = (type: EntityType) =>
  `- ${type.name} (${type.label}; shown as its ${type.title}): ${type.fields
    .map((field) => `${field.name} ${field.type === "ref" ? `→ ${field.to}` : field.type}`)
    .join(", ")}, id`;

const describeInput = (input: OperationInput) =>
  `${input.name}${input.required ? "" : "?"}: ${input.type} (${input.description})`;

/** The catalog as the designer agent reads it. */
export const describeCatalog = (catalog: Catalog) =>
  [
    "Entity types (stored records; a field marked → points to another entity):",
    ...(catalog.types.length === 0 ? ["- none yet"] : catalog.types.map(describeType)),
    "",
    "Connection operations (use them in action steps):",
    ...connections.flatMap((connection) =>
      connection.operations.map(
        (operation) =>
          `- ${operation.id}: ${operation.description} Inputs: ${operation.inputs.map(describeInput).join("; ")}. Records ${operation.records}.`,
      ),
    ),
  ].join("\n");
