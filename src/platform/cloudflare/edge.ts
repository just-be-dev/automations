import type { StudioEnv } from "./stack.ts";

// NOTE: this is the Studio Worker's async entry, built by Vite. Only `/api/*` reaches it
// (`runWorkerFirst`); everything else is served from static assets.
export default {
  fetch(request: Request, env: StudioEnv): Promise<Response> {
    return env.API.fetch(request);
  },
};
