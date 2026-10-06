# Automations studio

A single-tenant Cloudflare Worker for designing and running automations through conversation. An automation is about entities, such as employees, kept in an entity store (D1 today). A change to an entity starts a run, and the run works through steps: built-in capabilities (agents, waits, branches, parallel work, decisions, and requests to people) and operations on connections (email, Slack, a calendar, HTTP). Each automation lives in its own SQLite-backed Durable Object, which journals its runs so they survive waits of days. This is a prototype, not a multi-user service.

## Development

```sh
mise trust && mise install
bun run typecheck && bun run lint && bun run test
mise run dev    # alchemy dev: local Workers, Durable Object, and Vite with hot reload
```

Infrastructure and server code share one [Alchemy 2](https://alchemy.run) Effect program:

- `alchemy.run.ts` re-exports `src/platform/cloudflare/stack.ts`, which declares the Stack and the `Studio` Foldkit website.
- `src/platform/cloudflare/` owns the Workers, Durable Object host, D1 adapters, Workers AI and pi SQLite implementation, Access identity, resource bindings, and deployment configuration. It composes domain services per request or per Durable Object instance and captures their runtime dependencies.
- `src/http/api.ts` composes platform-independent routes. Handlers use `Automations`, `EntityStore`, `AutomationIndex`, `EntitySubscribers`, and `RequestIdentity`, never Cloudflare bindings.
- `src/automation/` owns designing, saving, and running an automation. `application.ts` composes a design session (`design-session.ts`) and run coordinator (`runs.ts`) over shared workflow snapshots and catalog access (`workflow-store.ts`), and returns public operations plus job handlers. Neither lifecycle depends on the other. `service.ts` lets callers address automations without knowing where they live. `AutomationHost` provides persistence and durable jobs together so scheduling and writes share a transaction.
- `src/agents/planner/` owns the planner agent: its instructions, the tools it edits the draft with, and the progress shown while it works.
- `src/workflow/` owns the workflow DSL, run models, catalog checks, interpreter, and durable engine.
- `src/entities/` owns entity models, approved templates, the `EntityStore` service and memory layer, and subscriber notifications shared by HTTP and MCP writes.
- `src/connections/` separates the pure operation registry from its executor; `src/ai/pi.ts` defines the conversation service contract, independent of its host.

`src/workflow.ts`, `src/entities.ts`, and `src/connections.ts` retain the UI's domain imports. Backend code imports the owning modules directly; `src/ui/` is organized independently.

Dependencies point from platform adapters into domains, never back. `src/platform/boundary.test.ts` checks that boundary. Application tests use an in-memory host and scripted agent; native Worker and Durable Object behavior still needs local end-to-end checks.

Saving is an application operation, not HTTP orchestration: validate the draft, store the saved snapshot, update its entity subscription, then best-effort update the directory. Snapshot storage and subscriptions do not share a transaction. If subscribing fails, the caller gets the error but the snapshot remains saved; retry saving to repair the subscription. A directory failure does not fail a save.

Runs have three distinct representations:

- `Run` (`workflow/run.ts`) is the persisted application record: the executed snapshot, status, step records and human tasks. `automation/run-store.ts` owns its updates and the `execution:<executionId>` lookup to a run ID. It brands stored IDs internally without changing the public schema.
- `ExecutionValues` (`workflow/execution.ts`) holds the subject and completed step values during the interpreter's walk. Each replay rebuilds these values; it never seeds them from `Run.steps`.
- The journal (`workflow/durable-engine.ts`, under `wf:<executionId>:`) is authoritative for completed Activities, deferred answers, clocks and the execution outcome. Reports and outcomes update the application record, which is what people see.

`RunId` identifies a run record; `ExecutionId` identifies its engine journal. Their types are distinct, but both still serialize as plain strings. HTTP paths and durable callbacks decode into the appropriate ID, and the native Effect Workflow interface's strings are branded at the engine boundary. Storage keys, callback payloads and workflow results keep their existing formats.

`mise run dev` runs everything locally on stage `dev_$USER` and prints the Studio URL. Dev mode skips Cloudflare Access, but it needs Cloudflare credentials for Workers AI. Run `bun alchemy profile edit --add Cloudflare` once, or set `ALCHEMY_PROFILE` to a profile that already has them.

The workflow format is described in [`docs/workflow-dsl.md`](docs/workflow-dsl.md). Agent instructions are in `AGENTS.md` and `src/ui/AGENTS.md`.

### Evals

The tests script every model. The evals in `evals/` call the real ones, on Workers AI, to measure how well each LLM call does its job: the planner, the namer, the progress classifier, and agent and decide steps. The calls run in an Evals Worker that `mise run eval` starts locally with `alchemy dev` on its own stage (`eval_$USER`), so Workers AI is reached through Alchemy's binding with the same Cloudflare profile as `mise run dev`, and no API token:

```sh
mise run eval                                                            # every eval
mise run eval planner --case onboarding --trials 3                       # one eval, matching cases, three tries each
mise run eval --list                                                     # the evals and their cases, without running them
EVAL_PLANNER_MODEL=@cf/… mise run eval planner agent decide              # try another model for pi
mise run check                                                           # typecheck, lint, tests, format, then the evals
```

An eval is a file, `evals/<name>.eval.ts`, that holds only cases and assertions. Each case gives an input and checks by name, written like tests with `expect` from `bun:test`; checks in `every` apply to every case, and `judged` asks an LLM judge for what code can't check, such as whether a reply reads plainly:

```ts
export default defineEval({
  call: decide,
  minimum: 0.9,
  every: { "answers with a decision": (output) => expect(output.problem).toBeUndefined() },
  cases: {
    ticket: {
      input: {
        question: "Which team should handle this ticket?",
        options: { billing: "…", technical: "…" },
        state,
      },
      checks: { "picks billing": (output) => expect(output.choice).toBe("billing") },
    },
  },
});
```

- `evals/calls/` holds one call per LLM call site: it runs the production code for an input (`planDraft` with the real tools, the namer, a step's prompt) and returns what the checks read, with helpers for reading it.
- `evals/framework/` runs them. In Bun: `cli.ts` is `mise run eval`, which finds every `*.eval.ts` itself; `client.ts` starts the Evals Worker and sends it each case's input; `eval.ts` defines and scores evals and runs their checks; `report.ts` prints and saves results. In the Worker (`worker.ts`, its own stack in `stack.ts`): `models.ts` gives the calls the Workers AI binding and opens pi on in-memory storage, and `judge.ts` is the judge (`EVAL_JUDGE_MODEL` changes its model, the planner's by default). Each call's input and output have Schemas, which decode them on both sides of the Worker.
- `evals/fixtures.ts` holds what the evals work with: a People Ops entity store, a new hire, and drafts for the planner to edit.

Models vary between runs, so use `--trials` before trusting a change. The report lists failed checks and compares each case with the last saved run in `evals/results/` (ignored by git).

Each eval has a `minimum`: the share of its checks that must pass across every case and trial. Below it, the run fails, so a prompt or model change that makes things worse fails `mise run eval` and `mise run check`. Keep each minimum a little under what the models reach, and raise it as they improve. The evals stay out of `mise run test`, which has to be fast and give the same answer every time; `evals/fixtures.test.ts` and `evals/framework/eval.test.ts` check the fixtures and the framework there without a model. Run `mise run check` before merging, and the affected evals whenever you change a prompt, the planner's tools, or a model.

## Deploy

Requires Cloudflare Zero Trust, Workers AI, and an Alchemy profile that can manage Workers and Access.

```sh
mise run deploy
```

The first deploy offers to bootstrap Alchemy's Cloudflare-hosted state store. Alchemy builds the UI with Vite and deploys two Workers:

- `Studio` serves the UI. It is the only public hostname and sits behind Cloudflare Access, which admits members of your Cloudflare account.
- `Api` has no public URL. Studio forwards `/api/*` to it over a service binding.

It also creates `AutomationsDatabase`, a D1 database that lists the automations and holds the entity types, the entities, the templates, and which automations subscribe to each type. Alchemy applies the migrations in `migrations/` on every deploy. They seed an `employee` type, two employees, and two welcome-email templates.

Deploys also create a 30-day Access service token for machine testing. Send it as `CF-Access-Client-Id` / `CF-Access-Client-Secret`, and read it with `bun alchemy state`. Never commit it.

## Usage

Open the Studio URL, describe a process, review the steps, and save. The agent's replies are formatted (lists, bold, links). When it needs you to choose, such as which role approves an email, it stops and asks up to four questions. Answer them one at a time by picking an option or writing your own answer, review them, and send them together; the agent then carries on where it stopped. You can also skip them, or answer in the message box. Runs always use the last saved snapshot, not the current draft.

Under **Permissions**, the draft lists every connection operation it uses. Each one is set to allow (it runs automatically) or ask first, with the role whose members approve it, such as the seeded People Ops. The agent suggests these, and you can change any of them. An operation that asks first makes every run wait on an approval task that shows exactly what it will send and who can approve it. Rejecting the task skips that step and every step that needs its result; the rest of the run carries on. When the process must not go on, the agent adds a stop step. Save the draft to apply permission changes to new runs.

The studio opens on the **Overview**: the runs in flight across every automation, and every automation with how it starts and how its last run went. Start a saved automation from there with **Run**. If it is about an entity, such as an employee, pick which one first. Draft-only automations are listed but can't run until they are saved. The page refreshes every 5 seconds while a run is in flight.

The open automation's ID is in the URL (`/?automation=onboarding`), so a reload, a new tab, or a shared link opens the same automation. Clicking a run on the overview or in the studio opens it in a panel on the right, so it can play out while you keep editing or watching the overview. The panel follows the run step by step and lets people answer its open tasks; its expand button opens the run's own page (`/?automation=onboarding&run=<runId>`), and a modified click on a run opens that page in a new tab. The run page shows the saved version the run started with, not the draft, so it leaves out the planner chat; **Edit automation** goes back to it. The sidebar lists every automation. Its **+** button opens a dialog where you describe what the automation should do. Creating it asks a fast Workers AI model for a short name, lists the automation in the sidebar straight away, opens it, and sends your description as the first chat message, so the conversation is never lost by navigating away. The ID comes from that name (`Onboard new hires` opens `/?automation=onboard-new-hires`, with a random suffix if that ID is taken). The planner renames the automation when it drafts the workflow; the ID stays. An unknown ID in the URL starts an empty automation, which joins the sidebar once the agent drafts it.

A saved automation with an entity trigger starts when a matching entity changes. For example, giving the seeded `ada` a start date starts an onboarding automation that watches `employee.start_date`:

```sh
curl -X PUT "$STUDIO_URL/api/entities/employee/ada" \
  -H "Cookie: CF_Authorization=$CF_ACCESS_JWT" -H "Content-Type: application/json" \
  -d '{"data":{"start_date":"2026-11-02"}}'
```

The response lists the runs the change `triggered`. People answer human steps from the run in the studio, or with `POST .../tasks/:stepId`.

A saved automation with a schedule trigger runs on a cron schedule in a time zone, such as every weekday at 9:00 in London. It can start one run each time, or one for every entity of a type that meets a condition, such as each employee who starts in the coming week. The overview shows the schedule in words and when it next runs (see [Triggers](docs/workflow-dsl.md#schedule)). A date trigger starts a run on, before, or after a date each entity holds, such as three days after each employee's start date, and follows the date if it changes (see [`date`](docs/workflow-dsl.md#date)). One occurrence starts at most 50 runs; one that matches more starts none and records a failed run saying so, and a save that already matches more is refused.

Templates hold approved wording, such as the standard welcome email, with slots the automation fills (`hire → employee`). The planner uses a template whenever one fits instead of writing the text, and picks one per case with a `match`, for example a different welcome email by role. Manage them on the studio's **Templates** page (`/templates`), which also lists the automations whose saved workflow or draft uses each one, or write them with `PUT /api/templates/:name` (see [Templates](docs/workflow-dsl.md#templates)). Editing a template changes runs that start afterwards; runs already going keep the wording they started with.

| Endpoint                                                   | Purpose                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/overview`                                        | Each automation's trigger, its next scheduled run, and runs in flight                                      |
| `GET /api/automations`                                     | List automations                                                                                           |
| `POST /api/automations`                                    | Create an automation from a description, which becomes its first chat message (`{ "description": "…" }`)   |
| `GET /api/automations/:id`                                 | Inspect an automation and its recent runs                                                                  |
| `POST /api/automations/:id/chat`                           | Send a design message                                                                                      |
| `POST /api/automations/:id/save`                           | Save the draft, subscribe to its trigger, and book its schedule                                            |
| `POST /api/automations/:id/permissions`                    | Set which operations ask which role first (`{ "permissions": { "email.send": { "ask": "people_ops" } } }`) |
| `GET /api/roles`, `PUT /api/roles/:name`                   | List or define roles (`{ "name", "label", "members": [{ "type", "id" }] }`)                                |
| `POST /api/automations/:id/start`                          | Start a run by hand (`{ "subject": "<id>" }`)                                                              |
| `GET /api/automations/:id/runs/:runId`                     | Inspect a run, its steps, and its tasks                                                                    |
| `GET /api/automations/:id/trace`                           | The planner's conversation: instructions, prompts, reasoning, tool calls and results, token use            |
| `GET /api/automations/:id/runs/:runId/trace`               | The conversation a run's agent and decide steps share, in the same shape                                   |
| `POST /api/automations/:id/runs/:runId/tasks/:stepId`      | Answer a human step                                                                                        |
| `GET /api/entities/types`, `PUT /api/entities/types/:type` | List or define entity types                                                                                |
| `GET /api/entities/:type`, `GET /api/entities/:type/:id`   | Read entities                                                                                              |
| `PUT /api/entities/:type/:id`                              | Create or update an entity and start its runs                                                              |
| `DELETE /api/entities/types/:type`                         | Delete a type nothing depends on                                                                           |
| `DELETE /api/entities/:type/:id`                           | Delete an entity that no role lists (starts no runs)                                                       |
| `POST /api/mcp`                                            | The entity store as an MCP server                                                                          |
| `GET /api/templates`, `GET /api/templates/:name`           | List or read templates                                                                                     |
| `PUT /api/templates/:name`, `DELETE /api/templates/:name`  | Create, replace, or delete a template                                                                      |
| `GET /api/templates/:name/automations`                     | The automations whose saved workflow or draft use a template                                               |

### Agent traces

`/traces` in the studio (**Debug → Agent traces** in the sidebar) shows what the agents were asked and did. Pick an automation for its planner's conversation, or one of its recent runs for the conversation its agent and decide steps share. Each trace lists system prompt changes, prompts, every model response with its reasoning, tool calls, stop reason, and token use, and every tool result, with failed ones marked. They come from pi's own records in the automation's Durable Object; a trace holds the latest 1,000 entries. The namer and the progress classifier aren't pi conversations, so they have no trace.

### Entity store

`/entities` in the studio (**Debug → Entity store** in the sidebar) is a debug page for the entity store. Define entity types field by field, then create, edit, and delete their entities. Saving an entity is an ordinary entity write, so it starts the saved automations that watch its type.

`/api/mcp` serves the same store to agents over MCP's Streamable HTTP transport. Its tools are `list_entity_types`, `define_entity_type`, `delete_entity_type`, `list_entities`, `get_entity`, `put_entity`, `delete_entity`, `list_roles`, and `define_role`. The server is stateless: it assigns no session, answers in JSON, and supports protocol revisions 2024-11-05 through 2025-11-25. With `mise run dev`:

```sh
claude mcp add --transport http entity-store "$STUDIO_URL/api/mcp"
```

Deployed stages sit behind Access, so send the service token as headers (`--header "CF-Access-Client-Id: …" --header "CF-Access-Client-Secret: …"`).

## Caveats

- Email, Slack, and Calendar are simulated until they have credentials. Their steps succeed, contact nothing, and record what they would have sent with `simulated: true`. A human step's `notify` is recorded, not sent.
- Only a role's members may answer its approval tasks, going by the email Cloudflare Access sends in `Cf-Access-Authenticated-User-Email`. The Api trusts that header because only the Access-protected Studio Worker reaches it. Verify the Access JWT before production. Under `alchemy dev`, and with the test service token, there's no email, so anyone can answer.
- `http.post` steps are delivered **at least once**, with an `Idempotency-Key` header that stays the same across retries, so receiving endpoints must be idempotent. Without a `body`, they POST the run's subject and step records to a public HTTPS URL. Don't put secrets in step definitions.
- Chat is asynchronous: `POST /chat` returns `202` with a `pendingChat`, and the reply and new draft appear on `GET /api/automations/:id` once `pendingChat` is gone. Until then the response includes `progress`, a plain phrase such as "Planning the steps…". If the agent fails, `pendingChat` stays with `status: "failed"` and an `error` until the next message. Each exchange in `conversation` has the `prompt`, the Markdown `reply`, and the questions the agent asked on the way with their answers (`asked`). While the agent waits for answers, `pendingChat` has `status: "asking"` and its `questions`; until the reply is written, it also lists the questions already answered in `asked`. `POST /api/automations/:id/answers` with `{ "chatId", "answer": { "kind": "answers", "answers": ["…", null] } }` (one answer per question, `null` to skip) resumes it; a `POST /chat` meanwhile answers with `{ "kind": "message" }` instead.
- Runs advance through Alchemy durable callbacks that replay them from a journal in the Durable Object's storage. If the Durable Object is evicted mid-step, that step runs again; agent steps reuse their pi request ID instead of prompting twice.
- Workflows and runs written before entity-based triggers were discarded; the Automation object drops them when it reads them.
- A run whose saved workflow no longer checks against the templates and entity types (for example, a template it uses was deleted) is recorded as failed instead of starting.
- pi-ai, pi-durable, and Alchemy 2 are beta. Pin versions before production use.

## Inspiration

- [Callscript](https://github.com/vercel-labs/callscript): a model writes JavaScript that is parsed into an inert, validated JSON plan instead of being executed, so only the tools you mount can act.
- [JEXL](https://github.com/just-be-dev/jexl): a programming language whose syntax is pure JSON.
- [Forma](https://forma-lang.com/): a small typed Lisp where domain keywords are library code, so schemas, APIs, and policies share one source of truth.
