# Automations studio

A single-tenant prototype on Cloudflare: you design sequential automations in a chat, then run them in a Durable Object. `README.md` introduces the product. `ARCHITECTURE.md` explains how the parts fit together; read it before changing a lifecycle. `docs/development.md` covers setup, deploys, evals and the HTTP API, and `docs/workflow-dsl.md` is the workflow format reference. UI rules are in `src/ui/AGENTS.md`.

## Layout

Most modules open with a comment saying what they own.

- `alchemy.run.ts`: re-exports `src/platform/cloudflare/stack.ts`: the `Studio` website with Access and the test service token, and `StudioEnv`.
- `src/platform/cloudflare/`: every Cloudflare implementation: the private `Api` Worker (`api.ts`), the `AutomationAgent` and `ChangeCoordinator` Durable Objects, the entity-store binding and its change queue (`entity-store.ts`), the D1 adapters, Workers AI models (`workers-ai.ts`), pi (`pi.ts`, `pi-storage.ts`), the events and Slack actions queues, the Email Service sender (`email.ts`), the Slack `Channels` Worker, and the Studio Worker's entry (`edge.ts`).
- `src/http/`: platform-independent routes, composed in `api.ts`: automations and the overview, entities and templates (`catalog.ts`), changes, events, and the studio's MCP server (`mcp-server.ts`, over the catalog's tools in `entity-mcp.ts` and the automations' in `automation-mcp.ts`, served at `/api/mcp` by `mcp.ts` and as `Api`'s `mcp` RPC). `response.ts` shares boundary decoding and responses.
- `src/automation/`: one automation. `application.ts` joins `design-session.ts` (chat, pending replies, drafts) and `runs.ts` (runs, tasks, triggers), which share `workflow-store.ts` (snapshots and save) and `run-store.ts` (run records). `host.ts` is its storage and jobs contract, `service.ts` addresses an automation, and `index.ts` is the D1 directory.
- `src/agents/planner/`, `src/automation/planning.ts`: the planner: its instructions and `planDraft` (`planner.ts`), the working copy (`plan.ts`) its tools (`tools.ts`) edit, progress phrases, and the stored working copy and questions (`planning.ts`).
- `src/agents/namer/`, `src/automation/creation.ts`: creating an automation from a description, named by a fast model.
- `src/changes/`: confirmed changes to entities, types and templates.
- `src/workflow/`: the pure DSL (`model.ts`), the catalog checker (`catalog.ts`), schedules, the run record (`run.ts`), interpreter values (`execution.ts`), the interpreter, the durable engine, and agent-step prompts (`agent-step.ts`).
- `src/entities/`: entity types and records, templates (`templates.ts`), the `EntityStore` service (`store.ts`) with its memory layer (`memory.ts`), and `EntitySubscribers`. entity-store's RPC contract (`entity-store-api.ts`), the type adapter (`entity-store-types.ts`), an in-memory entity-store (`entity-store-fake.ts`), the `meta` automations writes (`write-meta.ts`), and the consumer of entity-store's change queue (`change-feed.ts`).
- `src/connections/`: the pure operation registry (`registry.ts`), shared by the planner, the checker and the UI, and the runner that executes operations.
- `src/events/`, `src/channels/slack.ts`: named events and their delivery, and Slack ingress.
- `src/channels/slack-interactivity.ts`, `src/channels/slack-approvals.ts`: Approve and Reject buttons on approval DMs already sent, from the signed click to the decision and the updated message.
- `src/ai/`: the `PiAgent` conversation contract and traces, the shared `ask_question` tool with its `AnswerHub`, and the clef `Classifier` that picks progress phrases and makes decide steps' decisions (`classifier.ts`).
- `src/ui/`: the Foldkit browser app.
- `src/workflow.ts`, `src/entities.ts`, `src/connections.ts`: re-exports that keep the UI's imports. Backend code imports the owning modules.
- `evals/`: evals of every LLM call against the real models: the tests in `<name>.eval.ts`, and their cases in `datasets/<name>.yaml`. See `docs/development.md#evals`.
- `demo/`: `mise run demo:reset`, which brings a local studio to the live demo's state through the HTTP API, with its seed (`seed.ts`) and fallback workflow (`onboarding.json`). See `docs/development.md#live-demo`. The seed's `employee` type and welcome templates are sample data the reset writes through the API; nothing outside `demo/`, tests and fixtures may depend on them.
- `migrations/`: D1 migrations, applied in numeric order on deploy and under `alchemy dev`.

