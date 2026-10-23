import { admittedEmail, forwardToHub, isHubApiPath, isHubPath } from "./hub.ts";
import type { StudioEnv } from "./stack.ts";

/** What workerd puts on the context of a request Access admitted: the application's audience. */
type EdgeContext = ExecutionContext & { readonly access?: { readonly aud?: string } };

// NOTE: this is the Studio Worker's async entry, built by Vite. Only `/api/*` and the hub shell's
// `/_hub/*` reach it (`runWorkerFirst`); everything else is served from static assets. It only
// forwards: `/_hub/*` to the agents project (hub.ts), everything else to the private Api. Its
// import graph must not reach Alchemy (stack.ts is imported for its type only).
export default {
  async fetch(request: Request, env: StudioEnv, ctx: EdgeContext): Promise<Response> {
    const url = URL.parse(request.url);
    if (url !== null && isHubPath(url)) {
      const email = isHubApiPath(url) ? await admittedEmail(request, ctx.access?.aud) : null;
      return forwardToHub(request, url, env, email);
    }
    return env.API.fetch(request);
  },
};
