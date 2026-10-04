import alchemy from "alchemy";
import {
  AccessApplication,
  AccessPolicy,
  AccessServiceToken,
  Ai,
  DurableObjectNamespace,
  Worker,
  createCloudflareApi,
  getAccountSubdomain,
  type AccessRule,
} from "alchemy/cloudflare";
import type { AutomationAgent } from "./src/agent.ts";

const app = await alchemy("automations");
const api = await createCloudflareApi();
const hostname = `automations-studio.${await getAccountSubdomain(api)}.workers.dev`;

// Cloudflare creates its account sign-in provider with an empty name; manage only
// this application's policy and use the existing account-scoped provider by ID.
const idpsResponse = await api.get(`/accounts/${api.accountId}/access/identity_providers`);
if (!idpsResponse.ok) throw new Error("Could not list Cloudflare Access identity providers");
const idps = (await idpsResponse.json()) as {
  result: { id: string; type: string; config?: { restrict_to_account_members?: boolean } }[];
};
const cloudflareIdps = idps.result.filter(
  (idp) => idp.type === "cloudflare" && idp.config?.restrict_to_account_members === true,
);
const cloudflareIdp = cloudflareIdps[0];
if (!cloudflareIdp || cloudflareIdps.length !== 1)
  throw new Error("Expected one account-member Cloudflare sign-in provider");

// SAFETY: Cloudflare supports this selector, but Alchemy 0.94's AccessRule union predates it.
const accountMemberRule: unknown = { cloudflare_account_member: {} };
const policy = await AccessPolicy("owner", {
  decision: "allow",
  include: [accountMemberRule as AccessRule],
});

export const testToken = await AccessServiceToken("test-client", {
  duration: "720h",
});
const testPolicy = await AccessPolicy("test-policy", {
  decision: "non_identity",
  include: [{ service_token: { token_id: testToken } }],
});

export const access = await AccessApplication("studio", {
  type: "self_hosted",
  domain: hostname,
  allowedIdps: [cloudflareIdp.id],
  policies: [policy, testPolicy],
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