## Boundaries

- Domain code must not import `src/platform/cloudflare/`, Alchemy, Cloudflare SDKs, or their native globals. `src/platform/boundary.test.ts` checks this.
- HTTP handlers use `Automations` and `RequestIdentity`, never a Durable Object namespace or Access headers. They decode, call one application operation, and encode; they must not repeat writes the operation owns, such as save's.
- Code that reads or writes entities depends on `EntityStore`, never on D1 or entity-store's binding. Yield `EntityStoreLive` and `AutomationIndexD1` in the outer Effect, since they bind D1 and entity-store, and provide the layers they return per request or per instance, since they need a `RuntimeContext`.
- `src/platform/cloudflare/workers-ai.ts` imports no Alchemy, so the evals reuse it.
- `src/platform/cloudflare/edge.ts` only forwards `/api/*` to `Api`. Keep logic out of it.
- MCP handlers run inside the request (or the `mcp` RPC call), over its `EntityStore`, `Changes` and `Automations`. Don't switch to Effect's `McpServer`: it keeps sessions in memory and runs handlers on a fiber outside the request, where D1 and entity-store can't be reached.
- pi tools are one extension that only the root conversation selects, so agent steps never see them. Build them before opening pi, so an answer resumed after a restart still has them.

## Design sessions and the planner

- `chat` only stores the message as `pendingChat` and schedules `planReply`, so a reload mid-answer loses nothing. `stop` marks it failed with `Stopped`, drops `plan`, and aborts pi; a later delivery finds nothing pending.
- The planner never writes a whole workflow. Its tools set values or replace steps by ID, and no tool argument nests steps, so a call pi repeats after a restart changes nothing more. Keep every planner tool idempotent.
- The assembled answer must decode and check against the catalog; otherwise the planner gets exactly one retry with the problems. An answer that changed nothing leaves the draft as it is.
- Questions are kept beside the working copy, not in it, so asking never counts as a change.
- A reply that edits an existing draft records `diffWorkflows` (`src/workflow/changes.ts`) with its exchange. The studio marks the latest reply's changes only while they differ from the saved version (`unsavedChanges`), so saving clears them and a reload keeps them.
- Asking parks the planner's pi turn, possibly for days, so nothing may wait on it. `planReply` returns as soon as the turn parks and writes nothing. An answer is stored and `planReply` rescheduled in one transaction.
- The planner reads workflows as YAML (`planYaml`); its tool arguments stay JSON.
- Progress phrases are read by non-technical users. Keep them plain, and never let them reveal the retry or show the agent's raw reasoning.
- Creation never fails on naming: the namer falls back to the description's opening words. If the first message can't be sent, the automation stays listed and the response has no `pendingChat`.

## entity-store

