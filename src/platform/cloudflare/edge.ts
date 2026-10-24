import { admittedEmail, forwardToHub, isHubApiPath, isHubPath } from "./hub.ts";
import { hubRedirect, redirectResponse } from "./hub-redirect.ts";
import type { StudioEnv } from "./stack.ts";

/** What workerd puts on the context of a request Access admitted: the application's audience. */
type EdgeContext = { readonly access?: { readonly aud?: string } };

interface Fetcher {
  readonly fetch: (request: Request) => Promise<Response>;
}

/** What the edge reads of the Studio's env (`StudioEnv`, which must stay assignable to it). */
export interface EdgeEnv extends Readonly<Record<string, unknown>> {
  readonly API: Fetcher;
  readonly ASSETS: Fetcher;
  readonly HUB_FRAME_PREFIX: string;
  readonly HUB_CLIENT_ID: string;
}

// The Studio's real env must keep everything the edge reads.
type _StudioEnvFitsEdge = StudioEnv extends EdgeEnv ? true : never;
const _studioEnvFitsEdge: _StudioEnvFitsEdge = true;
void _studioEnvFitsEdge;

const isApiPath = (url: URL) => url.pathname === "/api" || url.pathname.startsWith("/api/");

// NOTE: this is the Studio Worker's async entry, built by Vite. Only `/api/*`, the hub shell's
// `/_hub/*` and, on deployed stages, the studio's pages reach it (`runWorkerFirst`); everything else
// is served from static assets. It only forwards: `/_hub/*` to the agents project (hub.ts), `/api/*`
// to the private Api, a page load to the hub (hub-redirect.ts), and any other page to the assets.
// Its import graph must not reach Alchemy (stack.ts is imported for its type only).
export default {
  async fetch(request: Request, env: EdgeEnv, ctx: EdgeContext): Promise<Response> {
    const url = URL.parse(request.url);
    if (url !== null && isHubPath(url)) {
      const email = isHubApiPath(url) ? await admittedEmail(request, ctx.access?.aud) : null;
      return forwardToHub(request, url, env, email);
    }
    if (url === null || isApiPath(url)) return env.API.fetch(request);
    const hub = hubRedirect(
      { method: request.method, url, headers: request.headers },
      { framePrefix: env.HUB_FRAME_PREFIX, hubClientId: env.HUB_CLIENT_ID },
    );
    return hub === undefined ? env.ASSETS.fetch(request) : redirectResponse(hub);
  },
};
