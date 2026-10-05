# Automations studio

A single-tenant Cloudflare Worker for designing and running automations through conversation. An automation is about entities, such as employees, kept in an entity store (D1 today). A change to an entity starts a run, and the run works through steps: built-in capabilities (agents, waits, branches, parallel work, decisions, and requests to people) and operations on connections (email, Slack, a calendar, HTTP). Each automation lives in its own SQLite-backed Durable Object, which journals its runs so they survive waits of days. This is a prototype, not a multi-user service.

## Development

```sh
mise trust && mise install
bun run typecheck && bun run lint && bun run test
mise run dev    # alchemy dev: local Workers, Durable Object, and Vite with hot reload
```

Infrastructure and server code share one [Alchemy 2](https://alchemy.run) Effect program:

- `alchemy.run.ts` declares the Stack and the `Studio` Foldkit website.
- `src/api.ts` is the Effect-native `Api` Worker.
- `src/automation.ts` is the Durable Object that designs automations with pi and runs them with `src/interpreter.ts`.

`mise run dev` runs everything locally on stage `dev_$USER` and prints the Studio URL. Dev mode skips Cloudflare Access, but it needs Cloudflare credentials for Workers AI. Run `bun alchemy profile edit --add Cloudflare` once, or set `ALCHEMY_PROFILE` to a profile that already has them.

The workflow format is described in [`docs/workflow-dsl.md`](docs/workflow-dsl.md). Agent instructions are in `AGENTS.md` and `src/ui/AGENTS.md`.

## Deploy

Requires Cloudflare Zero Trust, Workers AI, and an Alchemy profile that can manage Workers and Access.

```sh
bun alchemy deploy --stage prod
```

The first deploy offers to bootstrap Alchemy's Cloudflare-hosted state store. Alchemy builds the UI with Vite and deploys two Workers:

- `Studio` serves the UI. It is the only public hostname and sits behind Cloudflare Access, which admits members of your Cloudflare account.
- `Api` has no public URL. Studio forwards `/api/*` to it over a service binding.

It also creates `AutomationsDatabase`, a D1 database that lists the automations and holds the entity types, the entities, and which automations subscribe to each type. Alchemy applies the migrations in `migrations/` on every deploy. They seed an `employee` type and two employees.

Deploys also create a 30-day Access service token for machine testing. Send it as `CF-Access-Client-Id` / `CF-Access-Client-Secret`, and read it with `bun alchemy state`. Never commit it.

## Usage

Open the Studio URL, describe a process, review the steps, and save. Runs always use the last saved snapshot, not the current draft.

The studio opens on the **Overview**: the runs in flight across every automation, and every automation with how it starts and how its last run went. Start a saved automation from there with **Run**. If it is about an entity, such as an employee, pick which one first. Draft-only automations are listed but can't run until they are saved. The page refreshes every 5 seconds while a run is in flight.

The open automation's ID is in the URL (`/?automation=onboarding`), so a reload, a new tab, or a shared link opens the same automation. Clicking a run on the overview or in the studio opens it in a panel on the right, so it can play out while you keep editing or watching the overview. The panel follows the run step by step and lets people answer its open tasks; its expand button opens the run's own page (`/?automation=onboarding&run=<runId>`), and a modified click on a run opens that page in a new tab. The run page shows the saved version the run started with, not the draft, so it leaves out the designer chat; **Edit automation** goes back to it. The sidebar lists every automation that has a draft. Use **New** in the sidebar, or edit the ID in the header and press Enter, to open another ID. An unknown ID starts an empty automation.

A saved automation with an entity trigger starts when a matching entity changes. For example, giving the seeded `ada` a start date starts an onboarding automation that watches `employee.start_date`:

```sh
curl -X PUT "$STUDIO_URL/api/entities/employee/ada" \
  -H "Cookie: CF_Authorization=$CF_ACCESS_JWT" -H "Content-Type: application/json" \
  -d '{"data":{"start_date":"2026-11-02"}}'
```

The response lists the runs the change `triggered`. People answer human steps from the run in the studio, or with `POST .../tasks/:stepId`.

| Endpoint                                                   | Purpose                                       |
| ---------------------------------------------------------- | --------------------------------------------- |
| `GET /api/overview`                                        | Each automation's trigger and runs in flight  |
| `GET /api/automations`                                     | List automations                              |
| `GET /api/automations/:id`                                 | Inspect an automation and its recent runs     |
| `POST /api/automations/:id/chat`                           | Send a design message                         |
| `POST /api/automations/:id/save`                           | Save the draft and subscribe to its trigger   |
| `POST /api/automations/:id/start`                          | Start a run by hand (`{ "subject": "<id>" }`) |
| `GET /api/automations/:id/runs/:runId`                     | Inspect a run, its steps, and its tasks       |
| `POST /api/automations/:id/runs/:runId/tasks/:stepId`      | Answer a human step                           |
| `GET /api/entities/types`, `PUT /api/entities/types/:type` | List or define entity types                   |
| `GET /api/entities/:type`, `GET /api/entities/:type/:id`   | Read entities                                 |
| `PUT /api/entities/:type/:id`                              | Create or update an entity and start its runs |

## Caveats

- Email, Slack, and Calendar are simulated until they have credentials. Their steps succeed, contact nothing, and record what they would have sent with `simulated: true`. A human step's `notify` is recorded, not sent.
- `http.post` steps are delivered **at least once**, with an `Idempotency-Key` header that stays the same across retries, so receiving endpoints must be idempotent. Without a `body`, they POST the run's subject and step records to a public HTTPS URL. Don't put secrets in step definitions.
- Chat is asynchronous: `POST /chat` returns `202` with a `pendingChat`, and the reply and new draft appear on `GET /api/automations/:id` once `pendingChat` is gone. Until then the response includes `progress`, a plain phrase such as "Planning the steps…". If the agent fails, `pendingChat` stays with `status: "failed"` and an `error` until the next message.
- Runs advance through Alchemy durable callbacks that replay them from a journal in the Durable Object's storage. If the Durable Object is evicted mid-step, that step runs again; agent steps reuse their pi request ID instead of prompting twice.
- Workflows and runs written before entity-based triggers were discarded; the Automation object drops them when it reads them.
- pi-ai, pi-durable, and Alchemy 2 are beta. Pin versions before production use.
