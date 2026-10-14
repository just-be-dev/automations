# Automations studio

A single-tenant prototype on Cloudflare: you design sequential automations in a chat, then run them in a Durable Object. `README.md` introduces the product. `ARCHITECTURE.md` explains how the parts fit together; read it before changing a lifecycle. `docs/development.md` covers setup, deploys, evals and the HTTP API, and `docs/workflow-dsl.md` is the workflow format reference. UI rules are in `src/ui/AGENTS.md`.

## Layout

Most modules open with a comment saying what they own.

- `alchemy.run.ts`: re-exports `src/platform/cloudflare/stack.ts`: the `Studio` website with Access and the test service token, and `StudioEnv`.
- `src/platform/cloudflare/`: every Cloudflare implementation: the private `Api` Worker (`api.ts`), the `AutomationAgent`, `StudioAssistant` and `ChangeCoordinator` Durable Objects, the D1 adapters, Workers AI models (`workers-ai.ts`), pi (`pi.ts`, `pi-storage.ts`), the events and Slack actions queues, the Slack `Channels` Worker, and the Studio Worker's entry (`edge.ts`).
- `src/http/`: platform-independent routes, composed in `api.ts`: automations and the overview, entities, roles and templates (`catalog.ts`), changes, events, the assistant, dictation (`transcription.ts`), and entity MCP (`entity-mcp.ts`). `response.ts` shares boundary decoding and responses.
- `src/automation/`: one automation. `application.ts` joins `design-session.ts` (chat, pending replies, drafts) and `runs.ts` (runs, tasks, triggers), which share `workflow-store.ts` (snapshots and save) and `run-store.ts` (run records). `host.ts` is its storage and jobs contract, `service.ts` addresses an automation, and `index.ts` is the D1 directory.
- `src/agents/planner/`, `src/automation/planning.ts`: the planner: its instructions and `planDraft` (`planner.ts`), the working copy (`plan.ts`) its tools (`tools.ts`) edit, progress phrases, and the stored working copy and questions (`planning.ts`).
- `src/agents/namer/`, `src/automation/creation.ts`: creating an automation from a description, named by a fast model.
- `src/assistant/`: the studio-wide assistant session.
- `src/changes/`: confirmed changes to entities, types and templates.
- `src/workflow/`: the pure DSL (`model.ts`), the catalog checker (`catalog.ts`), schedules, the run record (`run.ts`), interpreter values (`execution.ts`), the interpreter, the durable engine, and agent-step prompts (`agent-step.ts`).
- `src/entities/`: entity types and records, templates (`templates.ts`), roles, the `EntityStore` service with its memory layer, and `EntitySubscribers`.
- `src/connections/`: the pure operation registry (`registry.ts`), shared by the planner, the checker and the UI, and the runner that executes operations.
- `src/events/`, `src/channels/slack.ts`: named events and their delivery, and Slack ingress.
- `src/channels/slack-interactivity.ts`, `src/channels/slack-approvals.ts`: Approve and Reject buttons on approval DMs, from the signed click to the decision and the updated message.
- `src/ai/`: the `PiAgent` conversation contract and traces, the shared `ask_question` tool with its `AnswerHub`, and the clef `Classifier` that picks progress phrases and makes decide steps' decisions (`classifier.ts`).
- `src/ui/`: the Foldkit browser app.
- `src/workflow.ts`, `src/entities.ts`, `src/connections.ts`: re-exports that keep the UI's imports. Backend code imports the owning modules.
- `evals/`: evals of every LLM call against the real models. See `docs/development.md#evals`.
- `migrations/`: D1 migrations, applied in numeric order on deploy and under `alchemy dev`.

## Boundaries

- Domain code must not import `src/platform/cloudflare/`, Alchemy, Cloudflare SDKs, or their native globals. `src/platform/boundary.test.ts` checks this.
- HTTP handlers use `Automations` and `RequestIdentity`, never a Durable Object namespace or Access headers. They decode, call one application operation, and encode; they must not repeat writes the operation owns, such as save's.
- Code that reads or writes entities depends on `EntityStore`, never on D1. Yield `EntityStoreD1` and `AutomationIndexD1` in the outer Effect, since they bind D1, and provide the layers they return per request or per instance, since they need a `RuntimeContext`.
- `src/platform/cloudflare/workers-ai.ts` imports no Alchemy, so the evals reuse it.
- `src/platform/cloudflare/edge.ts` only forwards `/api/*` to `Api`. Keep logic out of it.
- Entity MCP handlers run inside the request, over its `EntityStore` and `Changes`. Don't switch to Effect's `McpServer`: it keeps sessions in memory and runs handlers on a fiber outside the request, where D1 can't be reached.
- pi tools are one extension that only the root conversation selects, so agent steps never see them. Build them before opening pi, so an answer resumed after a restart still has them.

