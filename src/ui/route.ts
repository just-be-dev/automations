/** Connects studio URLs to pages and selections, keeping navigation links consistent with URL parsing. */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineRouteUnion } from "foldkit/route";
import type { Url } from "foldkit/url";

/**
 * The page a URL shows. `/` is the overview of every automation, `/?automation=<id>` edits one in
 * the studio, `/?automation=<id>&run=<runId>` follows one of its runs, `/templates?template=<name>`
 * manages templates, `/entities?type=<name>` is the entity store's debug page, and
 * `/traces?automation=<id>&run=<runId>` is the debug page for agent traces: the planner's
 * conversation, or the one a run's agent steps share.
 */
export const AppRoute = defineRouteUnion({
  Overview: {},
  Studio: { automationId: Schema.String },
  Run: { automationId: Schema.String, runId: Schema.String },
  Templates: { maybeTemplateName: Schema.Option(Schema.String) },
  Entities: { maybeTypeName: Schema.Option(Schema.String) },
  Traces: {
    maybeAutomationId: Schema.Option(Schema.String),
    maybeRunId: Schema.Option(Schema.String),
  },
});
export type AppRoute = typeof AppRoute.Type;

export const entitiesPath = "/entities";
export const templatesPath = "/templates";
export const tracesPath = "/traces";

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
  if (url.pathname === tracesPath) {
    return AppRoute.Traces({
      maybeAutomationId: Option.fromNullishOr(params.get("automation")),
      maybeRunId: Option.fromNullishOr(params.get("run")),
    });
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

/** The traces page: the planner's trace with only an automation, a run's with both. */
export const tracesHref = (
  maybeAutomationId: Option.Option<string>,
  maybeRunId: Option.Option<string>,
) =>
  Option.match(maybeAutomationId, {
    onNone: () => tracesPath,
    onSome: (automation) =>
      `${tracesPath}?${new URLSearchParams(
        Option.match(maybeRunId, {
          onNone: () => ({ automation }),
          onSome: (run) => ({ automation, run }),
        }),
      )}`,
  });
