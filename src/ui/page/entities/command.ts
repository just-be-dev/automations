/** Loads and changes entity types and records, returning any automation runs started by a record save. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Http } from "foldkit";
import { pushUrl } from "foldkit/navigation";
import { EntityRecord, EntityType, Subject } from "../../../entities.ts";
import { errorText, requestJson, sendJson } from "../../api.ts";
import { Message } from "./message.ts";
import { Triggered } from "./model.ts";

const recoverRequest = Effect.catch((error: unknown) =>
  Effect.succeed(Message.FailedRequest({ error: errorText(error) })),
);

export const LoadTypes = Command.define("LoadTypes", {
  messages: [Message.SucceededLoadTypes, Message.FailedLoadTypes],
  execute: requestJson("/api/entities/types", Schema.Array(EntityType)).pipe(
    Effect.map((types) => Message.SucceededLoadTypes({ types })),
    Effect.catch((error) => Effect.succeed(Message.FailedLoadTypes({ error: errorText(error) }))),
    Effect.provide(Http.layer),
  ),
});

export const LoadEntities = Command.define("LoadEntities", {
  args: { type: Schema.String },
  messages: [Message.SucceededLoadEntities, Message.FailedLoadEntities],
  execute: ({ type }) =>
    requestJson(`/api/entities/${type}`, Schema.Array(EntityRecord)).pipe(
      Effect.map((entities) => Message.SucceededLoadEntities({ type, entities })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedLoadEntities({ type, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});

export const SaveType = Command.define("SaveType", {
  args: { type: EntityType, isNew: Schema.Boolean },
  messages: [Message.SucceededSaveType, Message.FailedRequest],
  execute: ({ type, isNew }) =>
    sendJson("PUT", `/api/entities/types/${type.name}`, EntityType, type).pipe(
      Effect.map((saved) => Message.SucceededSaveType({ type: saved, isNew })),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const DeleteType = Command.define("DeleteType", {
  args: { type: Schema.String },
  messages: [Message.SucceededDeleteType, Message.FailedRequest],
  execute: ({ type }) =>
    sendJson("DELETE", `/api/entities/types/${type}`, Schema.Unknown).pipe(
      Effect.as(Message.SucceededDeleteType({ type })),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

const SavedEntity = Schema.Struct({ entity: Subject, triggered: Schema.Array(Triggered) });

export const SaveEntity = Command.define("SaveEntity", {
  args: { type: Schema.String, id: Schema.String, data: Schema.Record(Schema.String, Schema.Json) },
  messages: [Message.SucceededSaveEntity, Message.FailedRequest],
  execute: ({ type, id, data }) =>
    sendJson("PUT", `/api/entities/${type}/${encodeURIComponent(id)}`, SavedEntity, { data }).pipe(
      Effect.map((saved) => Message.SucceededSaveEntity(saved)),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const DeleteEntity = Command.define("DeleteEntity", {
  args: { type: Schema.String, id: Schema.String },
  messages: [Message.SucceededDeleteEntity, Message.FailedRequest],
  execute: ({ type, id }) =>
    sendJson("DELETE", `/api/entities/${type}/${encodeURIComponent(id)}`, Schema.Unknown).pipe(
      Effect.as(Message.SucceededDeleteEntity({ type, id })),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const NavigateToEntities = Command.define("NavigateToEntities", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateToEntities],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateToEntities())),
});
