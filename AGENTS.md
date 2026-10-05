# Automations studio

A single-tenant prototype on Cloudflare: you design sequential automations in a chat, then run them in a Durable Object. Setup, deploy steps, and the HTTP API are in `README.md`. UI rules are in `src/ui/AGENTS.md`.

## Layout

- `alchemy.run.ts`: the Alchemy 2 Stack. It declares the `Studio` Foldkit website, which carries Cloudflare Access and the test service token, and exports `StudioEnv`.
- `src/api.ts`: the Effect-native `Api` Worker. It holds the `HttpRouter` routes under `/api/automations` and `/api/entities`, plus `GET /api/overview`, and has no public URL (`workersDev: false`). Writing an entity asks every automation subscribed to its type whether to start a run. The overview asks every listed automation's `overview` for its saved trigger, its runs in flight, and its latest run, and lists one that can't answer with its `error`.
- `src/automation.ts`: the `Automation` Durable Object. It stores the draft and saved workflow and the chat transcript, and runs saved workflows with `RunAutomation` on the durable engine. It uses `Alchemy.makeCallback` to answer chat messages (`designReply`), replay runs (`advance`), and fire durable clocks (`clock`). `chat` only stores the message as `pendingChat` and schedules the reply, so a reload mid-answer loses nothing; the UI polls `GET /api/automations/:id` until `pendingChat` clears. While the agent works, that response also carries `progress`, one of the plain phrases in `progressPhrases`. `designReply` keeps it in memory: the stage of pi's in-flight answer (`pi.live`) fixes some phrases, and the `clef-flash` classifier picks the others from the designer's latest reasoning.
- `src/design.ts`: the designer agent's instructions, generated from the catalog, `designDraft`, which turns its answer into a draft, and the progress phrases with the classifier question that chooses among them. `designDraft` sets the instructions as the root pi conversation's system prompt before each reply, so the catalog stays current and each chat message is sent as the user wrote it. A reply that doesn't decode or check against the catalog gets one retry with the problems. Before that, `decodeDraft` (in `src/workflow.ts`) repairs closing brackets that are out of order or missing, which Kimi sometimes gets wrong at the end of deeply nested replies, and when the JSON still doesn't parse it says exactly which bracket is wrong. Progress is read by non-technical users: keep the phrases plain, and never let them reveal the retry or show the agent's raw reasoning.
- `src/workflow.ts`: the pure DSL. It holds the Schema models (`Workflow`, `Trigger`, the recursive `Step` tree, `Run`), `{{ref}}` template strings, and condition evaluation, including an action's `template` use and `match`. `docs/workflow-dsl.md` is its reference; keep the two in step.
- `src/templates.ts`: the pure model of stored templates: approved wording with slots (`hire → employee`) whose `content` fills an action's text inputs. It checks a template against the entity types and expands the templates a workflow uses into plain inputs (`expandTemplates`). The code calls `{{ref}}` text a template string too; keep the two apart in names and docs.
- `src/entities.ts`: the pure entity model: entity types, records, checking data against a type, and reading a ref through `ref` fields.
- `src/connections.ts`: the registry of connections and their operations, with each operation's default permission and `permissionOf`, which says whether a workflow runs an operation on its own (`auto`) or asks first (`ask`). It is pure, so the designer, the checker, and the UI all read it. `src/connection-runner.ts` executes the operations.
- `src/catalog.ts`: checks a workflow against the entity types, templates, and connections (refs, step ordering, operation inputs on every path through a match, template slots), and describes them to the designer.
- `src/interpreter.ts`: `RunAutomation`, an `effect/workflow` Workflow whose payload is a saved workflow and its subject. It walks the step tree with Activities, DurableClocks, and DurableDeferreds, and reaches the outside world only through the `StepRunner` service. Code outside an Activity reruns on every replay, so keep it deterministic.
- `src/durable-engine.ts`: a replaying `WorkflowEngine` that journals into a key-value store, the Automation object's storage. It never keeps a run in memory between events; the host replays on `wake` and fires clocks on `wakeAt`.
- `src/agent-step.ts`: the prompts for agent and decide steps, and how their answers become records.
- `src/automation-index.ts`: the `AutomationsDatabase` D1 database and the `automations` list. Cloudflare can't enumerate Durable Object names, so each automation is recorded there when the agent writes a draft (by `Automation`), on save, and when an existing automation is opened (by `Api`). It backs `GET /api/automations`.
- `src/entity-mcp.ts`: the entity store as an MCP server at `/api/mcp`. Its tools are an Effect `Toolkit` whose handlers run over the request's `EntityStore`. Next to them is a stateless JSON-RPC answerer for Streamable HTTP. Effect's `McpServer` doesn't fit here: it keeps sessions in memory and runs handlers on a fiber outside the request, where D1 can't be reached. `put_entity` notifies subscribers through `EntitySubscribers`, which `Api` provides, so it starts runs exactly like `PUT /api/entities/...`.
- `src/entity-store.ts`: the `EntityStore` service, which keeps entity types, entities, templates (checked against the types when written), and which automations subscribe to each type. Saving an automation subscribes it to the type its trigger watches. Its operations are built over a small `EntityStorage` interface, so every implementation merges and validates alike; `layerMemory` is the in-memory one for tests.
- `src/entity-store-d1.ts`: `EntityStoreD1`, the store's D1 layer, in the same database. Yield it in the outer Effect (it binds D1) and provide the layer it returns per request or per instance (it needs a `RuntimeContext`). Code that reads or writes entities depends on `EntityStore`, never on D1.
- `migrations/`: D1 migrations, applied in numeric order on deploy and under `alchemy dev`.
- `src/pi.ts` and `src/pi-storage.ts`: pi-durable and pi-ai running inside the Durable Object, with pi's tables stored in the object's SQLite.
- `src/edge.ts`: the Studio Worker's async entry. It only forwards `/api/*` to `Api`. Keep logic out of it.
- `src/ui/`: the Foldkit browser app. `src/ui/route.ts` maps URLs to its pages: `/` is the overview (`src/ui/overview.ts`, a Submodel that lists runs in flight and starts saved automations), `/?automation=<id>` is the studio that edits one, and `/?automation=<id>&run=<runId>` is a run's page. The studio and run pages live in `src/ui/main.ts`. A run page shows the snapshot the run executed and never the designer chat or the draft. On the overview and in the studio, a plain click on a run link opens the run in a side panel instead (`maybeRunPanel`); the panel and the run page share the `OpenRun` state, and changing pages closes the panel. `GET /api/automations/:id/runs/:runId` returns the run with its `subjectTitle`, so either view labels it without another request. Step results render through `src/ui/record.ts` as labelled fields with readable dates; people using the studio don't read JSON, so run views never show it raw (the draft's JSON toggle is for designing). `/entities` (`src/ui/entities/`, a Submodel) is a debug page for the entity store. Every page change bumps the model's `revision`, so the previous page's polls and late replies are dropped. `public/_headers` sets the CSP for static assets.

## Verify before finishing

```sh
bun run typecheck && bun run lint && bun run test && bun run format:check
```

- Tests use `bun:test` and sit next to the code they cover. Run Effects with `Effect.runSync` or `Effect.runPromise`.
- Worker and Durable Object behavior can only be tested end to end. Run `mise run dev` and call `/api/automations/...` on the Studio URL it prints. Chat and agent steps call Workers AI for real.

## Debugging a user's automation

The UI keeps the open automation, and its open run, in the URL (`/?automation=<id>&run=<runId>`). When a user shares that URL from `mise run dev`, read the automation over the local API. Dev mode skips Access, so no credentials are needed:

```sh
curl -s "$STUDIO_URL/api/overview"                       # every automation's trigger and runs in flight
curl -s "$STUDIO_URL/api/automations"                    # every automation with a draft
curl -s "$STUDIO_URL/api/automations/<id>"               # draft, saved, conversation, recent runs
curl -s "$STUDIO_URL/api/automations/<id>/runs/<runId>"  # one run: steps, records, tasks; the UI shows the run ID
curl -s "$STUDIO_URL/api/entities/types"                 # entity types
curl -s "$STUDIO_URL/api/entities/<type>"                # a type's entities
```

Stick to these `GET` routes unless the user asks for more. `chat` calls Workers AI and replaces the draft, `save` and `start` change what runs, answering a task moves a run on, `PUT /api/entities/...` (and MCP's `put_entity`) can start runs, and `DELETE` routes remove data.

## Effect

- Before writing Effect code, run `bunx effect-solutions list`, then `bunx effect-solutions show <topic>` for the patterns you need.
- Import from bare modules, e.g. `import * as Effect from "effect/Effect"`.
- New Worker and Durable Object code is Effect-native.
  - Decode every boundary with Schema: request bodies, path params, LLM output, and values read back from storage.
  - Model expected failures with `Schema.TaggedError`.
  - Name operations with `Effect.fn("Module.operation")`.
- Durable Object RPC errors reach the Worker as plain objects. Map them structurally (see `messageOf` in `src/api.ts`); don't use `instanceof`.
- pi-ai and pi-durable stay on purpose even though they are Promise-based. Wrap them in `src/pi.ts` with `Effect.tryPromise` and `PiError`. Don't swap them for Effect AI.

## Alchemy 2

- Alchemy 2 is a beta Effect API, and the v1 (`await alchemy(...)`) docs don't apply.
  - Docs index: https://alchemy.run/llms.txt (append `.md` to a page URL to get markdown).
  - The installed source in `node_modules/alchemy/src` is the final reference.
- Each Worker and Durable Object has two phases:
  - The outer Effect runs at plan time and at cold start. Keep it to binding calls such as `yield* Automation` and `Cloudflare.Workers.AI()`.
  - The inner Effect or handler runs per instance or per request. Storage, the AI binding's `raw`, and callbacks are only usable there.
- Plan time imports `alchemy.run.ts` and everything it reaches under Bun. Never import a module that loads `cloudflare:*` at top level. This is why `src/pi-storage.ts` replaces `agents/harness/pi`.
- `Alchemy.makeCallback` delivers at least once. Keep handlers idempotent:
  - A replay only reruns what the engine's journal lacks. Agent steps use the pi `requestId` `agent:<key>`, where the key is the Activity's idempotency key including the attempt, so a retry asks again but a replay doesn't. Action steps pass a key that stays the same across retries to the operation, and `http.post` sends it as `Idempotency-Key`.
  - Chat replies reuse the pi `requestId` `chat:${chatId}`, and their decode retry `chat:${chatId}:retry`. Only the delivery that still finds that message pending writes the exchange.
  - Callback names and payloads are persisted contracts. Keep them compatible: `designReply` `{ automationId, chatId }`, `advance` `{ executionId }` (jobs from before entity-based triggers carried `{ runId }` and are ignored), and `clock` `{ executionId, deferredName }`.
- Storage keys are persisted contracts too: `draft`, `saved`, `pendingChat`, `run:<id>`, `execution:<executionId>` (its run ID), `exchange:<000000>`, and `exchangeCount` in `Automation`, plus the engine's journal under `wf:<executionId>:` (see `src/durable-engine.ts`). Workflows and runs from before entity-based triggers don't decode; reading one drops it.
- Activity and deferred names in `src/interpreter.ts` (`<id>`, `<id>/refs`, `<id>/now`, `<id>/request`, `<id>/outcome`, `<id>/timeout`, `<id>/approval-request`, `<id>/approval`) are journal keys for runs in flight. Renaming one makes a waiting run redo that step.
- Never edit an applied D1 migration. Add the next numbered file in `migrations/` instead; Alchemy tracks applied files by hash in `__alchemy_migrations`.

## Invariants

- `isPublicHttpsUrl` in `src/workflow.ts` is the SSRF boundary. `http.post` URLs must be literal (no templates), HTTPS, without credentials, and target no private or loopback host. The catalog checks them when a workflow is checked, and the connection runner checks again before sending. Don't loosen either without tests.
- Runs always execute the saved snapshot, never the draft. Workflows must not contain secrets; connections will hold credentials.
- A run starts by checking the saved workflow against the current catalog and expanding its templates (`beginRun` in `src/automation.ts`). The run's payload carries the expanded workflow, so replays never read a template; the interpreter fails an action that still uses one.
- The designer prefers templates to writing text or adding agent steps that write it. Keep that guidance in `designInstructions` when changing the prompt.
- The designer suggests permissions and the person can change them; both merge into the draft's `permissions`. The designer is told the current ones on every turn so it keeps the person's changes.
- A step that didn't run (declined or skipped) records nothing, and the interpreter skips any step that needs its record (`stepNeeds`). That relies on the checker's guarantee that every step a ref names finishes before the reader on every path. Don't loosen one without the other.
- `http.post` doesn't forward trace headers.
- Email, Slack, and Calendar are simulated until they have credentials: they contact nothing and record `simulated: true`. Say so wherever results are shown.
- `/api` keeps a 32 KB request-body limit and returns `{ "error": string }` on failure. The UI relies on that shape.
- `Api` stays private. Only the Access-protected Studio Worker can reach it.

## Deploy and dependencies

- Never run `alchemy deploy`, `alchemy destroy`, or `alchemy dev --stage <deployed stage>` unless asked.
- `alchemy dev` runs locally on stage `dev_$USER`, skips Access, and still needs a Cloudflare profile for Workers AI. Its state lives in the checkout's `.alchemy/state` beside the local data, so each worktree migrates its own database. Deploys use the Cloudflare state store.
- Never commit `.alchemy/` or Access service-token secrets.
- Foldkit, `@foldkit/*`, Vite, and `@effect/platform-*` are pinned exactly on purpose. To upgrade Foldkit, follow `src/ui/AGENTS.md`.
- Patch dependencies only with `bun patch`. Document every patch in `patches/README.md`: the symptom, the cause, what the patch changes, and the upstream fix that would let you remove it. When you upgrade a patched package, recheck its patch.
