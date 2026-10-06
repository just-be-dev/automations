/** Validates workflows against entity types, templates, operations, and roles, and describes that catalog to the planner. */
import * as Effect from "effect/Effect";
import {
  connections,
  findOperation,
  operations,
  type Operation,
  type OperationInput,
} from "../connections/registry.ts";
import { isEmailField, pathTarget, type EntityType, type Role } from "../entities/model.ts";
import { contentRefs, templateProblems, type Template } from "../entities/templates.ts";
import {
  InvalidWorkflow,
  actionPaths,
  actionTemplates,
  childSequences,
  conditionRefs,
  isPublicHttpsUrl,
  loneRef,
  operationsUsed,
  stepRefs,
  subjectType,
  triggerCondition,
  templateRefs,
  type ActionInput,
  type ActionStep,
  type Step,
  type TemplateUse,
  type Workflow,
} from "./model.ts";

/**
 * What a workflow can draw on beyond its own steps: the entity types and templates in the store.
 * The connections are static (`src/connections.ts`). The schema in `src/workflow.ts` checks a
 * workflow's shape; this module checks that it makes sense against the catalog, and describes the
 * catalog to the planner agent.
 */
export interface Catalog {
  readonly types: ReadonlyArray<EntityType>;
  readonly templates: ReadonlyArray<Template>;
  /** Who can approve the operations a workflow asks first about. */
  readonly roles: ReadonlyArray<Role>;
}

const findType = (catalog: Catalog, name: string | undefined) =>
  catalog.types.find((type) => type.name === name);

const findTemplate = (catalog: Catalog, name: string | undefined) =>
  catalog.templates.find((template) => template.name === name);

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
      `${where}: ${ref} starts with ${root}, but this workflow has no subject. Refs start with steps., or with the trigger's entity type (the manual trigger's subject, or another trigger's entity). Entity types: ${roots || "none"}.`,
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

/** Where a person's address lives, as the connection runner reads it. */

const isPersonRef = (catalog: Catalog, subject: EntityType | undefined, ref: string) => {
  const [root, ...path] = ref.split(".");
  if (root === "steps" || subject === undefined) {
    return true;
  }
  const target = pathTarget(catalog.types, subject, path);
  return (
    target.kind === "error" ||
    (target.kind === "entity" && target.type.fields.some(isEmailField)) ||
    (target.kind === "field" && isEmailField(target.field))
  );
};