- entity-store (a separate repo and Alchemy stack) is the system of record for entity types and entities. automations keeps templates and `entity_subscriptions` in D1; migration `0006` dropped its old `entity_types`, `entities` and `roles` tables and the seeded welcome templates. automations provides no entity type of its own: work with whatever types entity-store holds.
- `EntityStoreRpc` in `src/entities/entity-store-api.ts` is a contract with entity-store, whose API Worker serves it on its default entrypoint; change it only together with entity-store. Decode every answer. Every method returns a `Result` and never throws for a domain error.
- Under `alchemy dev`, `EntityStoreDev` (`src/platform/cloudflare/entity-store-dev.ts`) stands in for entity-store: the in-memory entity-store behind the same methods, kept in its storage (`entity-store`), feeding the local `EntityStoreChanges` queue. `EntityStoreLive` picks it from `localDevelopment`; never bind it on a deployed stage. `PUT`/`DELETE /api/dev/entity-store/:type/:id` write to it directly, like an edit made in entity-store itself.
- There are no roles: a type named `role` is an ordinary type. Entity IDs are unique across types.
- Saving a type from automations only adds or removes fields (`planTypeWrite`). Refuse a field whose kind changes rather than authoring a lens here.
- The `meta` automations writes (`{ depth, sourceEventId?, changeId?, source? }`, at most 1 KB) is persisted in entity-store's change log. Keep it compatible.
- Lifecycle events and entity triggers come only from the change feed: never publish `entity.*` or notify subscribers from a write path. Their key is `entity-store:<seq>`, so a redelivered message starts nothing twice; never key them by entity ID and revision, which come back after a type is deleted. Drop a message whose change is gone or can't be presented (`ChangeNotFound`, `ProjectionFailed`) rather than retry it. Changes to types automations can't use publish nothing.
- An entity trigger ignores a change committed before its `triggerSince`: when the saved trigger took effect. Only a save that changes the trigger moves it. A keyed `entityChanged` leaves a receipt (`entity-change:<key>`), declined ones included.

## The assistant and changes

- automations has one assistant: the platform's, in the hub shell's drawer (agents project). It reaches automations only through the MCP server below. The studio page has no chat: **New automation** and the empty draft's **Ask the assistant** open the drawer with a prompt (`hub:open`, `OpenAssistant` in `src/ui/command.ts`), and the studio watches the open automation for the planner work it starts. `POST /api/automations` and `/chat` stay for API clients and the demo.
- The studio's own agent (`StudioAssistant`, `src/assistant/`) is gone. Alchemy deleted its Durable Object class, with its conversations, and migration `0007` dropped `assistant_threads`. Its storage keys (`identity`, `assistant`, `tool:<callId>`) and its `assistantReply` callback are no longer contracts. Proposals it left waiting stay in the coordinator, and `list_pending_changes` finds them.
- There is one live `ChangeCoordinator` for the tenant. Never instantiate separate coordinators for different writers. entity-store and proposal storage cannot share a transaction, so every entity write from `Changes` is conditioned on the reviewed revision (`expectedRev`, 0 for a new entity) and carries the proposal's ID in `meta.changeId`; recovery reads the change at the write's revision to tell whether it landed. Never write an entity unconditionally from `Changes`. A proposal reads only what its action touches; never snapshot the whole store. Entity previews use entity-store's `checkEntity` dry run, so they refuse what entity-store will. A refusal at apply time, of any action, settles the proposal (pending for a person, cancelled for a command); never leave it applying. A change recovery can't read is unknown: fail closed.
- Entity, type and template writes over HTTP go through `/api/changes` and `/api/changes/:id/decision`.
- Entity notifications carry `entity-store:<seq>` from the change feed through every adapter to deterministic run IDs.
- Questions and action confirmations are separate. Never treat free text as approval.

## MCP and the hub's assistant

- `Api`'s default entrypoint has an RPC method `mcp(body, headers)` (the platform contract in agents' `docs/hub-shell.md`): one JSON-RPC message, answered `{ status, body }` exactly as `/api/mcp` would. Never route it over HTTP: holding the binding is the authorization. It acts for the person `cf-access-authenticated-user-email` names, trusted like Access; with no person every tool that changes something refuses (`NoPerson`). It never falls back to `local` or `DEV_USER_EMAIL`.
- The server is stateless: `tools/list` and `tools/call` need no `initialize`, and every protocol revision it speaks (2024-11-05 to 2025-11-25) is answered alike, so `mcp-protocol-version` needs no checking.
- One approval per change. A tool annotated `readOnlyHint: true` changes nothing (`preview_change` stores no proposal). Every other tool changes something when called, so the client's approval of that exact call (the hub's approval card) is the person's decision: change tools prepare through `Changes` and decide at once (`applyChange`), keeping the coordinator's checks, `expectedRev` and recovery. A write refused or stale at apply is cancelled, not left pending; one that settles as applied anyway is reported applied. Never add a tool that proposes and then needs a second gated call, and never mark a tool that writes anything read-only.
- Nothing is left waiting without a way to decide it: `list_pending_changes` (read-only) lists the person's waiting proposals, such as ones from the studio's forms or the old studio agent, and `decide_change` decides one. Change tools' `requestId` makes a retry return the first outcome (`mcp:<requestId>`).
- The design tools (`create_automation`, `draft_automation`) only delegate to the planner through `Automations.chat` (`mcp:<requestId>` when given) or `answer` while it asks, and wait at most `PlannerWait` for it. No MCP tool saves, starts, or answers a run's task. `get_run` never returns a task's token.
- Keep tool names, descriptions and schemas clear for a small model, and outputs small: agents cuts a result at 8,000 characters.

