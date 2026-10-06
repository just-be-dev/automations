import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineRouteUnion } from "foldkit/route";
import type { Url } from "foldkit/url";

/**
 * The page a URL shows. `/` is the overview of every automation, `/?automation=<id>` edits one in
 * the studio, `/?automation=<id>&run=<runId>` follows one of its runs, `/templates?template=<name>`
 * manages templates, and `/entities?type=<name>` is the entity store's debug page.
 */
export const AppRoute = defineRouteUnion({
  Overview: {},
  Studio: { automationId: Schema.String },
  Run: { automationId: Schema.String, runId: Schema.String },
  Templates: { maybeTemplateName: Schema.Option(Schema.String) },
  Entities: { maybeTypeName: Schema.Option(Schema.String) },
});
export type AppRoute = typeof AppRoute.Type;

export const entitiesPath = "/entities";
export const templatesPath = "/templates";

export const routeFromUrl = (url: Url): AppRoute => {
  const params = new URLSearchParams(Option.getOrElse(url.search, () => ""));
  if (url.pathname === templatesPath) {
    return AppRoute.Templates({
      maybeTemplateName: Option.fromNullishOr(params.get("template")),
    });
  }
  if (url.pathname === entitiesPath) {
    return AppRoute.Entities({ maybeTypeName: Option.fromNullishOr(params.get("type")) });
  }
  const automationId = params.get("automation");
  const runId = params.get("run");
  if (automationId === null) {
    return AppRoute.Overview();
  }
  return runId === null ? AppRoute.Studio({ automationId }) : AppRoute.Run({ automationId, runId });
};

export const overviewHref = "/";

export const automationHref = (automationId: string) =>
  `/?${new URLSearchParams({ automation: automationId })}`;

export const entitiesHref = (maybeTypeName: Option.Option<string>) =>
  Option.match(maybeTypeName, {
    onNone: () => entitiesPath,
    onSome: (type) => `${entitiesPath}?${new URLSearchParams({ type })}`,
  });

export const templatesHref = (maybeTemplateName: Option.Option<string>) =>
  Option.match(maybeTemplateName, {
    onNone: () => templatesPath,
    onSome: (template) => `${templatesPath}?${new URLSearchParams({ template })}`,
  });

export const runHref = (automationId: string, runId: string) =>
  `/?${new URLSearchParams({ automation: automationId, run: runId })}`;
