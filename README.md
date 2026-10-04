# Automations studio

A single-tenant Cloudflare Worker for drafting, reviewing, and running sequential automations. Each automation ID maps to a SQLite-backed Agent Durable Object. The design conversation and agent steps use the Cloudflare Agents SDK's beta PiHarness / pi-durable integration; drafts and saved snapshots are separate. Agent steps use separate Pi sessions; scheduled Agent callbacks resume workflow steps after eviction. Webhook POSTs are **at least once** if interrupted after sending and before checkpointing: make receiving endpoints idempotent. This is a prototype, not a multi-user service.

## Setup

```sh
mise trust
mise install
mise exec -- bun install
mise exec -- bun run typecheck
mise exec -- bun run lint
mise exec -- bun run test
```

Enable Cloudflare Zero Trust on the account, then authenticate Alchemy with Cloudflare using a profile granted `access:write`. Set `ALCHEMY_PASSWORD` to a persistent private passphrase and run `mise exec -- bun alchemy deploy ./alchemy.run.ts --profile automations` (or replace `automations` with that profile). Keep the passphrase: Alchemy needs it to decrypt its local state on future deployments. Alchemy reuses the account's existing Cloudflare sign-in provider, creates an Access policy restricted to **members of the current Cloudflare account**, and protects the application **before** publishing the Worker at `automations-studio.<your-account-subdomain>.workers.dev`. For machine testing it also creates a 30-day Cloudflare Access service token, encrypted in local Alchemy state, with a policy limited to that token and this application; send its client ID and secret as `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. Never commit or share the credentials. Alchemy discovers the subdomain using the authenticated Cloudflare account; no application API token or email allowlist is needed. It also provisions the AI binding and SQLite Durable Object. Deployment requires a Workers AI-enabled account. Preview subdomains are disabled. Cloudflare's PiHarness is beta; pin/validate package versions before production use. The model defaults to `@cf/moonshotai/kimi-k2.7-code`.

Open the Worker URL, sign in through Cloudflare Access, enter an automation ID, describe a process, review the graph, then save. The saved snapshot (not later drafts) runs when **Start manually** is clicked. To trigger a saved workflow with event `order.created` from an authenticated browser session, POST:

```sh
curl -X POST "$WORKER_URL/api/automations/orders/events/order.created" \
  -H "Cookie: CF_Authorization=$CF_ACCESS_JWT" -H "Content-Type: application/json" \
  -d '{"input":{"orderId":"123"}}'
```

You can also POST `/api/automations/orders/start` with the same JSON body, inspect `/api/automations/orders` and GET `/api/automations/orders/runs/<run-id>`. Events are Access-protected HTTP callbacks; this version does not subscribe to third-party event sources or schedule timers. For an unattended external event source, configure a Cloudflare Access service token and add a narrowly scoped service-auth policy; the Cloudflare-account-member policy here intentionally rejects unauthenticated webhooks. HTTP steps send the input and previous results to a public HTTPS URL. Do not put secrets in step definitions. Add tenant isolation and endpoint allowlisting before exposing untrusted users.

The source-of-truth IR is a validated list of `agent` and `webhook` steps. `graph()` derives nodes and edges for human review, and saving freezes the current draft. Cloudflare's [PiHarness changelog](https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/), [Pi docs](https://developers.cloudflare.com/agents/harnesses/pi/), and [Alchemy documentation](https://alchemy.run/migrating-from-v1) describe the beta APIs used here. The project uses Alchemy 0.94 because Alchemy 2 is a separate beta API with different Worker declarations.
