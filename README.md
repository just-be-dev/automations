# Automations studio

A single-tenant Cloudflare Worker for designing and running sequential automations through conversation. Each automation is a list of `agent` and `webhook` steps, stored in its own SQLite-backed Durable Object. This is a prototype, not a multi-user service.

## Development

```sh
mise trust && mise install
bun run typecheck && bun run lint && bun run test
mise run dev    # alchemy dev: local Workers, Durable Object, and Vite with hot reload
```

Infrastructure and server code share one [Alchemy 2](https://alchemy.run) Effect program:

- `alchemy.run.ts` declares the Stack and the `Studio` Foldkit website.
- `src/api.ts` is the Effect-native `Api` Worker.
- `src/automation.ts` is the Durable Object that designs and runs automations with pi.

`mise run dev` runs everything locally on stage `dev_$USER` and prints the Studio URL. Dev mode skips Cloudflare Access, but it needs Cloudflare credentials for Workers AI. Run `bun alchemy profile edit --add Cloudflare` once, or set `ALCHEMY_PROFILE` to a profile that already has them.

Agent instructions are in `AGENTS.md` and `src/ui/AGENTS.md`.

## Deploy

Requires Cloudflare Zero Trust, Workers AI, and an Alchemy profile that can manage Workers and Access.

```sh
bun alchemy deploy --stage prod
```

The first deploy offers to bootstrap Alchemy's Cloudflare-hosted state store. Alchemy builds the UI with Vite and deploys two Workers:

- `Studio` serves the UI. It is the only public hostname and sits behind Cloudflare Access, which admits members of your Cloudflare account.
- `Api` has no public URL. Studio forwards `/api/*` to it over a service binding.

It also creates `AutomationsDatabase`, a D1 database that lists the automations, and applies the migrations in `migrations/` on every deploy.

Deploys also create a 30-day Access service token for machine testing. Send it as `CF-Access-Client-Id` / `CF-Access-Client-Secret`, and read it with `bun alchemy state`. Never commit it.

## Usage

Open the Studio URL, describe a process, review the graph, and save. Runs always use the last saved snapshot, not the current draft.

The open automation's ID is in the URL (`/?automation=orders`), so a reload, a new tab, or a shared link opens the same automation. The sidebar lists every automation that has a draft. Use **New** in the sidebar, or edit the ID in the header and press Enter, to open another ID. An unknown ID starts an empty automation.

```sh
curl -X POST "$STUDIO_URL/api/automations/orders/events/order.created" \
  -H "Cookie: CF_Authorization=$CF_ACCESS_JWT" -H "Content-Type: application/json" \
  -d '{"input":{"orderId":"123"}}'
```

| Endpoint                                  | Purpose                |
| ----------------------------------------- | ---------------------- |
| `GET /api/automations`                    | List automations       |
| `GET /api/automations/:id`                | Inspect an automation  |
| `POST /api/automations/:id/chat`          | Send a design message  |
| `POST /api/automations/:id/start`         | Start a run manually   |
| `POST /api/automations/:id/events/:event` | Trigger a run by event |
| `GET /api/automations/:id/runs/:runId`    | Inspect a run          |

## Caveats

- Webhook steps are delivered **at least once**, so receiving endpoints must be idempotent.
- Webhook steps POST the input and earlier results to a public HTTPS URL. Don't put secrets in step definitions.
- Chat is asynchronous: `POST /chat` returns `202` with a `pendingChat`, and the reply and new draft appear on `GET /api/automations/:id` once `pendingChat` is gone. If the agent fails, `pendingChat` stays with `status: "failed"` and an `error` until the next message.
- Runs advance through Alchemy durable callbacks. If the object is evicted mid-step, the step runs again; agent steps reuse their pi request ID instead of prompting twice.
- pi-ai, pi-durable, and Alchemy 2 are beta. Pin versions before production use.
