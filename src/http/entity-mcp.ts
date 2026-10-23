/**
 * MCP tools over the catalog: entity types, entities and templates, and the changes to them. Reads
 * answer directly. A write applies when it is called, through the tenant's `Changes`: the call is
 * the person's approval, so the client must ask them first (see `mcp-server.ts`).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import { ChangeAction, ChangeDecision, ChangeDetail } from "../changes/model.ts";
import { ChangeError, Changes } from "../changes/service.ts";
import {
  EntityData,
  EntityId,
  EntityName,
  EntityRecord,
  EntityType,
  InvalidEntity,
} from "../entities/model.ts";
import { EntityStore, EntityStoreError } from "../entities/store.ts";
import { Template } from "../entities/templates.ts";
import { messageOf } from "../error.ts";
import { callerPerson, McpCaller, NoPerson } from "./mcp-caller.ts";

export class EntityNotFound extends Schema.TaggedError<EntityNotFound>()("EntityNotFound", {
  message: Schema.String,
}) {}

const EntityFailure = Schema.Union([
  EntityStoreError,
  InvalidEntity,
  EntityNotFound,
  ChangeError,
  NoPerson,
]);

const TypeParams = Schema.Struct({ type: EntityName });
const EntityParams = Schema.Struct({ type: EntityName, id: EntityId });
const TemplateParams = Schema.Struct({ name: EntityName });

/**
 * Lets a client retry a write without making it twice: the coordinator returns the proposal it
 * already prepared for this person under the same ID, and its stored decision.
 */
const ChangeRequest = {
  requestId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
      description:
        "Optional. A unique ID for this change, such as a UUID. Repeating the call with the same requestId returns the first call's outcome instead of writing again.",
    }),
  ),
};
const requestIdOf = (requestId: string | undefined) =>
  requestId === undefined ? undefined : `mcp:${requestId}`;

/** What a change does, as `preview_change` and a write's outcome describe it. */
const ChangeSummary = Schema.Struct({
  title: Schema.String,
  details: Schema.Array(ChangeDetail),
  consequences: Schema.Array(Schema.String),
});

/** A write's outcome: whether it applied, what it changed, and what entity-store returned. */
const ChangeOutcome = Schema.Struct({
  status: ChangeDecision.fields.status,
  proposalId: Schema.String,
  ...ChangeSummary.fields,
  result: Schema.Json,
});

const applies =
  "Applies when called; the person approves the call first. Use preview_change before it to show them what it will do.";