## Design sessions and the planner

- `chat` only stores the message as `pendingChat` and schedules `planReply`, so a reload mid-answer loses nothing.
- The planner never writes a whole workflow. Its tools set values or replace steps by ID, and no tool argument nests steps, so a call pi repeats after a restart changes nothing more. Keep every planner tool idempotent.
- The assembled answer must decode and check against the catalog; otherwise the planner gets exactly one retry with the problems. An answer that changed nothing leaves the draft as it is.
- Questions are kept beside the working copy, not in it, so asking never counts as a change.
- Asking parks the planner's pi turn, possibly for days, so nothing may wait on it. `planReply` returns as soon as the turn parks and writes nothing. An answer is stored and `planReply` rescheduled in one transaction.
- The planner reads workflows as YAML (`planYaml`); its tool arguments stay JSON.
- Progress phrases are read by non-technical users. Keep them plain, and never let them reveal the retry or show the agent's raw reasoning.
- Creation never fails on naming: the namer falls back to the description's opening words. If the first message can't be sent, the automation stays listed and the response has no `pendingChat`.

## The assistant and changes

- The assistant reads through `EntityStore`, writes only through `Changes`, and delegates drafts to `Automations.chat` with a stable request ID. It never saves or runs workflows. Its host commits storage and reply scheduling together, and its tools are installed before pi resumes.
- There is one live `ChangeCoordinator` for the tenant. Never instantiate separate coordinators for different writers. D1 and proposal storage cannot share a transaction, so recovery checks original and expected state and blocks conflicting writes.
- Entity, type and template writes over HTTP go through `/api/changes` and `/api/changes/:id/decision`. MCP mutation tools return proposals, and `decide_change` applies the person's decision. Role writes are direct.
- Entity notifications carry `change:<proposalId>` through every adapter to deterministic run IDs.
- Questions and action confirmations are separate. Never treat free text as approval.

## Runs and events

- Only the durable engine owns the replay journal. Never seed interpreter working values from a run record. `RunId` and `ExecutionId` are distinct branded strings; decode them without changing their wire values.
- The interpreter reaches the outside world only through `StepRunner`. Its code outside an Activity reruns on every replay, so keep it deterministic. The engine never keeps a run in memory between events.
- `events.emit` is a permission-controlled operation. `entity.put` writes through the tenant `ChangeCoordinator`, not a separate writer. Confirmed entity writes publish `entity.created`, `entity.updated` and `entity.deleted` before the terminal receipt, so recovery retries the same event ID.
- Event chains stop at depth 16, counting entity-triggered runs too.
- Each automation keeps matched and ignored event receipts, and recovers a run committed before its receipt instead of starting another.
- Slack ingress callbacks write nothing to Slack and must stay replay-safe. Only they may publish `slack.*`. Keep `docs/slack.md` in step with `docs/slack-app-manifest.json`. The channels `namespace` (`automations`) and mailbox storage are persisted contracts.
- A Slack button click is only verified and queued on `Channels`; the `Api` decides it off the `SlackActions` queue through `Automation.respond`. Never call `respond` for a click without the clicker's Slack email, and keep deciding idempotent: a repeated click redraws the task's recorded `decision`. The action IDs (`task.approve`, `task.reject`) and the button value (`{ automation, run, step }`) are persisted in sent messages.
- `EntitySubscribers` returns each subscriber's result or error without preventing the others from being notified.

## Docs and evals

- Keep `docs/workflow-dsl.md` in step with the DSL, and `docs/workflow-engine.md` and `docs/assistant.md` with the code paths they diagram. Code calls `{{ref}}` text a template string; stored approved wording is a template. Keep the two apart in names and docs.
- An `<name>.eval.ts` holds only cases and checks. Keep the framework out of it. A new LLM call needs a route in `evals/framework/worker.ts`.
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

