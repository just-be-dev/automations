/**
 * Sends a page load on the studio's own hostname to the hub (hub-frame-rollout.md §1.6), so shared
 * and bookmarked links open in the platform's one page: `automations.just-be.dev/?automation=a1`
 * goes to `hub.just-be.dev/automations/?automation=a1`, and a preview's to
 * `/automations@<stage>/…`. The hub's own requests for the frame, API calls, the hub shell's files
 * and everything that isn't a page stay here. Plain code with no Alchemy or Effect, because the
 * Studio's edge entry runs it.
 */
import { accessJwtHeader, unverifiedClaims } from "./access-jwt.ts";

/** The platform's one page. */
export const hubOrigin = "https://hub.just-be.dev";

/**
 * The studio's pages: the paths `src/ui/route.ts` routes. Deployed stages run the Studio Worker
 * first for them, so the edge sees their page loads; everything else under them is a static file.
 */
export const pagePaths = ["/", "/templates", "/traces"];

/** What the edge knows about the hub on this stage; both empty under `alchemy dev`. */
export interface HubRedirectConfig {
  /** `/automations` on prod, `/automations@<stage>` on a preview; empty for no redirect. */
  readonly framePrefix: string;
  /** Hub prod's service token client id: its requests are the hub's frame, never redirected. */
  readonly hubClientId: string;
}

/** The request as the decision reads it. */
export interface PageRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
}

/** Directories that are never pages: APIs, the hub shell, Cloudflare's own, and webhooks. */
const excludedDirectories = ["/api", "/_hub", "/.well-known", "/cdn-cgi", "/integrations"];

const isExcluded = (pathname: string) =>
  excludedDirectories.some(
    (directory) => pathname === directory || pathname.startsWith(`${directory}/`),
  ) ||
  // `/mcp`, and anything after it.
  pathname.startsWith("/mcp") ||
  // A file: its last segment has an extension.
  pathname.slice(pathname.lastIndexOf("/") + 1).includes(".");

/** Whether the request carries hub prod's service token, as Access admitted it. */
const fromHub = (headers: Headers, hubClientId: string) => {
  if (hubClientId === "") return false;
  const jwt = headers.get(accessJwtHeader);
  // NOTE: Unverified on purpose: Access put the JWT on the request after checking the token, and
  // matching it only leaves the request where it is.
  return jwt !== null && unverifiedClaims(jwt)?.common_name === hubClientId;
};

/**
 * Where to send this request on the hub, or undefined to serve it here: only a browser's top-level
 * `GET` or `HEAD` of a page, not the hub's own request, and never without a frame prefix.
 */
export const hubRedirect = (
  request: PageRequest,
  config: HubRedirectConfig,
): string | undefined => {
  if (config.framePrefix === "") return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  if (request.headers.get("sec-fetch-dest") !== "document") return undefined;
  if (request.headers.get("sec-fetch-mode") !== "navigate") return undefined;
  if (isExcluded(request.url.pathname)) return undefined;
  if (fromHub(request.headers, config.hubClientId)) return undefined;
  return `${hubOrigin}${config.framePrefix}${request.url.pathname}${request.url.search}`;
};

/** The redirect {@link hubRedirect} chose: a `302` nothing caches. */
export const redirectResponse = (location: string) =>
  new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
