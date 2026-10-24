/** Loads approved templates and their usage, saves wording changes, and removes templates on request. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Http } from "foldkit";
import { pushUrl } from "foldkit/navigation";
import { EntityType, Template } from "../../../entities.ts";
import { TemplateUsage } from "../../../workflow.ts";
import { errorText, requestJson } from "../../api.ts";
import { withAppBase } from "../../base-path.ts";
import { Message, toChangeMessage } from "./message.ts";
import * as Change from "../../change/index.ts";

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
  messages: [Message.GotChangeMessage, Message.FailedRequest],
  execute: ({ template }) =>
    Change.prepare({ kind: "putTemplate", template }).pipe(
      Effect.map(toChangeMessage),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const DeleteTemplate = Command.define("DeleteTemplate", {
  args: { name: Schema.String },
  messages: [Message.GotChangeMessage, Message.FailedRequest],
  execute: ({ name }) =>
    Change.prepare({ kind: "deleteTemplate", name }).pipe(
      Effect.map(toChangeMessage),
      recoverRequest,
      Effect.provide(Http.layer),
    ),
});

export const NavigateToTemplates = Command.define("NavigateToTemplates", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateToTemplates],
  execute: ({ url }) =>
    pushUrl(withAppBase(url)).pipe(Effect.as(Message.CompletedNavigateToTemplates())),
});
