/** Models approved wording with entity-backed slots, checks references, and expands uses into a run's action inputs. */
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { EntityField, EntityName, pathTarget, type EntityType } from "./model.ts";
import {
  InvalidWorkflow,
  actionTemplates,
  flattenSteps,
  loneRef,
  templateParts,
  templateRefs,
  type InputSource,
  type Step,
  type TemplateUse,
  type Workflow,
} from "../workflow/model.ts";

/**
 * Templates are approved, reusable wording, such as the standard welcome email. Each one names its
 * insertion points as slots, declared like an entity type's fields (`hire → employee`), and its
 * content fills the action inputs of the same name (`subject`, `body`) with text whose `{{refs}}`
 * start at a slot (`{{hire.name}}`). An action step uses one with `template: { use, with }`, where
 * `with` fills the slots from what the run knows. This module holds the pure model: the Schema,
 * checking a template against the entity types, and expanding the templates a workflow uses into
 * plain inputs before it runs. The `EntityStore` keeps them.
 */

export class InvalidTemplate extends Schema.TaggedError<InvalidTemplate>()("InvalidTemplate", {
  message: Schema.String,
}) {}

const NonBlank = (message: string, maxLength: number) =>
  Schema.String.check(
    Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= maxLength, {
      message,
    }),
  );

export const Template = Schema.Struct({
  name: EntityName,
  label: NonBlank("A template needs a label (maximum 120 characters)", 120),
  /** Who and what it's for. The planner reads it to decide when the template fits. */
  description: NonBlank("A template needs a description (maximum 500 characters)", 500),
  slots: Schema.Array(EntityField).check(
    Schema.makeFilter(
      (slots: ReadonlyArray<{ readonly name: string }>) =>
        slots.length <= 10 && new Set(slots.map((slot) => slot.name)).size === slots.length,
      { message: "A template has at most 10 slots, with unique names" },
    ),
  ),
  /** Text for the action inputs it fills, by input name. */
  content: Schema.Record(
    Schema.String.check(
      Schema.isPattern(/^[a-zA-Z]{1,40}$/, { message: "Content names the inputs it fills" }),
    ),
    Schema.String.check(Schema.isMaxLength(4000)),
  ).check(
    Schema.makeFilter((content: object) => Object.keys(content).length > 0, {
      message: "A template's content fills at least one input",
    }),
  ),
});
export interface Template extends Schema.Schema.Type<typeof Template> {}

/** The slots as the fields of a type, so refs in the content resolve like refs from an entity. */
const slotsType = (template: Template): EntityType => ({
  name: template.name,
  label: template.label,
  title: template.slots[0]?.name ?? "",
  fields: template.slots,
});

/** Every `{{ref}}` the template's content reads, in order of first use. */
export const contentRefs = (template: Template) => [
  ...new Set(Object.values(template.content).flatMap(templateRefs)),
];

/** Everything wrong with a template given the entity types, or nothing. */
export const templateProblems = (
  types: ReadonlyArray<EntityType>,
  template: Template,
): ReadonlyArray<string> => [
  ...template.slots.flatMap((slot) =>
    slot.type === "ref" && !types.some((type) => type.name === slot.to)
      ? [`Slot ${slot.name} points to unknown entity type ${slot.to}`]
      : [],
  ),
  ...contentRefs(template).flatMap((ref) => {
    const [slot = "", ...path] = ref.split(".");
    if (!template.slots.some((candidate) => candidate.name === slot)) {
      const names = template.slots.map((candidate) => candidate.name).join(", ");
      return [`{{${ref}}} doesn't start with a slot (slots: ${names || "none"})`];
    }
    const target = pathTarget(types, slotsType(template), [slot, ...path]);
    return target.kind === "error" ? [`{{${ref}}}: ${target.message}`] : [];
  }),
];

export const checkTemplate = (
  types: ReadonlyArray<EntityType>,
  template: Template,
): Effect.Effect<Template, InvalidTemplate> => {
  const problems = templateProblems(types, template);
  return problems.length === 0
    ? Effect.succeed(template)
    : Effect.fail(new InvalidTemplate({ message: problems.join("\n") }));
};