/** Problems with one value an action step gives an input in `with`. */
const valueProblems = (
  catalog: Catalog,
  subject: EntityType | undefined,
  where: string,
  input: OperationInput,
  value: ActionInput,
): ReadonlyArray<string> => {
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

/**
 * Checks the inputs an action gets on one path: each one comes from exactly one source, the
 * operation knows it, required ones are there, and values fit their input's type. A template's
 * content only fills text inputs.
 */
const pathProblems = (
  catalog: Catalog,
  subject: EntityType | undefined,
  step: ActionStep,
  operation: Operation,
  path: ReturnType<typeof actionPaths>[number],
): ReadonlyArray<string> => {
  const where = `Step ${step.id}${path.label === "" ? "" : ` (${path.label})`}`;
  // The first source is the step's own; any other is the match case's.
  const given = path.sources.flatMap((source, index) => [
    ...Object.keys(source.with ?? {}).map((name) => ({
      name,
      from: index === 0 ? "the step's with" : "the case's with",
      byTemplate: false,
    })),
    ...Object.keys(findTemplate(catalog, source.template?.use)?.content ?? {}).map((name) => ({
      name,
      from: `template ${source.template?.use}`,
      byTemplate: true,
    })),
  ]);
  const names = [...new Set(given.map((input) => input.name))];
  return [
    ...names.flatMap((name) => {
      const sources = given.filter((candidate) => candidate.name === name);
      const input = operation.inputs.find((candidate) => candidate.name === name);
      return [
        ...(input === undefined ? [`${where}: ${step.use} has no input ${name}`] : []),
        ...(sources.length > 1
          ? [
              `${where} input ${name} comes from both ${sources.map((source) => source.from).join(" and ")}; keep one`,
            ]
          : []),
        ...(input !== undefined &&
        input.type !== "text" &&
        sources.some((source) => source.byTemplate)
          ? [`${where} input ${name} takes a ${input.type}, which a template can't fill`]
          : []),
      ];
    }),
    ...operation.inputs.flatMap((input) =>
      input.required && !names.includes(input.name)
        ? [`${where} input ${input.name} is required by ${step.use}`]
        : path.sources.flatMap((source) => {
            const value = source.with?.[input.name];
            return value === undefined
              ? []
              : valueProblems(catalog, subject, `${where} input ${input.name}`, input, value);
          }),
    ),
  ];
};

/**
 * Checks one template use: the template exists and still checks, every slot is filled and no
 * other, and an entity slot gets exactly one {{ref}} to an entity of its type.
 */
const templateUseProblems = (
  catalog: Catalog,
  subject: EntityType | undefined,
  step: ActionStep,
  use: TemplateUse,
): ReadonlyArray<string> => {
  const where = `Step ${step.id}: template ${use.use}`;
  const template = findTemplate(catalog, use.use);
  if (template === undefined) {
    const names = catalog.templates.map((candidate) => candidate.name).join(", ");
    return [`Step ${step.id} uses unknown template ${use.use} (templates: ${names || "none"})`];
  }
  const slotNames = template.slots.map((slot) => slot.name);
  return [
    ...templateProblems(catalog.types, template).map((problem) => `${where}: ${problem}`),
    ...Object.keys(use.with).flatMap((name) =>
      slotNames.includes(name)
        ? []
        : [`${where} has no slot ${name} (slots: ${slotNames.join(", ") || "none"})`],
    ),
    ...template.slots.flatMap((slot) => {
      const filling = use.with[slot.name];
      if (filling === undefined) {
        return [`${where} needs slot ${slot.name} (${slot.label}) filled`];
      }
      if (slot.type !== "ref") {
        return [];
      }
      const ref = loneRef(filling);
      const target =
        ref === undefined || subject === undefined || ref.split(".")[0] !== subject.name
          ? undefined
          : pathTarget(catalog.types, subject, ref.split(".").slice(1));
      if (target?.kind !== "entity" || target.type.name !== slot.to) {
        return [
          `${where}: slot ${slot.name} takes one ${slot.to}: fill it with exactly one {{ref}} that starts at the trigger's entity and leads to one ${slot.to}`,
        ];
      }
      return contentRefs(template).flatMap((contentRef) => {
        const [root, ...path] = contentRef.split(".");
        return root === slot.name && ref !== undefined && ref.split(".").length + path.length > 6
          ? [
              `${where}: {{${contentRef}}} reaches too far through ${ref}; refs have at most 5 fields after their root`,
            ]
          : [];
      });
    }),
  ];
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
  return [
    ...new Set([
      ...actionTemplates(step).flatMap((use) => templateUseProblems(catalog, subject, step, use)),
      ...actionPaths(step).flatMap((path) => pathProblems(catalog, subject, step, operation, path)),
    ]),
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
  const { trigger } = workflow;
  const name = subjectType(trigger);
  const when = triggerCondition(trigger);
  if (name === undefined) {
    return when === undefined
      ? []
      : ['The trigger\'s condition needs an entity type: name the one it checks in "entity"'];
  }
  const subject = findType(catalog, name);
  if (subject === undefined) {
    const names = catalog.types.map((type) => type.name).join(", ");
    return [`The trigger names unknown entity type ${name} (types: ${names || "none"})`];
  }
  return [
    ...(trigger.kind === "entity" ? (trigger.fields ?? []) : []).flatMap((field) =>
      subject.fields.some((candidate) => candidate.name === field)
        ? []
        : [`The trigger watches ${name}.${field}, which doesn't exist`],
    ),
    ...(when === undefined
      ? []
      : conditionRefs(when).flatMap((ref) =>
          ref.startsWith("steps.")
            ? [`The trigger's condition can't read ${ref}; no step has run yet`]
            : refProblems(catalog, subject, new Map(), ref, "The trigger's condition"),
        )),
    ...(trigger.kind === "date" ? dateRefProblems(catalog, subject, trigger.on) : []),
  ];
};

/** A date trigger reads a date or datetime field of its entity, or of one it points to. */
const dateRefProblems = (catalog: Catalog, subject: EntityType, ref: string) => {
  const [root = "", ...path] = ref.split(".");
  if (root !== subject.name) {
    return [`The trigger's date ${ref} must start with ${subject.name}`];
  }
  const target = pathTarget(catalog.types, subject, path);
  if (target.kind === "error") {
    return [`The trigger's date ${ref}: ${target.message}`];
  }
  return target.kind === "field" &&
    (target.field.type === "date" || target.field.type === "datetime")
    ? []
    : [`The trigger's date ${ref} must be a date or datetime field`];
};

const sequences = (steps: ReadonlyArray<Step>): ReadonlyArray<ReadonlyArray<Step>> => [
  steps,
  ...steps.flatMap((step) => childSequences(step).flatMap(sequences)),
];

/** A stop step ends the run, so nothing may follow it in its list. */
const unreachableProblems = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
  sequences(steps).flatMap((list) => {
    const stop = list.findIndex((step) => step.kind === "stop");
    const next = list[stop + 1];
    return stop === -1 || next === undefined
      ? []
      : [`Step ${next.id} comes after stop step ${list[stop]?.id}, so it never runs`];
  });

const permissionProblems = (catalog: Catalog, workflow: Workflow): ReadonlyArray<string> => {
  const permissions = workflow.permissions ?? {};
  const roles = catalog.roles.map((role) => role.name).join(", ") || "none yet";
  return [
    ...Object.keys(permissions).flatMap((operation) =>
      findOperation(operation) === undefined
        ? [`permissions names unknown operation ${operation}`]
        : [],
    ),
    ...operationsUsed(workflow.steps).flatMap((operation) =>
      permissions[operation] === undefined && findOperation(operation) !== undefined
        ? [`permissions needs one for ${operation}: "auto", or {"ask":"<role>"}`]
        : [],
    ),
    ...Object.entries(permissions).flatMap(([operation, permission]) =>
      permission === "auto" || catalog.roles.some((role) => role.name === permission.ask)
        ? []
        : [`permissions for ${operation} ask unknown role ${permission.ask} (roles: ${roles})`],
    ),
  ];
};

/** Everything wrong with a workflow given the catalog, or nothing. */
export const workflowProblems = (catalog: Catalog, workflow: Workflow): ReadonlyArray<string> => {
  const subject = findType(catalog, subjectType(workflow.trigger));
  return [
    ...triggerProblems(catalog, workflow),
    ...checkSequence(catalog, subject, workflow.steps, new Map()).problems,
    ...unreachableProblems(workflow.steps),
    ...permissionProblems(catalog, workflow),
  ];
};

export const checkWorkflow = (
  catalog: Catalog,
  workflow: Workflow,
): Effect.Effect<Workflow, InvalidWorkflow> => {
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

const describeSlot = (slot: Template["slots"][number]) =>
  `${slot.name} ${slot.type === "ref" ? `→ ${slot.to}` : slot.type} (${slot.label})`;

/** The operations whose text inputs take all of a template's content. */
const operationsFitting = (template: Template) =>
  operations.filter((operation) =>
    Object.keys(template.content).every((name) =>
      operation.inputs.some((input) => input.name === name && input.type === "text"),
    ),
  );

const describeTemplate = (template: Template) => {
  const fits = operationsFitting(template).map((operation) => operation.id);
  return `- ${template.name} (${template.label}): ${template.description} Slots: ${
    template.slots.map(describeSlot).join(", ") || "none"
  }. Fills ${Object.keys(template.content).join(", ")}${fits.length === 0 ? "" : `; fits ${fits.join(", ")}`}.`;
};

/** The catalog as the planner agent reads it. */
export const describeCatalog = (catalog: Catalog) =>
  [
    "Entity types (stored records; a field marked → points to another entity, and an entity with a text field named email is a person who can be contacted or assigned):",
    ...(catalog.types.length === 0 ? ["- none yet"] : catalog.types.map(describeType)),
    "",
    "Connection operations (use them in action steps):",
    ...connections.flatMap((connection) =>
      connection.operations.map(
        (operation) =>
          `- ${operation.id}: ${operation.description} Inputs: ${operation.inputs.map(describeInput).join("; ")}. Records ${operation.records}.`,
      ),
    ),
    "",
    "Templates (approved wording for action inputs; a slot marked → takes an entity of that type):",
    ...(catalog.templates.length === 0 ? ["- none yet"] : catalog.templates.map(describeTemplate)),
    "",
    "Roles (their members approve the operations a workflow asks first about):",
    ...(catalog.roles.length === 0
      ? ["- none yet"]
      : catalog.roles.map(
          (role) =>
            `- ${role.name} (${role.label}): ${role.members.length === 1 ? "1 member" : `${role.members.length} members`}`,
        )),
  ].join("\n");
