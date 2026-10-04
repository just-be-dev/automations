import alchemy from "alchemy";
import { Ai, DurableObjectNamespace, Worker } from "alchemy/cloudflare";
import type { AutomationAgent } from "./src/agent.ts";

const app = await alchemy("automations");
const token = process.env.API_TOKEN;
if (!token) throw new Error("Set API_TOKEN before deploying");

export const worker = await Worker("api", {
  entrypoint: "./src/index.ts",
  compatibilityDate: "2026-10-04",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    AI: Ai(),
    API_TOKEN: alchemy.secret(token),
    AUTOMATIONS: DurableObjectNamespace<AutomationAgent>("AutomationAgent", {
      className: "AutomationAgent",
      sqlite: true,
    }),
  },
  url: true,
});

await app.finalize();
