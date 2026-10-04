# Automations studio

A single-tenant Cloudflare Worker for designing and running sequential automations through conversation. Each automation is a list of `agent` and `webhook` steps, stored in its own SQLite-backed Durable Object. This is a prototype, not a multi-user service.

## Development

```sh
mise trust && mise install
bun run typecheck && bun run lint && bun run test
bun run dev     # UI with hot reload; /api proxies to a local Worker on :8787
bun run build   # required before each deploy
```

The UI uses Foldkit and `@foldkit/ui`, built by Vite with the Foldkit plugin. Run `bun run build` before each Alchemy deployment; Alchemy uploads `dist/` through the Worker's `ASSETS` binding. Run `mise run dev` (`alchemy dev`) to develop locally: Alchemy emulates the Worker and Durable Object, proxies the AI binding to Workers AI, and starts Vite with hot reload, proxying `/api` to the Worker. Dev mode skips Cloudflare Access and needs Cloudflare credentials only for Workers AI; run `alchemy login cloudflare` first, or set `ALCHEMY_PROFILE` to a profile that has them. `bun run preview` serves the production UI build.

Agent instructions are in `AGENTS.md` and `src/ui/AGENTS.md`.

## Deploy

Requires Cloudflare Zero Trust, Workers AI, and an Alchemy profile with `access:write`.

```sh
ALCHEMY_PASSWORD=... bun alchemy deploy ./alchemy.run.ts --profile automations
```

Keep `ALCHEMY_PASSWORD`; it decrypts local state on later deploys. The Worker is published at `automations-studio.<subdomain>.workers.dev` behind Cloudflare Access, which only admits members of your Cloudflare account. Deployment also creates a 30-day Access service token for machine testing (send it as `CF-Access-Client-Id` / `CF-Access-Client-Secret`). Never commit it.

## Usage

Open the Worker URL, enter an automation ID, describe a process, review the graph, and save. Runs always use the last saved snapshot, not the current draft.

```sh
curl -X POST "$WORKER_URL/api/automations/orders/events/order.created" \
  -H "Cookie: CF_Authorization=$CF_ACCESS_JWT" -H "Content-Type: application/json" \
  -d '{"input":{"orderId":"123"}}'
```

| Endpoint                                    | Purpose                  |
| ------------------------------------------- | ------------------------ |
| `GET /api/automations/:id`                  | Inspect an automation    |
| `POST /api/automations/:id/start`           | Start a run manually     |
| `POST /api/automations/:id/events/:event`   | Trigger a run by event   |
| `GET /api/automations/:id/runs/:runId`      | Inspect a run            |

## Caveats

- Webhook steps are delivered **at least once**, so receiving endpoints must be idempotent.
- Webhook steps POST the input and earlier results to a public HTTPS URL. Don't put secrets in step definitions.
- Pi and PiHarness are beta ([docs](https://developers.cloudflare.com/agents/harnesses/pi/)). Pin versions before production use.
- The project stays on Alchemy 0.94; Alchemy 2 is a separate beta API.
