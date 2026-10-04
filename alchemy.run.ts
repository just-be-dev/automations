import alchemy from "alchemy";
import { Ai, DurableObjectNamespace, Worker } from "alchemy/cloudflare";
import type { AutomationAgent } from "./src/agent.ts";

const app = await alchemy("automations");

export const worker = await Worker("api", {
  entrypoint: "./src/index.ts",
  compatibilityDate: "2026-10-04",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    AI: Ai(),
    AUTOMATIONS: DurableObjectNamespace<AutomationAgent>("AutomationAgent", {
      className: "AutomationAgent",
      sqlite: true,
    }),
  },
  url: true,
});

await app.finalize();
