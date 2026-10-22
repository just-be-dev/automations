# Development and operations

Setup, deployment, model evals, and the HTTP and MCP interfaces for Automations studio. For the product introduction, see the [README](../README.md); for how the system fits together, see [Architecture](../ARCHITECTURE.md).

## Local development

```sh
mise trust
mise install
mise run typecheck
mise run lint
mise run test
mise run format-check
mise run dev    # alchemy dev: local Workers, Durable Object, and Vite with hot reload
```

`mise run dev` runs everything locally on stage `dev_$USER` and prints the Studio URL. Dev mode skips Cloudflare Access, but it needs Cloudflare credentials for Workers AI. Run `bun alchemy profile edit --add Cloudflare` once, or set `ALCHEMY_PROFILE` to a profile that already has them. Entities come from a local stand-in for entity-store: see [below](#entity-store-under-alchemy-dev).

Local development also offers **Resume now** on a run's step that waits on a clock, so a three-day wait takes seconds in a demo. It fires the clock through the same operation as the scheduled `clock` callback, and that delivery later changes nothing. Only `alchemy dev` on a `dev_` stage enables it: each Worker's Init reads `ALCHEMY_DEV` on such a stage, which binds it into the Worker. A deploy binds nothing, so `GET /api/dev` answers `{ "local": false }` and the resume route answers 404 like an unknown route. The Automation object refuses too.

Without Access, a local studio doesn't know who you are, so anyone can answer an approval and the answer names no one. Set `DEV_USER_EMAIL` in `.env` to your address and restart dev to answer as yourself. Every request from your browser, `curl` or the demo reset then carries that address, as if Access had sent it, so only a role's members can approve and the run records who did. The Api reads it only when local development is on, so a deploy ignores it. Assistant sessions belong to that address too, so the assistant panel starts a fresh conversation the first time.

### entity-store under `alchemy dev`

automations keeps no entities of its own. Entity types, entities and roles live in entity-store, a separate Alchemy stack ([architecture](../ARCHITECTURE.md#entity-store-is-the-system-of-record-for-entities)). A reference to another stack resolves through this stack's own Alchemy state, so `alchemy dev` can't bind the entity-store another checkout serves. Instead, under `alchemy dev` a local stand-in takes its place: the `EntityStoreDev` Durable Object ([`entity-store-dev.ts`](../src/platform/cloudflare/entity-store-dev.ts)) runs the same in-memory entity-store the tests use behind the same RPC methods, keeps it in its storage, and sends each committed change to a local `EntityStoreChanges` queue, which the Api consumes as it does entity-store's queue when deployed. Nothing else needs to run. Deployed stages never bind it.

A fresh local studio has no entities: `mise run demo:reset` creates the demo's type, people and role through the studio. To see what an edit made in entity-store itself does, write to the stand-in directly, without automations' checks; its change still reaches automations through the queue:

```sh
curl -X PUT "$STUDIO_URL/api/dev/entity-store/employee/ada" \
  -H "Content-Type: application/json" -d '{"patch":{"start_date":"2026-11-02"}}'
curl -X DELETE "$STUDIO_URL/api/dev/entity-store/employee/ada"
```

These routes answer 404 outside local development. The stand-in checks the schema kinds, links and revisions automations relies on, and only the lens operations automations writes (`add`, `remove`); try anything beyond that against a deployed entity-store.

If an existing OAuth profile has expired, run `bun alchemy profile refresh --profile default --provider Cloudflare` and follow the sign-in flow.

`package.json` overrides Effect to `4.0.1` so the app and tooling share one copy despite Foldkit's exact `4.0.0` peer pins and the Effect lint plugin's `4.0.0` dependency. Recheck this override when upgrading those packages; remove it once their constraints allow the app's Effect version.

The workflow format is described in [Workflow DSL](workflow-dsl.md). Agent instructions are in [`AGENTS.md`](../AGENTS.md) and [`src/ui/AGENTS.md`](../src/ui/AGENTS.md).

### Evals

The tests script every model. The evals in `evals/` call the real ones, through the AI binding (Workers AI, and Claude through AI Gateway), to measure how well each LLM call does its job: the planner, the assistant, the namer and the thread namer, the progress classifier, agent steps, and decide steps. The calls run in an Evals Worker that `mise run eval` starts locally with `alchemy dev` on its own stage (`eval_$USER`), so Workers AI is reached through Alchemy's binding with the same Cloudflare profile as `mise run dev`, and no API token:

```sh
mise run eval                                                            # every eval
mise run eval planner --case onboarding --trials 3                       # one eval, matching cases, three tries each
mise run eval --list                                                     # the evals and their cases, without running them
mise run eval -- --help                                                  # every flag (mise keeps a bare --help)
EVAL_PLANNER_MODEL=@cf/… mise run eval planner agent assistant           # try another model for pi (@cf/… or anthropic/<id>)
mise run check                                                           # typecheck, lint, tests, format, then the evals
```

An eval has two parts: the test and its dataset. The test, `evals/<name>.eval.ts`, names the LLM call, the `minimum` it must reach, the checks in `every` that apply to every case, and the kinds of check a case can ask for. Checks are written like tests with `expect` from `bun:test`, and `judged` asks an LLM judge for what code can't check, such as whether a reply reads plainly:

```ts
export default defineEval({
  call: decide,
  minimum: 0.9,
  every: { "answers with a decision": (output) => expect(output.problem).toBeUndefined() },
  checks: {
    choice: {
      value: Expected,
      check: (expected) => (output) => expectMatch(output.choice, expected, "choice"),
    },
  },
});
```

The dataset, `evals/datasets/<name>.yaml`, holds the cases. Each gives the call's input, and checks by name, each one kind of check with its value, or a list of them that must all hold:

```yaml
# yaml-language-server: $schema=./decide.schema.json
cases:
  ticket:
    input:
      question: Which team should handle this ticket?
      options: { billing: Charges and refunds, technical: Bugs and outages }
      subject: { type: ticket, id: t-12, data: { text: My card was charged twice. } }
    checks:
      picks billing: { choice: billing }
```

The eval's Effect Schemas decide what a dataset may hold: its call's input, and each check kind's `value`. Every run decodes the dataset strictly, so a misspelt key fails the run instead of skipping a check. Every `mise run eval`, `--list` included, first writes the same rules as a JSON Schema beside each dataset (`<name>.schema.json`, ignored by git), which editors with the YAML language server use to check and complete it. Run `mise run eval --list` to refresh them after changing a check kind or a call's input. YAML anchors (`&ada`, `*ada`) and merge keys (`<<: *case`) share values within a dataset.

Datasets can't hold `expect` matchers, so values a case expects are written in a small language (`evals/framework/expected.ts`). A plain value must be equal, `{ $includes: … }` asks for at least these keys, items, or text, `{ $matches: /source/flags }` for a regular expression, `{ $oneOf: [ … ] }` for any of several values, and `{ $type: string }` for any value of a type. Quote YAML text that holds ` #`, or it becomes a comment.

- `evals/calls/` holds one call per LLM call site: it runs the production code for an input (`planDraft` with the real tools, the namer, a step's prompt) and returns what the checks read, with helpers for reading it.
- `evals/framework/` runs them. In Bun: `cli.ts` is `mise run eval`, which finds every `*.eval.ts` itself and loads its dataset; `client.ts` starts the Evals Worker and sends it each case's input; `eval.ts` defines evals, decodes their datasets, scores them, and runs their checks; `expected.ts` matches the values datasets expect; `report.ts` prints and saves results. In the Worker (`worker.ts`, its own stack in `stack.ts`): `models.ts` gives the calls the Workers AI binding and opens pi on in-memory storage, and `judge.ts` is the judge (`EVAL_JUDGE_MODEL` changes its model, the planner's by default). Each call's input and output have Schemas, which decode them on both sides of the Worker.
- `evals/fixtures.ts` holds what the calls work with whatever the dataset: the People Ops entity store the planner designs for, and the run an agent or decide step's input describes. The records and drafts a case uses are in its dataset.

Models vary between runs, so use `--trials` before trusting a change. The report lists failed checks and compares each case with the last saved run in `evals/results/` (ignored by git).

Every eval's trials share one queue, `--concurrency` (4) at a time, and the ones the last run found slowest start first, so a run takes about as long as its slowest trial rather than the sum of its evals. Each eval's result prints as soon as its last trial finishes. Each call's `timeout` is about twice its slowest successful trial, so a call that hangs doesn't hold up the run; raise it only when the saved results show slower trials that succeed. The Evals Worker rebuilds when a file it imports changes, which drops the calls in flight, so don't edit `evals/` or `src/` during a run.

Each eval has a `minimum`: the share of its checks that must pass across every case and trial. It lives in the test, not the dataset, so a dataset can't lower the bar. Below it, the run fails, so a prompt or model change that makes things worse fails `mise run eval` and `mise run check`. Keep each minimum a little under what the models reach, and raise it as they improve. The evals stay out of `mise run test`, which has to be fast and give the same answer every time; `evals/fixtures.test.ts` and `evals/framework/eval.test.ts` check the fixtures, the datasets, and the framework there without a model. Run `mise run check` before merging, and the affected evals whenever you change a prompt, the planner's tools, or a model.

## Live demo

`mise run demo:reset` brings the studio that `mise run dev` serves to the demo's known state: the onboarding story of the new hire Ada Lovelace, managed by Grace Hopper, with People Ops approving her welcome email. Run it while dev is running, before each rehearsal and again before going on stage.

```sh
mise run dev          # in one terminal
mise run demo:reset   # in another
```

It works through the studio's own HTTP API, in this order:

1. It deletes your assistant threads, erasing their conversations. They're the threads of `DEV_USER_EMAIL`, or of `local` without it, the same owner as your browser, so after a reload the panel's open thread is empty.
2. It deletes every automation with its draft, conversation, and runs. Runs in flight stop, and their pending jobs are cancelled.
3. It restores the `employee` type, four people, the People Ops role, and the two welcome templates.
4. It deletes every other entity, entity type, role, and template.
5. It saves the fallback onboarding workflow as `first-week`.

Entity, type, and template writes are prepared and approved through `/api/changes`, so the studio validates them as it does a person's edit. Role writes are direct, as they are for everyone. Deleting threads first means no assistant turn drafts or proposes anything mid-reset, and deleting automations next means none of these writes starts a run. A write that would change nothing is skipped, so running the reset twice leaves the same state. Ada starts on the first Monday at least two weeks after today, so the story never goes stale.

The people, role, and templates are in [`demo/seed.ts`](../demo/seed.ts). The type and templates match what the migrations seed into automations' D1 (whose entity tables are no longer read), which a test checks. The fallback, [`demo/onboarding.json`](../demo/onboarding.json), is the storyboard's plan after its edit: it welcomes engineers in `#eng-team` instead of `#general`. If the live planner misbehaves on stage, open `/?automation=first-week` and run it on Ada. The reset prints that link.

`mise run slides` opens the talk's slide deck, [`docs/demo/deck/index.html`](demo/deck/index.html), in the browser. It's one self-contained file, so it needs no server. [`docs/demo/script.md`](demo/script.md) is the live part's script: what to say to the studio agent, and where to click.

### Demo addresses

Each person's address comes from `.env`, which is gitignored. The reset reads these keys itself, so changing them needs no restart. A key left unset keeps an `example.com` placeholder that reaches no one, and the reset lists which ones are unset.

| Key                    | Person                                         | What reaches them                                                             |
| ---------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `DEMO_ADA_EMAIL`       | Ada Lovelace, the new hire                     | The welcome email and the calendar invite                                     |
| `DEMO_GRACE_EMAIL`     | Grace Hopper, Ada's manager and in People Ops  | The Slack heads-up, the calendar invite, and the check-in. Can approve email  |
| `DEMO_MARY_EMAIL`      | Mary Jackson, People Ops                       | Can approve the welcome email                                                 |
| `DEMO_KATHERINE_EMAIL` | Katherine Johnson, an engineer on Grace's team | Nothing in the fallback workflow                                              |
| `DEV_USER_EMAIL`       | You, the presenter                             | Who the local studio thinks you are. Use the same address as Grace's          |
| `STUDIO_URL`           | Optional                                       | The studio to reset. By default it's read from this checkout's `mise run dev` |

On stage you play Grace, so you approve the welcome email as yourself. Set `DEMO_GRACE_EMAIL` and `DEV_USER_EMAIL` to your own address, then restart dev and run the reset. The reset says whether you approve for People Ops. The run's step then reads "Approved by Grace Hopper, People Ops" with the time. With Slack connected, use the address of your account in the Slack sandbox: the heads-up, the approval DM and the check-in come to you, and the Approve button records you too.

`slack.sendMessage` finds a person to message by email, so with [Slack connected](slack.md), use the addresses of the Slack sandbox's members. The fallback also posts to `#eng-team`, so create that public channel in the sandbox. With `SLACK_BOT_TOKEN` set, running the fallback posts for real. Email and Calendar are still simulated, whatever the addresses.

The reset refuses any studio that isn't on this machine. It doesn't reach:

- **The assistant panel.** Its threads stay as they were. Press **New thread** in the panel for a fresh one.
- **Slack.** Messages a rehearsal posted stay in the workspace.
- **Change proposals.** Old ones stay stored. One still pending is refused as stale once the data it was prepared against has changed.

## Deploy

Requires Cloudflare Zero Trust, Workers AI, and an Alchemy profile that can manage Workers and Access.

```sh
mise run deploy
```

The first deploy offers to bootstrap Alchemy's Cloudflare-hosted state store. Alchemy builds the UI with Vite and deploys two Workers:

- `Studio` serves the UI. It is the only public hostname and sits behind Cloudflare Access, which admits members of your Cloudflare account.
- `Api` has no public URL. Studio forwards `/api/*` to it over a service binding.
- `Channels` takes Slack's webhooks, deployed only when Slack is configured ([Slack](#slack)).

Deploy entity-store first, on the same stage. automations finds it by Alchemy reference to the `entity-store` stack in the shared Cloudflare state store: `Api` and its Durable Objects bind entity-store's Api Worker, whose default entrypoint serves the RPC methods, and `Api` consumes entity-store's `entity-store-<stage>-changes` queue.

It also creates `AutomationsDatabase`, a D1 database that lists the automations and holds the templates and which automations subscribe to each type. Alchemy applies the migrations in `migrations/` on every deploy, and `alchemy dev` on start. A new stage starts with no templates; the early migrations' entity and role tables and seeded welcome templates are dropped again by `0006_entity_store.sql`.

The `Events` Cloudflare Queue accepts named events from the API, automation actions and entity-store's changes. `Api` consumes it, routes `entity.put` commands through `ChangeCoordinator`, then delivers each event to the automation directory. `Api` also consumes entity-store's change queue: it publishes each change's `entity.created`, `entity.updated` or `entity.deleted` to `Events` and notifies the automations watching the type. Both consumers acknowledge individual messages only after successful delivery, retry failures (10 retries, 30-second backoff), and dead-letter exhausted messages to `automations-<stage>-failed-events`. Inspect failed deliveries in the Api logs and the queue dashboard; dead-letter replay is manual. The prototype visits every listed automation rather than maintaining a separate event subscription index.

Deploys also create a 30-day Access service token for machine testing. Send it as `CF-Access-Client-Id` / `CF-Access-Client-Secret`, and read it with `bun alchemy state`. Never commit it.

### Cloudflare observability

Alchemy enables persistent Workers Logs (including invocation logs) and Workers Traces on both `Studio` and `Api`, with 100% head sampling for this prototype. This increases observability usage; lower the sampling rates if traffic grows.

`Api` and its three Durable Objects (`AutomationAgent`, `StudioAssistant`, and `ChangeCoordinator`) provide `Cloudflare.Telemetry({ headSamplingRate: 1, persist: true })` in their outer initialization Effects. Alchemy installs a fresh tracer for each request, RPC call, and alarm. Existing `Effect.fn` and `Effect.withSpan` spans appear alongside Cloudflare's native fetch, D1, and binding spans. Cloudflare owns sampling and export; no OTLP endpoint or API token is needed. Keep the host Worker's compatibility date at or after `2026-07-28`, which exposes the native tracing API. Studio's forwarding entry is async, so it needs only the native observability settings, not an Effect tracer.

After deploying, call `GET /api/automations` and inspect `Api` under **Workers & Pages → Observability → Traces** for `AutomationIndex.list` with `effect.exit: success`. Open an existing automation to exercise its Durable Object (`Automation.inspectWorkflow` and `Automation.inspectDesign`), and inspect a planner or run callback's alarm trace after using it. The API and Durable Objects share the `Api` Worker; look there, not only at Studio's forwarding trace. Local `alchemy dev` requests check runtime compatibility but do not prove dashboard ingestion. These Workers Traces are operational telemetry, separate from the pi conversation records on the studio's `/traces` page.

## Usage

Open the Studio URL, press **New automation**, describe a process to the studio agent, review the steps, and save. Runs always use the last saved snapshot, not the current draft.

The **studio agent** panel on the right is available on every page, and it is where automations are designed. It hands workflow design to the planner, creating a new automation or editing the one you have open, and never saves or runs the draft automatically. The studio page shows the draft and, while the planner works, what it is doing. The agent's replies are formatted (lists, bold, links). When it needs you to choose, such as which role approves an email, it stops and asks up to four questions, its own or the planner's; pick an option or write your own answer for each, or skip them. Ask it to create or edit entities and templates too, or chain work such as "Create an onboarding email template, then draft an automation using it."

Each conversation is a thread. Its messages and pending work survive navigation, collapse, and reload; the browser remembers the open thread, and Access identity isolates people using the same browser. **New thread** starts another; **Past threads** lists yours, titled from their first message, where you can reopen or archive them (archived ones are behind a toggle and can be restored). **Clear thread** erases the open thread's messages and the agent's memory of them, after you confirm, and keeps the thread. While the agent works or waits on you, **Stop** replaces Send: it cancels a change still waiting for confirmation and stops the planner if it is drafting, leaving the draft as it was.

**Follow along** opens the resource the assistant is working on. Manual navigation pauses following, and open forms prevent automatic navigation. Collapsing hides the conversation without stopping work. On smaller screens, the assistant opens as a drawer.

The chat composer has a microphone button next to Send for English dictation. Allow microphone access, speak, then press Stop to finish the transcript. Live words appear directly in the message input and are revised as transcription completes. You can edit them; subsequent results for that segment leave your edits intact. Review the draft and press Send yourself. Cancel stops recording without removing words already in the input. Recording stops automatically after just under three minutes; switching microphones or collapsing the panel stops that recording.

Dictation requires HTTPS (or localhost) and AudioWorklet support. The browser streams mono PCM16 over a same-origin WebSocket to the private API, which relays it to Workers AI's `@cf/deepgram/nova-3` with interim results, punctuation, and model-improvement opt-out. Audio is processed by Cloudflare/Deepgram; the studio neither stores nor logs it. The transcript becomes ordinary chat text only when sent. No browser API key, Deepgram account, RealtimeKit room, or AI Gateway setup is needed. Local streaming needs the same valid Cloudflare profile as other Workers AI calls.

Entity, type, and template mutations require review of the exact proposed change and its consequences. Manual actions show a confirmation dialog; assistant actions show the same proposal inline. Cancel leaves the data and your form untouched. Approval applies only that proposal, not later changes. If data or dependencies changed while awaiting approval, prepare a fresh proposal. Retrying an applied decision returns its receipt. An entity change is checked against the entity's revision, type and watchers, a type change against the type, and a template change against the template and the automations that use it; a change to any of them makes the proposal stale. An entity write is applied only at the revision you reviewed, so one that loses a race to another writer fails as stale instead of overwriting.

Under **Permissions**, the draft lists every connection operation it uses. Each one is set to allow (it runs automatically) or ask first, with the role whose members approve it, such as the seeded People Ops. The agent suggests these, and you can change any of them; save the draft to apply them to new runs. [Permissions](workflow-dsl.md#permissions) describes approval tasks and what declining does.

The studio opens on the **Overview**: the runs in flight across every automation, and every automation with how it starts and how its last run went. Start a saved automation from there with **Run**. If it is about an entity, such as an employee, pick which one first. Draft-only automations are listed but can't run until they are saved. The page refreshes every 5 seconds while a run is in flight.

The open automation's ID is in the URL (`/?automation=onboarding`), so a reload, a new tab, or a shared link opens the same automation. Clicking a run on the overview or in the studio opens it in a panel on the right, so it can play out while you keep editing or watching the overview. The panel follows the run step by step and lets people answer its open tasks; its expand button opens the run's own page (`/?automation=onboarding&run=<runId>`), and a modified click on a run opens that page in a new tab. The run page shows the saved version the run started with, not the draft; **Edit automation** goes back to it. The sidebar lists every automation. Its **+** button, like **New automation** on the overview, opens a new studio agent thread with "Draft an automation that " in the composer. When the agent drafts it, the automation joins the sidebar under an ID from its name with a random suffix (`welcome-employees-3f9a1c2e`), and following along opens it. The planner renames the automation when it drafts the workflow; the ID stays. An unknown ID in the URL starts an empty automation, which joins the sidebar once the agent drafts it.

A saved automation with an entity trigger starts when a matching entity changes. For example, prepare a change to the seeded `ada`'s start date:

```sh
curl -X POST "$STUDIO_URL/api/changes" \
  -H "Cookie: CF_Authorization=$CF_ACCESS_JWT" -H "Content-Type: application/json" \
  -d '{"action":{"kind":"putEntity","type":"employee","id":"ada","data":{"start_date":"2026-11-02"}}}'
```

Read the returned proposal's fields and consequences before confirming its `id`:

```sh
curl -X POST "$STUDIO_URL/api/changes/<proposal-id>/decision" \
  -H "Cookie: CF_Authorization=$CF_ACCESS_JWT" -H "Content-Type: application/json" \
  -d '{"approved":true}'
```

Only the confirmed decision writes the entity; its `result` is the entity as written. The automations watching the type hear of it from entity-store's change queue a moment later, so the decision doesn't list the runs it starts: look for them on the overview. Send `approved:false` to cancel. People answer human steps from the run in the studio, or with `POST .../tasks/:stepId`.

### Named events

An automation can listen for `entity.created`, `entity.updated`, `entity.deleted`, or any custom name using an [event trigger](workflow-dsl.md#event), and publish with [`events.emit`](workflow-dsl.md#publishing-events-and-entity-commands). Every committed entity write emits the lifecycle facts, including writes made in entity-store directly. Both they and entity triggers run asynchronously, after the write.

Publish an authenticated event with a tenant-unique ID. Keep that ID and payload unchanged when retrying; each automation starts at most one run for it, including after restart:

```sh
curl -X POST "$STUDIO_URL/api/events" \
  -H "Cookie: CF_Authorization=$CF_ACCESS_JWT" -H "Content-Type: application/json" \
  -d '{"id":"order-81-paid","name":"order.paid","data":{"total":137}}'
```

The body is `{id, name, data, subject?}`, where `subject` is an optional `{type, id, data}` snapshot. The response is `202 {"eventId":"order-81-paid","status":"accepted"}` once the queue accepts it, not after downstream work finishes. HTTP publications start at depth 0, and lifecycle names are reserved for the entity writer. Publishing `entity.put` merges an entity update without another confirmation, so API access grants that command. Delivery semantics, depth limits, and starting one event automation by hand are in the [DSL reference](workflow-dsl.md#event).

### Slack

With `SLACK_BOT_TOKEN` set, `slack.sendMessage` posts for real, and open tasks reach the people who answer them as DMs that link to the run. `STUDIO_URL` optionally sets the studio address those links use. With `SLACK_SIGNING_SECRET` as well, the stack deploys the public `Channels` Worker, and Slack mentions, thread messages and reactions start automations as [`slack.*` events](workflow-dsl.md#event). [Slack integration](slack.md) covers setup, what automations receive, and troubleshooting.

### Email

With `EMAIL_FROM` set to an address on a domain onboarded to Cloudflare Email Service, `email.send` sends real email from it, under `mise run dev` too. Without it, email is simulated. [Email](email.md) covers onboarding, configuration, how to check a real send, and troubleshooting.

### Schedules, dates and templates

Schedule and date triggers start runs on a cron schedule or relative to a date each entity holds. The overview shows a schedule in words and when it next runs. See [Triggers](workflow-dsl.md#schedule) for the limits and redelivery behavior.

Manage templates on the studio's **Templates** page (`/templates`), which also lists the automations whose saved workflow or draft uses each one, or prepare a `putTemplate` or `deleteTemplate` action through `/api/changes`. [Templates](workflow-dsl.md#templates) explains how runs use them.

### HTTP API

| Endpoint                                                     | Purpose                                                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/overview`                                          | Each automation's trigger, its next scheduled run, and runs in flight                                                                                     |
| `POST /api/events`                                           | Publish `{ "id", "name", "data", "subject"? }`; returns 202 on durable acceptance                                                                         |
| `GET /api/automations`                                       | List automations                                                                                                                                          |
| `POST /api/automations`                                      | Create an automation from a description, which becomes its first chat message (`{ "description": "…" }`); the studio drafts through the assistant instead |
| `GET /api/automations/:id`                                   | Inspect an automation and its recent runs                                                                                                                 |
| `POST /api/automations/:id/chat`                             | Send a design message                                                                                                                                     |
| `GET /api/transcription?sample_rate=16000`                   | Same-origin WebSocket for mono little-endian PCM16 dictation; also accepts 24000, 44100, and 48000 Hz                                                     |
| `POST /api/automations/:id/save`                             | Save the draft, subscribe to its trigger, and book its schedule                                                                                           |
| `PUT /api/automations/:id/draft`                             | Replace the draft with a workflow that checks against the catalog, such as a saved copy                                                                   |
| `DELETE /api/automations/:id`                                | Delete an automation with its draft, conversation, and runs; runs in flight stop                                                                          |
| `POST /api/automations/:id/permissions`                      | Set which operations ask which role first (`{ "permissions": { "email.send": { "ask": "people_ops" } } }`)                                                |
| `GET /api/roles`, `PUT /api/roles/:name`                     | List or define roles (`{ "name", "label", "members": [{ "type": "employee", "id" }] }`)                                                                   |
| `DELETE /api/roles/:name`                                    | Delete a role. Saved workflows that ask it fail their check when they next start                                                                          |
| `POST /api/automations/:id/start`                            | Start a run by hand (`{ "subject": "<id>" }`)                                                                                                             |
| `GET /api/automations/:id/runs/:runId`                       | Inspect a run, its steps, its tasks, and when each waiting wait step resumes (`resumesAt`)                                                                |
| `GET /api/automations/:id/trace`                             | The planner's conversation: instructions, prompts, reasoning, tool calls and results, token use                                                           |
| `GET /api/automations/:id/runs/:runId/trace`                 | The conversation a run's agent steps share, in the same shape                                                                                             |
| `POST /api/automations/:id/runs/:runId/tasks/:stepId`        | Answer a human step                                                                                                                                       |
| `GET /api/dev`                                               | Whether this is local development (`{ "local": true }`), which enables the route below                                                                    |
| `POST /api/automations/:id/runs/:runId/waits/:stepId/resume` | Local development only: fire the clock a waiting wait step sleeps on now; 404 elsewhere                                                                   |
| `GET /api/entities/types`                                    | List entity types                                                                                                                                         |
| `GET /api/entities/:type`, `GET /api/entities/:type/:id`     | Read entities                                                                                                                                             |
| `POST /api/changes`                                          | Prepare `{ "action": ... }`: `putEntity`, `deleteEntity`, `putType`, `deleteType`, `putTemplate`, or `deleteTemplate`                                     |
| `POST /api/changes/:id/decision`                             | Confirm or cancel the stored proposal with `{ "approved": true }` or `false`                                                                              |
| `POST /api/mcp`                                              | The entity store as an MCP server                                                                                                                         |
| `GET /api/templates`, `GET /api/templates/:name`             | List or read templates                                                                                                                                    |
| `GET /api/templates/:name/automations`                       | The automations whose saved workflow or draft use a template                                                                                              |
| `GET /api/assistant`                                         | List your assistant threads, archived ones included, most recently used first (`{ "threads": [...] }`)                                                    |
| `GET /api/assistant/:sessionId`                              | Read a UUID-named assistant thread and its pending work                                                                                                   |
| `POST /api/assistant/:sessionId/chat`                        | Submit `{ "message": "…", "context": { "pathname": "/templates", "template": "welcome_email" } }`                                                         |
| `POST /api/assistant/:sessionId/confirmation`                | Answer the inline proposal with `{ "proposalId": "…", "approved": true }`                                                                                 |
| `POST /api/assistant/:sessionId/answers`                     | Answer pending questions with `{ "callId": "…", "answer": { "kind": "answers", "answers": ["…", null] } }`                                                |
| `POST /api/assistant/:sessionId/stop`                        | Stop the turn in progress, and the planner it handed design to                                                                                            |
| `POST /api/assistant/:sessionId/clear`                       | Erase the thread's conversation in place                                                                                                                  |
| `POST /api/assistant/:sessionId/archive`                     | Archive or restore the thread with `{ "archived": true }`; returns `{ "threads": [...] }`                                                                 |
| `DELETE /api/assistant/:sessionId`                           | Erase the thread's conversation and take it out of your list; returns `{ "threads": [...] }`                                                              |

Chat is asynchronous: `POST /chat` returns `202` with a `pendingChat`, and the reply and new draft appear on `GET /api/automations/:id` once `pendingChat` is gone. Until then the response includes `progress`, a plain phrase such as "Planning the steps…". If the agent fails, `pendingChat` stays with `status: "failed"` and an `error` until the next message. Each exchange in `conversation` has the `prompt`, the Markdown `reply`, and the questions the agent asked on the way with their answers (`asked`). When the reply edited an existing draft, `changes` lists the steps it added, changed (with each field's old value) or removed, and the name, trigger and permissions it changed. While the agent waits for answers, `pendingChat` has `status: "asking"` and its `questions`; until the reply is written, it also lists the questions already answered in `asked`. `POST /api/automations/:id/answers` with `{ "chatId", "answer": { "kind": "answers", "answers": ["…", null] } }` (one answer per question, `null` to skip) resumes it; a `POST /chat` meanwhile answers with `{ "kind": "message" }` instead.

Each assistant thread response is an `AssistantState`; while it is `working`, poll its GET route. `confirming` and `asking` wait for explicit UI answers, and `failed` permits a new message. `stop` returns the thread `idle`, with the stopped message marked `stopped: true`.

### Agent traces

`/traces` in the studio (**Debug → Agent traces** in the sidebar) shows what the agents were asked and did. Pick an automation for its planner's conversation, or one of its recent runs for the conversation its agent steps share. Each trace is a list of lines: system prompt changes, prompts, every model response with its reasoning and tool calls, and every tool result, with failed ones marked. Click a line to open its full text; a response's details hold its model, stop reason, and token use. A refresh keeps open lines open. They come from pi's own records in the automation's Durable Object; a trace holds the latest 1,000 entries. The namer and the classifier behind progress phrases and decide steps aren't pi conversations, so they have no trace; a decide step's record holds its choice and every option's probability.

### Entity store

`/entities` in the studio (**Entity store** in the sidebar, under Templates) is a debug page for the entity store, which lives in entity-store. Define entity types field by field, then create, edit, and delete their entities. Saving an entity is an ordinary entity write, so it starts the saved automations that watch its type, a moment after the save.

`/api/mcp` serves the same store to agents over MCP's Streamable HTTP transport. Its tools are `list_entity_types`, `define_entity_type`, `delete_entity_type`, `list_entities`, `get_entity`, `put_entity`, `delete_entity`, `list_roles`, `define_role`, and `decide_change`. Entity/type mutation tools return a proposal without writing. They take an optional `requestId`: retrying a call with the same one returns the same proposal instead of preparing another. Present it to the person before calling `decide_change` with its `proposalId` and `approved` decision. Role tools write directly. The built-in assistant uses application tools directly, not MCP. The server is stateless: it assigns no session, answers in JSON, and supports protocol revisions 2024-11-05 through 2025-11-25. With `mise run dev`:

```sh
claude mcp add --transport http entity-store "$STUDIO_URL/api/mcp"
```

Deployed stages sit behind Access, so send the service token as headers (`--header "CF-Access-Client-Id: …" --header "CF-Access-Client-Secret: …"`).

## README demo

The [first-week example](examples/first-week.json) is a schema- and catalog-validated workflow using the demo's employee type and People Ops role, and the migration-seeded welcome templates. A run needs an employee with a start date and a manager. The seeded Ada record starts without a date; the execution check supplied `2026-11-02` in disposable local data.

The README screenshot (`docs/images/first-week.png`) was captured from `mise run dev` at a 1440 × 1860 viewport in light mode, with the studio agent open beside the draft and no run panel. After `mise run demo:reset`, the fallback `first-week` automation was deleted so the sidebar lists only the new one. Then the README's two requests were sent to the studio agent on one thread, unedited, and the planner (Claude Sonnet through AI Gateway) drafted and refined the workflow live. Nothing in the conversation, the draft, or the UI was scripted or retouched. The draft was not saved or run.

Because the model drafted it, the screenshot's workflow differs from the [first-week example](examples/first-week.json): for example, it sends the welcome email in parallel with the meeting and the heads-up, and it asks People Ops before more operations. To retake it, repeat those steps and open the new automation's page with the thread still open in the assistant panel. To load the example instead, send it to `PUT /api/automations/:id/draft`.

## Caveats

- Calendar is simulated, and so are Email without `EMAIL_FROM` and Slack without `SLACK_BOT_TOKEN`. Their steps succeed, contact nothing, and record what they would have sent with `simulated: true`. Without Slack, a human step's `notify` is recorded, not sent, and `notify: "email"` is never sent. With [Email connected](#email), `email.send` really sends; with [Slack connected](#slack), messages really arrive, `slack.sendMessage` really posts, and open tasks are sent as [DMs](slack.md#task-messages).
- `email.send` is delivered **at least once**: Cloudflare Email Service takes no idempotency key, so if a run restarts after Cloudflare accepted an email but before the run recorded it, the email sends again.
- `slack.sendMessage` is delivered **at least once**: Slack takes no idempotency key, so if a run restarts after Slack accepted a message but before the run recorded it, the message posts again.
- Anyone who can post in a channel the bot is in can start a `slack.*`-triggered automation. Treat `event.data.text` as untrusted input, and ask a role in the permissions of anything such a run sends or changes.
- Only a role's members may answer its approval tasks, going by the email Cloudflare Access sends in `Cf-Access-Authenticated-User-Email`. The Api trusts that header because only the Access-protected Studio Worker reaches it. Verify the Access JWT before production. With the test service token there's no email, so anyone can answer. So can anyone under `alchemy dev`, unless `DEV_USER_EMAIL` says who you are. A click on an approval DM's buttons always carries the clicker's Slack email, even in dev, so only members can approve from Slack.
- `http.post` steps are delivered **at least once**, with an `Idempotency-Key` header that stays the same across retries, so receiving endpoints must be idempotent. Don't put secrets in step definitions.
- Runs replay from a journal. If the Durable Object is evicted mid-step, that step runs again; agent steps reuse their pi request ID instead of prompting twice.
- Event receipts remain indefinitely in each automation's storage, and dead-lettered events are replayed by hand.
- pi-ai, pi-durable, and Alchemy 2 are beta. Pin versions before production use.