## Runs and events

- Only the durable engine owns the replay journal. Never seed interpreter working values from a run record. `RunId` and `ExecutionId` are distinct branded strings; decode them without changing their wire values.
- The interpreter reaches the outside world only through `StepRunner`. Its code outside an Activity reruns on every replay, so keep it deterministic. The engine never keeps a run in memory between events.
- `events.emit` is a permission-controlled operation. `entity.put` writes through the tenant `ChangeCoordinator`, not a separate writer. The Api's consumer of entity-store's change queue publishes `entity.created`, `entity.updated` and `entity.deleted` as `entity-store:<seq>`.
- Event chains stop at depth 16, counting entity-triggered runs too. A command's write carries its depth in `meta.depth`, and the change feed publishes at that depth, so the count survives entity-store.
- Each automation keeps matched and ignored event receipts, and recovers a run committed before its receipt instead of starting another.
- Slack ingress callbacks write nothing to Slack and must stay replay-safe. Only they may publish `slack.*`. Keep `docs/slack.md` in step with `docs/slack-app-manifest.json`. The channels `namespace` (`automations`) and mailbox storage are persisted contracts.
- A Slack button click is only verified and queued on `Channels`; the `Api` decides it off the `SlackActions` queue through `Automation.respond`. Never call `respond` for a click without the clicker's Slack email, and keep deciding idempotent: a repeated click redraws the task's recorded `decision`. The action IDs (`task.approve`, `task.reject`) and the button value (`{ automation, run, step }`) are persisted in sent messages.
- `EntitySubscribers` returns each subscriber's result or error without preventing the others from being notified.

## Docs and evals

- Keep `docs/workflow-dsl.md` in step with the DSL, and `docs/workflow-engine.md` with the code paths it diagrams. Code calls `{{ref}}` text a template string; stored approved wording is a template. Keep the two apart in names and docs.
- An `<name>.eval.ts` holds only the call, its `minimum`, and its checks: those in `every` and the kinds a case can ask for. Its cases go in `evals/datasets/<name>.yaml`. Keep the framework out of both. A new LLM call needs a route in `evals/framework/worker.ts`.
- Don't lower an eval's `minimum` to make a run pass. When you change a prompt, the planner's instructions, or a model, run the affected evals with `--trials` before and after, and add a case for behavior you rely on.

## Verify before finishing

```sh
bun run typecheck && bun run lint && bun run test && bun run format:check
```

- Tests use `bun:test` and sit next to the code they cover. Run Effects with `Effect.runSync` or `Effect.runPromise`.
- Application behavior is tested with an in-memory `AutomationHost` and scripted `PiAgent`. Native Worker and Durable Object behavior needs end-to-end tests: run `mise run dev` and call `/api/automations/...` on the Studio URL it prints. Chat and agent steps call Workers AI for real.
- Tests can't tell whether a prompt got better. After changing a prompt or a model, run the affected eval suites (`mise run eval <suite> --trials 3`), which needs Workers AI credentials; if you can't, say so. `mise run check` runs the checks above and then every eval.

## Debugging a user's automation

The UI keeps the open automation, and its open run, in the URL (`/?automation=<id>&run=<runId>`). When a user shares that URL from `mise run dev`, read the automation over the local API. Dev mode skips Access, so no credentials are needed:

