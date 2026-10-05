import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineRouteUnion } from "foldkit/route";
import type { Url } from "foldkit/url";

/**
 * The page a URL shows. `/` is the overview of every automation, `/?automation=<id>` edits one in
 * the studio, and `/?automation=<id>&run=<runId>` follows one of its runs.
 */
export const AppRoute = defineRouteUnion({
  Overview: {},
  Studio: { automationId: Schema.String },
  Run: { automationId: Schema.String, runId: Schema.String },
});
export type AppRoute = typeof AppRoute.Type;

export const routeFromUrl = (url: Url): AppRoute => {
  const params = new URLSearchParams(Option.getOrElse(url.search, () => ""));
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

export const runHref = (automationId: string, runId: string) =>
  `/?${new URLSearchParams({ automation: automationId, run: runId })}`;
