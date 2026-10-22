/** Loads and changes entity types and records through confirmed proposals. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Http } from "foldkit";
import { pushUrl } from "foldkit/navigation";
import { EntityRecord, EntityType } from "../../../entities.ts";
import { errorText, requestJson } from "../../api.ts";
import { Message, toChangeMessage } from "./message.ts";
import * as Change from "../../change/index.ts";

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
  messages: [Message.GotChangeMessage, Message.FailedRequest],
  execute: ({ type }) =>
    Change.prepare({ kind: "putType", type }).pipe(
      Effect.map(toChangeMessage),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const DeleteType = Command.define("DeleteType", {
  args: { type: Schema.String },
  messages: [Message.GotChangeMessage, Message.FailedRequest],
  execute: ({ type }) =>
    Change.prepare({ kind: "deleteType", name: type }).pipe(
      Effect.map(toChangeMessage),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const SaveEntity = Command.define("SaveEntity", {
  args: { type: Schema.String, id: Schema.String, data: Schema.Record(Schema.String, Schema.Json) },
  messages: [Message.GotChangeMessage, Message.FailedRequest],
  execute: ({ type, id, data }) =>
    Change.prepare({ kind: "putEntity", type, id, data }).pipe(
      Effect.map(toChangeMessage),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const DeleteEntity = Command.define("DeleteEntity", {
  args: { type: Schema.String, id: Schema.String },
  messages: [Message.GotChangeMessage, Message.FailedRequest],
  execute: ({ type, id }) =>
    Change.prepare({ kind: "deleteEntity", type, id }).pipe(
      Effect.map(toChangeMessage),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const NavigateToEntities = Command.define("NavigateToEntities", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateToEntities],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateToEntities())),
});
