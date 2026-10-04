import type { StudioEnv } from "../alchemy.run.ts";

// NOTE: this is the Studio Worker's async entry, built by Vite. Only `/api/*` reaches it
// (`runWorkerFirst`); everything else is served from static assets. Keep logic in `src/api.ts`.
export default {
  fetch(request: Request, env: StudioEnv): Promise<Response> {
    return env.API.fetch(request);
  },
};
