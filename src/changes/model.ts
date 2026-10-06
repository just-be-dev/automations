/** Shared proposals and decisions for manual and assistant-driven studio changes. */
import * as Schema from "effect/Schema";
import { EntityData, EntityId, EntityName, EntityType } from "../entities/model.ts";
import { Template } from "../entities/templates.ts";

export const ChangeAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("putEntity"),
    type: EntityName,
    id: EntityId,
    data: EntityData,
  }),
  Schema.Struct({ kind: Schema.Literal("deleteEntity"), type: EntityName, id: EntityId }),
  Schema.Struct({ kind: Schema.Literal("putType"), type: EntityType }),
  Schema.Struct({ kind: Schema.Literal("deleteType"), name: EntityName }),
  Schema.Struct({ kind: Schema.Literal("putTemplate"), template: Template }),
  Schema.Struct({ kind: Schema.Literal("deleteTemplate"), name: EntityName }),
]);
export type ChangeAction = typeof ChangeAction.Type;

export const ChangeDetail = Schema.Struct({
  label: Schema.String,
  before: Schema.String,
  after: Schema.String,
});
export const ChangeProposal = Schema.Struct({
  id: Schema.String,
  action: ChangeAction,
  title: Schema.String,
  details: Schema.Array(ChangeDetail),
  consequences: Schema.Array(Schema.String),
  confirmLabel: Schema.String,
});
export type ChangeProposal = typeof ChangeProposal.Type;

export const ChangeDecision = Schema.Struct({
  status: Schema.Literals(["applied", "cancelled"]),
  result: Schema.Json,
});
export type ChangeDecision = typeof ChangeDecision.Type;
