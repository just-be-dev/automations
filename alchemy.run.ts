import alchemy from "alchemy";
import {
  AccessApplication,
  AccessIdentityProvider,
  AccessPolicy,
  Ai,
  DurableObjectNamespace,
  Worker,
  createCloudflareApi,
  getAccountSubdomain,
  type AccessRule,
} from "alchemy/cloudflare";
import type { AutomationAgent } from "./src/agent.ts";

const app = await alchemy("automations");
const hostname = `automations-studio.${await getAccountSubdomain(await createCloudflareApi())}.workers.dev`;

const cloudflare = await AccessIdentityProvider("cloudflare", {
  type: "cloudflare",
  name: "Cloudflare",
  config: { restrict_to_account_members: true },
  adopt: true,
  delete: false,
});

// SAFETY: Cloudflare supports this selector, but Alchemy 0.94's AccessRule union predates it.
const accountMemberRule: unknown = { cloudflare_account_member: {} };
const policy = await AccessPolicy("owner", {
  decision: "allow",
  include: [accountMemberRule as AccessRule],
});

export const access = await AccessApplication("studio", {
  type: "self_hosted",
  domain: hostname,
  allowedIdps: [cloudflare],
  policies: [policy],
});

export const worker = await Worker("api", {
  name: "automations-studio",
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
  previewSubdomains: false,
});

if (worker.url && new URL(worker.url).hostname !== hostname)
  throw new Error("Worker hostname does not match the Access application");

await app.finalize();