const ListEntityTypes = Tool.make("list_entity_types", {
  description:
    "Lists every entity type with its fields. Field types are text, number, boolean, date (YYYY-MM-DD), datetime (ISO 8601), and ref (another entity's ID, with the target type in `to`). Steps that contact a person read a text field named `email`.",
  success: Schema.Struct({ types: Schema.Array(EntityType) }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "List entity types")
  .annotate(Tool.Readonly, true);

const ListEntities = Tool.make("list_entities", {
  description: "Lists the entities of a type.",
  parameters: TypeParams,
  success: Schema.Struct({ entities: Schema.Array(EntityRecord) }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "List entities")
  .annotate(Tool.Readonly, true);

const GetEntity = Tool.make("get_entity", {
  description: "Reads one entity by type and ID.",
  parameters: EntityParams,
  success: Schema.Struct({ entity: EntityRecord }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Get entity")
  .annotate(Tool.Readonly, true);

const ListTemplates = Tool.make("list_templates", {
  description:
    "Lists the approved wording templates that workflows' actions can use: each one's name, label, description, slots, and content.",
  success: Schema.Struct({ templates: Schema.Array(Template) }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "List templates")
  .annotate(Tool.Readonly, true);

const PreviewChange = Tool.make("preview_change", {
  description:
    "Checks a change to an entity, entity type or template without making it, and says what it would change and what would follow, such as automations it may start. Show this to the person before calling the tool that makes the change. `change.kind` is putEntity {type, id, data}, deleteEntity {type, id}, putType {type}, deleteType {name}, putTemplate {template}, or deleteTemplate {name}.",
  parameters: Schema.Struct({ change: ChangeAction }),
  success: ChangeSummary,
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Preview a change")
  .annotate(Tool.Readonly, true);

const DefineEntityType = Tool.make("define_entity_type", {
  description: `Creates or changes an entity type. Names are snake_case. A change saves a new version that adds and removes fields; stored entities keep their data. A field can't change type here. ${applies}`,
  parameters: Schema.Struct({ type: EntityType, ...ChangeRequest }),
  success: ChangeOutcome,
  failure: EntityFailure,
}).annotate(Tool.Title, "Define entity type");

const DeleteEntityType = Tool.make("delete_entity_type", {
  description: `Deletes an entity type. Fails while the type has entities or automations use it. ${applies}`,
  parameters: Schema.Struct({ ...TypeParams.fields, ...ChangeRequest }),
  success: ChangeOutcome,
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Delete entity type")
  .annotate(Tool.Destructive, true);

const PutEntity = Tool.make("put_entity", {
  description: `Creates or updates an entity, merging data; null clears a field. Saved automations watching the type may start. ${applies}`,
  parameters: Schema.Struct({ ...EntityParams.fields, data: EntityData, ...ChangeRequest }),
  success: ChangeOutcome,
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Create or update entity")
  .annotate(Tool.Destructive, false);

const DeleteEntity = Tool.make("delete_entity", {
  description: `Deletes an entity. Automations triggered by entity.deleted may start. Fails while another entity links to it. ${applies}`,
  parameters: Schema.Struct({ ...EntityParams.fields, ...ChangeRequest }),
  success: ChangeOutcome,
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Delete entity")
  .annotate(Tool.Destructive, true);

const PutTemplate = Tool.make("put_template", {
  description: `Creates or replaces an approved wording template that workflows' actions can fill: a snake_case name, label, description, slots (fields the workflow fills in), and content (text by action input name, such as subject and body, with {{slot}} placeholders). New runs of saved automations that use it get the new wording. ${applies}`,
  parameters: Schema.Struct({ template: Template, ...ChangeRequest }),
  success: ChangeOutcome,
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Save template")
  .annotate(Tool.Destructive, false);

const DeleteTemplate = Tool.make("delete_template", {
  description: `Deletes a template. Saved automations that use it fail their next runs until fixed. ${applies}`,
  parameters: Schema.Struct({ ...TemplateParams.fields, ...ChangeRequest }),
  success: ChangeOutcome,
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Delete template")
  .annotate(Tool.Destructive, true);

const DecideChange = Tool.make("decide_change", {
  description:
    "Approves or cancels a change proposal that is waiting for this person, such as one prepared in the studio. The tools here that make changes apply them directly and never leave one waiting. Returns the stored decision.",
  parameters: Schema.Struct({ proposalId: Schema.String, approved: Schema.Boolean }),
  success: ChangeDecision,
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Decide a waiting change")
  .annotate(Tool.Idempotent, true);

export const EntityTools = Toolkit.make(
  ListEntityTypes,
  ListEntities,
  GetEntity,
  ListTemplates,
  PreviewChange,
  DefineEntityType,
  DeleteEntityType,
  PutEntity,
  DeleteEntity,
  PutTemplate,
  DeleteTemplate,
  DecideChange,
);

const notFound = (type: string, id: string) =>
  new EntityNotFound({ message: `No ${type} with ID ${id}` });

const changeFailure = (error: unknown) => new ChangeError({ message: messageOf(error) });

/**
 * Makes a change the person approved by calling the tool: prepares it as a proposal, so it is
 * checked and conditioned on what it read like every change, then decides it at once. A write
 * that is refused or finds the data moved on goes back to pending in the coordinator; this
 * cancels it, so nothing is left waiting for a decision nobody will make, and reports why.
 */
export const applyChange = Effect.fn("EntityMcp.applyChange")(function* (
  action: ChangeAction,
  requestId: string | undefined,
) {
  const owner = yield* callerPerson;
  const changes = yield* Changes;
  const proposal = yield* changes
    .prepare(owner, action, requestIdOf(requestId))
    .pipe(Effect.mapError(changeFailure));
  const outcome = (decision: ChangeDecision) => ({
    status: decision.status,
    proposalId: proposal.id,
    title: proposal.title,
    details: proposal.details,
    consequences: proposal.consequences,
    result: decision.result,
  });
  const decided = yield* changes.decide(owner, proposal.id, true).pipe(Effect.result);
  if (decided._tag === "Success") return outcome(decided.success);
  const withdrawn = yield* changes.decide(owner, proposal.id, false).pipe(Effect.result);
  // It may have landed after all: an approval interrupted mid-write settles rather than cancels.
  if (withdrawn._tag === "Success" && withdrawn.success.status === "applied")
    return outcome(withdrawn.success);
  return yield* changeFailure(decided.failure);
});

/** The tools' handlers, over the request's `EntityStore`, `Changes` and caller. */
export const entityToolHandlers = Effect.gen(function* () {
  const store = yield* EntityStore;
  const changes = yield* Changes;
  const caller = yield* McpCaller;
  const write = (action: ChangeAction, requestId: string | undefined) =>
    applyChange(action, requestId).pipe(
      Effect.provideService(Changes, changes),
      Effect.provideService(McpCaller, caller),
    );
  return EntityTools.of({
    list_entity_types: () => Effect.map(store.listTypes, (types) => ({ types })),
    list_entities: ({ type }) => Effect.map(store.listEntities(type), (entities) => ({ entities })),
    get_entity: ({ type, id }) =>
      Effect.flatMap(store.getEntity(type, id), (entity) =>
        entity === undefined ? Effect.fail(notFound(type, id)) : Effect.succeed({ entity }),
      ),
    list_templates: () => Effect.map(store.listTemplates, (templates) => ({ templates })),
    preview_change: ({ change }) =>
      changes.preview(change).pipe(
        Effect.map(({ title, details, consequences }) => ({ title, details, consequences })),
        Effect.mapError(changeFailure),
      ),
    define_entity_type: ({ type, requestId }) => write({ kind: "putType", type }, requestId),
    delete_entity_type: ({ type, requestId }) =>
      write({ kind: "deleteType", name: type }, requestId),
    put_entity: ({ type, id, data, requestId }) =>
      write({ kind: "putEntity", type, id, data }, requestId),
    delete_entity: ({ type, id, requestId }) =>
      write({ kind: "deleteEntity", type, id }, requestId),
    put_template: ({ template, requestId }) => write({ kind: "putTemplate", template }, requestId),
    delete_template: ({ name, requestId }) => write({ kind: "deleteTemplate", name }, requestId),
    decide_change: ({ proposalId, approved }) =>
      Effect.gen(function* () {
        const owner = yield* caller.person;
        return yield* changes
          .decide(owner, proposalId, approved)
          .pipe(Effect.mapError(changeFailure));
      }),
  });
});