/**
 * What one content ref becomes once the slots are filled: a ref from the run (`{{hire.name}}` with
 * `hire` filled by `{{employee}}` reads `{{employee.name}}`), or a text slot's text. A ref whose
 * slot isn't filled stays as written.
 */
const fillRef = (use: TemplateUse, ref: string) => {
  const [slot = "", ...path] = ref.split(".");
  const filling = use.with[slot];
  if (filling === undefined) {
    return `{{${ref}}}`;
  }
  const bound = loneRef(filling);
  if (bound !== undefined) {
    return `{{${[bound, ...path].join(".")}}}`;
  }
  return path.length === 0 ? filling : `{{${ref}}}`;
};

/** The template's content with its slots filled, as plain action inputs. */
export const fillTemplate = (template: Template, use: TemplateUse): Record<string, string> =>
  Object.fromEntries(
    Object.entries(template.content).map(([input, text]) => [
      input,
      templateParts(text)
        .map((part) => (part.kind === "text" ? part.text : fillRef(use, part.ref)))
        .join(""),
    ]),
  );

const findTemplate = (templates: ReadonlyArray<Template>, name: string) =>
  templates.find((template) => template.name === name);

/** A source's inputs with its template's content filled in, or the source as it is. */
const expandSource = (templates: ReadonlyArray<Template>, source: InputSource): InputSource => {
  const template = source.template && findTemplate(templates, source.template.use);
  return source.template === undefined || template === undefined
    ? source
    : { with: { ...source.with, ...fillTemplate(template, source.template) } };
};

const expandStep = (templates: ReadonlyArray<Template>, step: Step): Step =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      action: (action): Step => {
        const own = expandSource(templates, action);
        return {
          id: action.id,
          title: action.title,
          kind: action.kind,
          use: action.use,
          with: own.with ?? {},
          ...(own.template === undefined ? {} : { template: own.template }),
          ...(action.match === undefined
            ? {}
            : {
                match: {
                  on: action.match.on,
                  cases: action.match.cases.map((branch) => ({
                    when: branch.when,
                    ...expandSource(templates, branch),
                  })),
                  otherwise: expandSource(templates, action.match.otherwise),
                },
              }),
        };
      },
      parallel: (parallel) => ({
        ...parallel,
        branches: parallel.branches.map((branch) => expandSteps(templates, branch)),
      }),
      if: (branching) => ({
        ...branching,
        cases: branching.cases.map((branch) => ({
          ...branch,
          steps: expandSteps(templates, branch.steps),
        })),
        ...(branching.otherwise === undefined
          ? {}
          : { otherwise: expandSteps(templates, branching.otherwise) }),
      }),
      decide: (decide) => ({
        ...decide,
        options: decide.options.map((option) => ({
          ...option,
          steps: expandSteps(templates, option.steps),
        })),
      }),
      agent: (leaf) => leaf,
      wait: (leaf) => leaf,
      human: (leaf) => leaf,
      stop: (leaf) => leaf,
    }),
  );

const expandSteps = (templates: ReadonlyArray<Template>, steps: ReadonlyArray<Step>) =>
  steps.map((step) => expandStep(templates, step));

/** The names of the templates a workflow uses, each once, in order of first use. */
export const usedTemplates = (workflow: Workflow): ReadonlyArray<string> => [
  ...new Set(
    flattenSteps(workflow.steps).flatMap((step) =>
      step.kind === "action" ? actionTemplates(step).map((use) => use.use) : [],
    ),
  ),
];

/**
 * Replaces every template use with the inputs its content fills, so a run carries the wording it
 * started with and replays the same text after a template changes. The workflow must already check
 * against the catalog; a template that's missing fails.
 */
export const expandTemplates = (
  workflow: Workflow,
  templates: ReadonlyArray<Template>,
): Effect.Effect<Workflow, InvalidWorkflow> => {
  const missing = usedTemplates(workflow).filter(
    (name) => findTemplate(templates, name) === undefined,
  );
  return missing.length === 0
    ? Effect.succeed({ ...workflow, steps: expandSteps(templates, workflow.steps) })
    : Effect.fail(new InvalidWorkflow({ message: `Unknown templates: ${missing.join(", ")}` }));
};
