import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Http } from "foldkit";
import { pushUrl } from "foldkit/navigation";
import { EntityType, Template } from "../../../entities.ts";
import { TemplateUsage } from "../../../workflow.ts";
import { errorText, requestJson, sendJson } from "../../api.ts";
import { Message } from "./message.ts";

const recoverRequest = Effect.catch((error: unknown) =>
  Effect.succeed(Message.FailedRequest({ error: errorText(error) })),
);

export const LoadCatalog = Command.define("LoadCatalog", {
  messages: [Message.SucceededLoadCatalog, Message.FailedLoadCatalog],
  execute: Effect.all(
    [
      requestJson("/api/templates", Schema.Array(Template)),
      requestJson("/api/entities/types", Schema.Array(EntityType)),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.map(([templates, types]) => Message.SucceededLoadCatalog({ templates, types })),
    Effect.catch((error) => Effect.succeed(Message.FailedLoadCatalog({ error: errorText(error) }))),
    Effect.provide(Http.layer),
  ),
});

export const LoadUsage = Command.define("LoadUsage", {
  args: { name: Schema.String },
  messages: [Message.SucceededLoadUsage, Message.FailedLoadUsage],
  execute: ({ name }) =>
    requestJson(`/api/templates/${name}/automations`, TemplateUsage).pipe(
      Effect.map((usage) => Message.SucceededLoadUsage({ name, usage })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedLoadUsage({ name, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});

export const SaveTemplate = Command.define("SaveTemplate", {
  args: { template: Template, isNew: Schema.Boolean },
  messages: [Message.SucceededSaveTemplate, Message.FailedRequest],
  execute: ({ template, isNew }) =>
    sendJson("PUT", `/api/templates/${template.name}`, Template, template).pipe(
      Effect.map((saved) => Message.SucceededSaveTemplate({ template: saved, isNew })),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const DeleteTemplate = Command.define("DeleteTemplate", {
  args: { name: Schema.String },
  messages: [Message.SucceededDeleteTemplate, Message.FailedRequest],
  execute: ({ name }) =>
    sendJson("DELETE", `/api/templates/${name}`, Schema.Unknown).pipe(
      Effect.as(Message.SucceededDeleteTemplate({ name })),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const NavigateToTemplates = Command.define("NavigateToTemplates", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateToTemplates],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateToTemplates())),
});