```sh
curl -s "$STUDIO_URL/api/overview"                       # every automation's trigger and runs in flight
curl -s "$STUDIO_URL/api/automations"                    # every automation with a draft
curl -s "$STUDIO_URL/api/automations/<id>"               # draft, saved, conversation, recent runs
curl -s "$STUDIO_URL/api/automations/<id>/runs/<runId>"  # one run: steps, records, tasks; the UI shows the run ID
curl -s "$STUDIO_URL/api/automations/<id>/trace"         # the planner's prompts, reasoning, and tool calls
curl -s "$STUDIO_URL/api/automations/<id>/runs/<runId>/trace"  # what the run's agent steps were asked and answered
curl -s "$STUDIO_URL/api/entities/types"                 # entity types
curl -s "$STUDIO_URL/api/entities/<type>"                # a type's entities
```

Stick to these `GET` routes unless the user asks for more. `chat` calls Workers AI and replaces the draft, `save` and `start` change what runs, answering a task moves a run on, and approving a `/api/changes` proposal (or MCP's `decide_change`, or any MCP tool without `readOnlyHint`) can write/delete data and start runs. Preparing a proposal writes no entity/template data.

## Effect

- Before writing Effect code, run `bunx effect-solutions list`, then `bunx effect-solutions show <topic>` for the patterns you need.
- Import from bare modules, e.g. `import * as Effect from "effect/Effect"`.
- New Worker and Durable Object code is Effect-native.
  - Decode every boundary with Schema: request bodies, path params, LLM output, and values read back from storage.
  - Model expected failures with `Schema.TaggedError`.
  - Name operations with `Effect.fn("Module.operation")`.
- Durable Object RPC errors reach the Worker as plain objects. Map them structurally (see `messageOf` in `src/error.ts`); don't use `instanceof`.
- pi-ai and pi-durable stay on purpose even though they are Promise-based. Wrap them in `src/platform/cloudflare/pi.ts` with `Effect.tryPromise` and `PiError`. Don't swap them for Effect AI.

## Alchemy 2

- Alchemy 2 is a beta Effect API, and the v1 (`await alchemy(...)`) docs don't apply.
  - Docs index: https://alchemy.run/llms.txt (append `.md` to a page URL to get markdown).
  - The installed source in `node_modules/alchemy/src` is the final reference.
- Each Worker and Durable Object has two phases:
  - The outer Effect runs at plan time and at cold start. Keep it to binding calls such as `yield* Automation` and `Cloudflare.Workers.AI()`.
  - The inner Effect or handler runs per instance or per request. Storage, the AI binding's `raw`, and callbacks are only usable there.
- Plan time imports `alchemy.run.ts` and everything it reaches under Bun. Never import a module that loads `cloudflare:*` at top level. This is why `src/platform/cloudflare/pi-storage.ts` replaces `agents/harness/pi`.
- `Alchemy.makeCallback` delivers at least once. Keep handlers idempotent:
  - A replay only reruns what the engine's journal lacks. Agent steps use the pi `requestId` `agent:<key>`, where the key is the Activity's idempotency key including the attempt, so a retry asks again but a replay doesn't. Action steps pass a key that stays the same across retries to the operation, and `http.post` sends it as `Idempotency-Key`.
  - Chat replies reuse the pi `requestId` `chat:${chatId}`, and their retry `chat:${chatId}:retry`. A redelivery keeps the working copy the first delivery started for that chat ID. Only the delivery that still finds that message pending writes the exchange.
  - Callback names and payloads are persisted contracts. Keep them compatible: `planReply` `{ automationId, chatId }`, `advance` `{ executionId }`, `clock` `{ executionId, deferredName }`, and `tick` `{ at }` under the job ID `schedule`.
  - A timed trigger's (`schedule` or `date`) `tick` starts each occurrence's runs under IDs fixed by its time and subject (`scheduled-<at>`, `scheduled-<at>-<entity id>`), so a redelivery finds them instead of starting them again, then books the next occurrence. A date trigger ticks daily at its time. Saving books or cancels the tick in the same transaction as the snapshot.
  - An occurrence never starts only some of its runs: past `MAX_SCHEDULED_RUNS` it starts none and records a failed `scheduled-<at>` run saying why, and save refuses a trigger that already matches more. Keep it that way; don't trim the list.
- Storage keys are persisted contracts too: `draft`, `saved`, `pendingChat`, `plan` (the planner's working copy for one chat ID, with each `ask_question` call's questions and answer by call ID), `run:<id>`, `triggerSince` (when the saved trigger took effect), `entity-change:<key>` (`{runId}` receipt, `runId: null` when declined), `studio` (the automation's ID and the studio origin its latest save came from, for task links), `execution:<executionId>` (its run ID), `event:<eventId>` (`{runId}` receipt, with `runId: null` when ignored), `exchange:<000000>`, and `exchangeCount` in `Automation`, `sequence` and `proposal:<id>` in `ChangeCoordinator` (`version: 2` records; older ones keep only their receipts), plus the engine's journal under `wf:<executionId>:` (see `src/workflow/durable-engine.ts`). Event runs use `event-<eventId>` and retain the optional original event in their run and execution payloads. A stored value that doesn't decode is a defect, not missing data.
- Activity and deferred names in `src/workflow/interpreter.ts` (`<id>`, `<id>/refs`, `<id>/now`, `<id>/request`, `<id>/outcome`, `<id>/timeout`, `<id>/approval-request`, `<id>/approval`) are journal keys for runs in flight. Renaming one makes a waiting run redo that step.
- entity-store's Api Worker and change queue are Alchemy refs to the constant stack `entity-store` with no stage (the current one): the queue ref must build the same env key at plan time and cold start. Alchemy's typed service bindings don't take another stack's Worker, so `entity-store.ts` registers the raw `service` binding to its default entrypoint. Refs resolve through this stack's own state, so `alchemy dev` uses the `EntityStoreDev` stand-in and its local queue instead.
- Never edit an applied D1 migration. Add the next numbered file in `migrations/` instead; Alchemy tracks applied files by hash in `__alchemy_migrations`.

## Invariants

- `isPublicHttpsUrl` in `src/workflow/model.ts` is the SSRF boundary. `http.post` URLs must be literal (no templates), HTTPS, without credentials, and target no private or loopback host. The catalog checks them when a workflow is checked, and the connection runner checks again before sending. Don't loosen either without tests.
- Runs always execute the saved snapshot, never the draft. Workflows must not contain secrets; connections will hold credentials.
- A run starts by checking the saved workflow against the current catalog and expanding its templates (`beginRun` in `src/automation/runs.ts`). The run's payload carries the expanded workflow, so replays never read a template; the interpreter fails an action that still uses one.
- The planner prefers templates to writing text or adding agent steps that write it. Keep that guidance in `plannerInstructions` when changing the prompt.
- The planner suggests permissions and the person can change them; both merge into the draft's `permissions`. The planner reads the current draft, permissions included, on every turn so it keeps the person's changes. Every operation a workflow uses needs one: `"auto"` or `"ask"`. Saved workflows and runs from before roles were removed hold `{ "ask": "<role>" }`, a persisted shape that `Permission` decodes as `"ask"`; keep decoding it and never fail on it.
- Anyone who can use the studio may answer an approval task. `Api` passes the Cloudflare Access email, or for a Slack click the clicker's Slack email, to `Automation.respond`, which records it as the decision's `by`. Tasks opened before roles were removed may still list `approvers`; they're ignored.
- A step that didn't run (declined or skipped) records nothing, and the interpreter skips any step that needs its record (`stepNeeds`). That relies on the checker's guarantee that every step a ref names finishes before the reader on every path. Don't loosen one without the other.
- `http.post` doesn't forward trace headers.
- Calendar is simulated, and so are Email without `EMAIL_FROM` and Slack without `SLACK_BOT_TOKEN`: they contact nothing and record `simulated: true`. Say so wherever results are shown. The UI decides from `GET /api/connections` (`LiveConnections`) for operations and from the record's `simulated` for results, never from the registry alone. The Automation object provides the senders. With `EMAIL_FROM`, `email.send` sends through `EmailSender` (`src/connections/email.ts`), which `src/platform/cloudflare/email.ts` implements over a remote Cloudflare Email Service `send_email` binding restricted to that sender. With the token, `slack.sendMessage` posts through `SlackSender` (`src/connections/slack.ts`). Neither provider takes an idempotency key, so a step retried after a send that wasn't journaled sends again. Opening a human step's task DMs its assignee through the same Slack sender (`src/automation/task-notifications.ts`); an ask-first action names no one, so it DMs nobody: it records each recipient on the task as `sending` before posting and checks the DM for the message's key before posting again, and a failure never fails the step. Keep it that way. Without the token, tasks only record `notify`; `notify: "email"` is never sent, even with email connected.
- Under local development only, `Api` takes `DEV_USER_EMAIL` as the request's identity when Access sent none (`src/platform/cloudflare/access.ts`). Never read it on a deployed stage.
- Development-only controls, such as resuming a wait now, check `LocalDevelopment` in both `Api` and the Automation object. Only `localDevelopment` in `src/platform/cloudflare/local-development.ts` sets it, from `ALCHEMY_DEV` on a `dev_` stage, so deployed stages never have it. Don't provide it from anything else.
- `/api` keeps a 32 KB request-body limit and returns `{ "error": string }` on failure. The UI relies on that shape.
- `Api` stays private. Only the Access-protected Studio Worker reaches its routes; agents' Worker binds it only to call the `mcp` RPC method. The `Channels` Worker is the only other public entry, and it serves only Slack's webhooks and interactivity requests, each of which must carry a valid signature.

## The hub shell

This app carries the platform's hub shell: the app rail and the assistant drawer, served by the agents project (`docs/hub-shell.md` there). `src/platform/cloudflare/hub-bindings.ts` binds agents' prod `Api` and `Embed` Workers on deployed stages, `hub.ts` forwards `/_hub/*` to them from the Studio Worker, `index.html` loads `/_hub/shell.js` with `data-app="automations"`, and the CSP allows `frame-src 'self'`. Prod serves the studio on `automations.just-be.dev` (a Custom Domain plus a route, which beats the zone's `*.just-be.dev/*` wildcard).

- The Studio Worker forwards `/_hub/api/*` with the email Access admitted, and agents trusts it. Keep `/_hub/*` behind Access.
- The email counts only when Access's JWT (`cf-access-jwt-assertion`) verifies (`access-jwt.ts`: the team's keys, the audience workerd reports on `ctx.access`, unexpired) and names the same email; otherwise forward `null`. The Studio's Access application admits the test service token, so never trust the email header alone. The audience comes from `ctx.access` because the Studio enrolls in its own application, so its env can't hold the application's `aud` without a dependency cycle.
- The edge (`edge.ts`) and everything it imports at runtime (`hub.ts`, `access-jwt.ts`) must not import Alchemy or Effect: under `alchemy dev`, Alchemy in the edge's graph breaks every Studio path. Bindings stay in `hub-bindings.ts`, which only the stack imports. `hub.test.ts` checks the graph.
- Deploy agents first when the shell's protocol changes; this app only forwards.

## Deploy and dependencies

- Never run `alchemy deploy`, `alchemy destroy`, or `alchemy dev --stage <deployed stage>` unless asked.
- `alchemy dev` runs locally on stage `dev_$USER`, skips Access, and still needs a Cloudflare profile for Workers AI. Entities come from the `EntityStoreDev` stand-in, not a real entity-store. Its state lives in the checkout's `.alchemy/state` beside the local data, so each worktree migrates its own database. Deploys use the Cloudflare state store.
- Never commit `.alchemy/` or Access service-token secrets.
- Install dependencies with the mise-pinned bun (`mise exec -- bun`); an older bun rewrites the lockfile.
- Foldkit, `@foldkit/*`, Vite, and `@effect/platform-*` are pinned exactly on purpose. To upgrade Foldkit, follow `src/ui/AGENTS.md`.
- Patch dependencies only with `bun patch`. Document every patch in `patches/README.md`: the symptom, the cause, what the patch changes, and the upstream fix that would let you remove it. When you upgrade a patched package, recheck its patch.