Stick to these `GET` routes unless the user asks for more. `chat` calls Workers AI and replaces the draft, `save` and `start` change what runs, answering a task moves a run on, and approving a `/api/changes` proposal (or MCP's `decide_change`) can write/delete data and start runs. Preparing a proposal writes no entity/template data.

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
- Storage keys are persisted contracts too: `draft`, `saved`, `pendingChat`, `plan` (the planner's working copy for one chat ID, with each `ask_question` call's questions and answer by call ID), `run:<id>`, `studio` (the automation's ID and the studio origin its latest save came from, for task links), `execution:<executionId>` (its run ID), `event:<eventId>` (`{runId}` receipt, with `runId: null` when ignored), `exchange:<000000>`, and `exchangeCount` in `Automation`, plus the engine's journal under `wf:<executionId>:` (see `src/workflow/durable-engine.ts`). Event runs use `event-<eventId>` and retain the optional original event in their run and execution payloads. A stored value that doesn't decode is a defect, not missing data.
- Activity and deferred names in `src/workflow/interpreter.ts` (`<id>`, `<id>/refs`, `<id>/now`, `<id>/request`, `<id>/outcome`, `<id>/timeout`, `<id>/approval-request`, `<id>/approval`) are journal keys for runs in flight. Renaming one makes a waiting run redo that step.
- Never edit an applied D1 migration. Add the next numbered file in `migrations/` instead; Alchemy tracks applied files by hash in `__alchemy_migrations`.

## Invariants

- `isPublicHttpsUrl` in `src/workflow/model.ts` is the SSRF boundary. `http.post` URLs must be literal (no templates), HTTPS, without credentials, and target no private or loopback host. The catalog checks them when a workflow is checked, and the connection runner checks again before sending. Don't loosen either without tests.
- Runs always execute the saved snapshot, never the draft. Workflows must not contain secrets; connections will hold credentials.
- A run starts by checking the saved workflow against the current catalog and expanding its templates (`beginRun` in `src/automation/runs.ts`). The run's payload carries the expanded workflow, so replays never read a template; the interpreter fails an action that still uses one.
- The planner prefers templates to writing text or adding agent steps that write it. Keep that guidance in `plannerInstructions` when changing the prompt.
- The planner suggests permissions and the person can change them; both merge into the draft's `permissions`. The planner reads the current draft, permissions included, on every turn so it keeps the person's changes. Every operation a workflow uses needs one: `"auto"`, or `{ "ask": "<role>" }` naming a role in the entity store.
- Only a role's members answer its approval tasks. `Api` passes the Cloudflare Access email, or for a Slack click the clicker's Slack email, to `Automation.respond`, which checks it against the members the task recorded when it was opened.
- A step that didn't run (declined or skipped) records nothing, and the interpreter skips any step that needs its record (`stepNeeds`). That relies on the checker's guarantee that every step a ref names finishes before the reader on every path. Don't loosen one without the other.
- `http.post` doesn't forward trace headers.
- Email and Calendar are simulated, and so is Slack without `SLACK_BOT_TOKEN`: they contact nothing and record `simulated: true`. Say so wherever results are shown. The UI decides from `GET /api/connections` (`LiveConnections`) for operations and from the record's `simulated` for results, never from the registry alone. With the token, `slack.sendMessage` posts through `SlackSender` (`src/connections/slack.ts`), which the Automation object provides; Slack takes no idempotency key, so a step retried after a post that wasn't journaled posts again. Opening a task DMs its people through the same sender (`src/automation/task-notifications.ts`): it records each recipient on the task as `sending` before posting and checks the DM for the message's key before posting again, and a failure never fails the step. Keep it that way. Without the token, tasks only record `notify`; `notify: "email"` is never sent.
- `/api` keeps a 32 KB request-body limit and returns `{ "error": string }` on failure. The UI relies on that shape.
- `Api` stays private. Only the Access-protected Studio Worker can reach it. The `Channels` Worker is the only other public entry, and it serves only Slack's webhooks and interactivity requests, each of which must carry a valid signature.

## Deploy and dependencies

- Never run `alchemy deploy`, `alchemy destroy`, or `alchemy dev --stage <deployed stage>` unless asked.
- `alchemy dev` runs locally on stage `dev_$USER`, skips Access, and still needs a Cloudflare profile for Workers AI. Its state lives in the checkout's `.alchemy/state` beside the local data, so each worktree migrates its own database. Deploys use the Cloudflare state store.
- Never commit `.alchemy/` or Access service-token secrets.
- Install dependencies with the mise-pinned bun (`mise exec -- bun`); an older bun rewrites the lockfile.
- Foldkit, `@foldkit/*`, Vite, and `@effect/platform-*` are pinned exactly on purpose. To upgrade Foldkit, follow `src/ui/AGENTS.md`.
- Patch dependencies only with `bun patch`. Document every patch in `patches/README.md`: the symptom, the cause, what the patch changes, and the upstream fix that would let you remove it. When you upgrade a patched package, recheck its patch.
