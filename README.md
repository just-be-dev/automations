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

Set `API_TOKEN` to a long, random secret in your local shell (do not commit it); authenticate with Cloudflare for Alchemy deployment. `mise exec -- bun alchemy.run.ts` deploys the Worker, AI binding, and SQLite Durable Object through Alchemy. Deployment requires Cloudflare credentials and a Workers AI-enabled account. Cloudflare's PiHarness is beta; pin/validate package versions before production use. The model defaults to `@cf/moonshotai/kimi-k2.7-code`.

Open the Worker URL, enter the shared API token and an automation ID, describe a process, review the graph, then save. The saved snapshot (not later drafts) runs when **Start manually** is clicked. The browser never stores the token. To trigger a saved workflow with event `order.created`:

```sh
curl -X POST "$WORKER_URL/api/automations/orders/events/order.created" \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"input":{"orderId":"123"}}'
```

You can also POST `/api/automations/orders/start` with the same JSON body, inspect `/api/automations/orders` and GET `/api/automations/orders/runs/<run-id>`. Events are authenticated HTTP callbacks; this version does not subscribe to third-party event sources or schedule timers. Both triggers use the same shared bearer token. HTTP steps send the input and previous results to a public HTTPS URL. Do not put secrets in step definitions. Restrict deployment access and add stronger tenant/auth and endpoint allowlisting before exposing untrusted users.

The source-of-truth IR is a validated list of `agent` and `webhook` steps. `graph()` derives nodes and edges for human review, and saving freezes the current draft. Cloudflare's [PiHarness changelog](https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/), [Pi docs](https://developers.cloudflare.com/agents/harnesses/pi/), and [Alchemy documentation](https://alchemy.run/migrating-from-v1) describe the beta APIs used here. The project uses Alchemy 0.94 because Alchemy 2 is a separate beta API with different Worker declarations.
