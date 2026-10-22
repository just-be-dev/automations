import { forwardToHub, isHubPath } from "./hub.ts";
import type { StudioEnv } from "./stack.ts";

// NOTE: this is the Studio Worker's async entry, built by Vite. Only `/api/*` and the hub shell's
// `/_hub/*` reach it (`runWorkerFirst`); everything else is served from static assets. It only
// forwards: `/_hub/*` to the agents project (hub.ts), everything else to the private Api.
export default {
  fetch(request: Request, env: StudioEnv): Promise<Response> {
    const url = URL.parse(request.url);
    if (url !== null && isHubPath(url)) return forwardToHub(request, url, env);
    return env.API.fetch(request);
  },
};
