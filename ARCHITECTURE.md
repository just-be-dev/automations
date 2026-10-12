# Architecture

Automations studio separates **designing a workflow** from **executing a saved version**. Models help assemble and interpret plans, but they do not get unrestricted execution: workflows are schema-checked, checked against the current catalog, and run through a fixed set of operations.

This is a single-tenant Cloudflare application. [Development and operations](docs/development.md) covers setup and the HTTP/MCP interfaces; [Workflow DSL](docs/workflow-dsl.md) defines the workflow format.

## Cloudflare hosts the application, not its business rules

```diagram
┌──────────────────────┐
│ Browser · Foldkit UI │
└──────────┬───────────┘
           │ HTTPS · Cloudflare Access in deployed stages
           ▼
┌──────────────────────┐
│ Studio Worker        │
│ Assets + /api proxy  │
└──────────┬───────────┘
           │ service binding
           ▼
┌──────────────────────┐          ┌────────────────────────┐
│ Api Worker · private │─────────▶│ D1                     │
│ Routes + identity    │          │ Directory + catalog    │
└──────────┬───────────┘          └────────────────────────┘
           │ Durable Object RPC
           ├───────────────────────┬────────────────────────┐
           ▼                       ▼                        ▼
┌────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ AutomationAgent    │  │ StudioAssistant     │  │ ChangeCoordinator   │
│ One per automation │  │ One per owner and   │  │ One for the tenant  │
│ Drafts + runs + pi │  │ browser session     │  │ Proposals + receipts│
└────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

`alchemy.run.ts` re-exports [the Cloudflare stack](src/platform/cloudflare/stack.ts). Alchemy declares infrastructure and hosts the Effect implementations in one program. The public `Studio` Worker serves the browser app; [its edge entry](src/platform/cloudflare/edge.ts) only forwards `/api/*` to `Api`. `Api` has `workersDev: false` and no public URL.

When Slack is configured, a third Worker, [`Channels`](src/platform/cloudflare/channels.ts), takes Slack's webhooks through [effect-channels](https://github.com/humanlayer/effect-channels). It is public because Slack must reach it, and it serves only signature-checked provider routes. Each Slack thread gets a `ChannelMailbox` Durable Object that stores its events and runs them in order from its alarm, with retries. [Its callbacks](src/channels/slack.ts) only publish `slack.mention`, `slack.message`, and `slack.reaction` to the `Events` queue under IDs taken from Slack's, so redeliveries reach each automation's event receipts and start nothing twice. The mailbox never touches automations directly.

[The API host](src/platform/cloudflare/api.ts) composes request-scoped services and extracts Access identity. [HTTP routes](src/http/api.ts) decode inputs, call application services, and encode results. They do not know about D1 bindings or Durable Object namespaces. The API caps bodies at 32 KB and returns `{ "error": string }` on failure.

Cloudflare implementations live under `src/platform/cloudflare/`. Dependencies point from those adapters into the application and domain modules, never back. [The boundary test](src/platform/boundary.test.ts) enforces this. Alchemy binding declarations run at plan time and cold start; storage, AI, and callbacks are used only inside request or instance handlers.

## Each lifetime has an owner

| Owner                     | Responsibility                                                                  | Implementation                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Browser application       | Navigation, editable forms, workflow rendering, run panels, polling             | [`src/ui/`](src/ui/AGENTS.md)                                                                                |
| API request               | Boundary validation, identity, service composition                              | [`src/http/`](src/http/api.ts), [`api.ts`](src/platform/cloudflare/api.ts)                                   |
| Automation                | Design session, saved snapshot, runs, durable callbacks                         | [`src/automation/`](src/automation/application.ts), [`automation.ts`](src/platform/cloudflare/automation.ts) |
| Assistant session         | Conversation, typed tools, questions, confirmations, delegated design           | [`src/assistant/`](src/assistant/session.ts), [`assistant.ts`](src/platform/cloudflare/assistant.ts)         |
| Tenant change coordinator | Validated proposals, stale-decision checks, recovery, receipts                  | [`src/changes/`](src/changes/application.ts), [`changes.ts`](src/platform/cloudflare/changes.ts)             |
| Tenant catalog            | Entity types and records, templates, roles, subscriptions, automation directory | [`EntityStore`](src/entities/store.ts), [`AutomationIndex`](src/automation/index.ts), D1 adapters            |
| Workflow execution        | Replay journal, completed activities, clocks, deferred answers                  | [`durable-engine.ts`](src/workflow/durable-engine.ts)                                                        |

`AutomationHost` treats persistence and durable job scheduling as one capability: writes and scheduling commit or roll back together. `AssistantHost` requires the same guarantee for accepting a message and scheduling its reply. Application tests substitute an in-memory host and scripted `PiAgent`; production hosts supply SQLite storage, Alchemy callbacks, and Workers AI.

## Conversation produces a draft, not a running program

```diagram
┌─────────────────────────┐
│ Description or follow-up│
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ Store pendingChat and   │
│ schedule planReply      │
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐        ┌────────────────────────┐
│ Planner edits a working │───────▶│ Park on ask_question   │
│ copy with typed tools   │◀───────│ Persist answer + resume│
└───────────┬─────────────┘        └────────────────────────┘
            ▼
┌─────────────────────────┐
│ Assemble + validate     │
│ Write draft and exchange│
└───────────┬─────────────┘
            │ person chooses Save
            ▼
┌─────────────────────────┐
│ Saved workflow snapshot │
└─────────────────────────┘
```

[The automation facade](src/automation/application.ts) composes two independent lifecycles: [design sessions](src/automation/design-session.ts) and [runs](src/automation/runs.ts). Both use [the workflow store](src/automation/workflow-store.ts); neither imports the other.

The planner’s instructions come from the current entity types, templates, roles, and connection registry. [Planner tools](src/agents/planner/tools.ts) edit [a flat working copy](src/agents/planner/plan.ts): each step is stored once, and container steps name their children by ID. Tools set or replace values so replaying a call does not apply the edit twice. The planner reads workflow content as YAML; tool arguments remain JSON.

When the answer arrives, the application assembles the tree and checks its schema and catalog references. Invalid output gets one retry with the problems. A turn that changes nothing leaves the draft alone. Questions live beside the working copy, so asking one is not a workflow edit.

`ask_question` parks the pi turn without holding the Durable Object’s callback open. Answers and rescheduling commit together. [AnswerHub](src/ai/ask-question/answer-hub.ts) wakes a turn still in memory; after a restart, the replayed tool finds the persisted answer by call ID. Browsers poll until `pendingChat` clears. Progress phrases describe the planner’s work without exposing raw reasoning.

Saving validates the draft, commits the snapshot and its timed-trigger job together, updates its entity subscription, then best-effort updates the directory. The subscription is in D1 and cannot share the snapshot transaction. If it fails, the snapshot remains saved and the caller gets an error; retrying save repairs it. A directory failure does not fail the save.

## A run executes its own snapshot and replays from a journal

Named events are an application capability in `src/events/`, hosted by a Cloudflare Queue. The private Api Worker consumes the queue, applies `entity.put` through the same tenant-wide change coordinator, and fans each event out through `Automations.eventReceived`. Each automation serializes receipt checks and remembers matched and ignored IDs; a matching run journals the original event along with its saved workflow and subject. `events.emit` is a normal permission-controlled action whose publication ID stays stable across activity retries.

Confirmed entity creations, updates and deletions publish lifecycle facts from the coordinator's original before/after snapshots. Queue acceptance precedes the terminal change receipt, so a failed send leaves the persisted applying intent recoverable. Authorized event commands persist that intent during preparation, preventing a restart before application from making the command stale. Event depth follows commands, lifecycle facts and entity-triggered runs, and stops publication at 16 hops. See [events and entity commands](docs/workflow-dsl.md#publishing-events-and-entity-commands) for authorization and delivery semantics.

Runs start from the **saved workflow**, never the draft. [Run coordination](src/automation/runs.ts) checks it against the current catalog and expands stored templates into plain action inputs. The expanded workflow travels in the execution payload, so template edits cannot change a run already in flight.

```diagram
┌──────────────────────────┐
│ Manual / entity / timed  │
│ trigger                  │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│ Validate saved workflow  │
│ Expand templates         │
│ Create run + schedule    │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐       ┌────────────────────────┐
│ Interpreter replays      │◀─────▶│ Journal                │
│ deterministic step walk  │       │ Activities + deferreds │
└────────────┬─────────────┘       │ + clocks + outcome     │
             │                     └────────────────────────┘
             ▼
┌──────────────────────────┐
│ StepRunner               │
│ AI / actions / human work│
└────────────┬─────────────┘
             │ reports and final outcome
             ▼
┌──────────────────────────┐
│ Run record → browser     │
│ Results + tasks + status │
└──────────────────────────┘
```

[The interpreter](src/workflow/interpreter.ts) is an Effect Workflow. External work goes through `StepRunner` inside Activities; waits and human answers use durable clocks and deferreds. [The durable engine](src/workflow/durable-engine.ts) journals them in the automation’s storage. A callback wakes the engine, which rebuilds the execution rather than relying on a process staying alive.

Three representations serve different purposes:

- **`Run`** is the application record people see: the executed workflow, subject, step results, tasks, and status. [The run store](src/automation/run-store.ts) serializes parallel reports and settles it from engine outcomes.
- **`ExecutionValues`** is the subject and completed-step values rebuilt during each interpreter walk. It is never seeded from the application run record.
- **The journal** is authoritative for completed Activities, deferred answers, clocks, and execution outcomes. It lives under `wf:<executionId>:`.

`RunId` addresses the application record; `ExecutionId` addresses the journal. They are distinct branded types with unchanged string wire formats. `execution:<executionId>` maps an execution to its run.

Callbacks are delivered at least once. Agent Activities reuse pi request IDs on replay; action steps use stable operation keys across retries, and `http.post` sends them as `Idempotency-Key`. Receivers must handle duplicate delivery. Callback names, Activity names, deferred names, and storage keys are persisted contracts: changing them can make a waiting run repeat work.

Timed triggers schedule one pending `tick`. Occurrence time and subject determine run IDs, so redelivery finds the existing runs. A scheduled occurrence starts at most 50 runs; if it matches more, it starts none and records a failure. Date triggers check daily in their configured time zone and use each entity’s current date.

## Assistant and manual changes share one confirmation path

[The studio assistant](src/assistant/session.ts) reads through `EntityStore`, proposes mutations through `Changes`, and delegates drafts through `Automations.chat` with stable request IDs. It never saves or runs a workflow. Its Durable Object is keyed by trusted Access identity and a browser session UUID, separate from every automation’s planner conversation.

Manual forms, assistant tools, and MCP entity/type mutations all use the tenant’s single `ChangeCoordinator`:

```diagram
┌─────────────────────────────┐
│ Manual UI / assistant / MCP │
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ Preview validated action    │
│ Persist exact proposal and  │
│ consequences                │
└──────────────┬──────────────┘
               │ explicit approval
               ▼
┌─────────────────────────────┐
│ Recheck snapshots           │
│ Apply or reject stale change│
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ Write data + notify         │
│ subscribers + retain receipt│
└─────────────────────────────┘
```

[Change preparation](src/changes/application.ts) uses production validation against a memory snapshot, then stores the exact action and consequences. Approval checks that the snapshot is still current. Free text is never approval. Catalog-wide snapshots mean even an unrelated edit can make a proposal stale.

D1 data and proposal storage cannot share a transaction. Persisted applying intents, original/expected-state checks, and terminal receipts let recovery continue known writes and block conflicts. Notifications carry `change:<proposalId>` through [EntitySubscribers](src/entities/subscribers.ts) to deterministic run IDs, preventing a resumed approval from starting a duplicate run. Role writes are direct rather than proposal-based.

## Catalogs and adapters keep validation consistent

- [`src/workflow/model.ts`](src/workflow/model.ts) defines the pure workflow DSL, references, and conditions. [`catalog.ts`](src/workflow/catalog.ts) checks entity references, path ordering, operation inputs, template slots, and permissions.
- [`src/entities/`](src/entities/store.ts) owns entity models, approved templates, roles, subscriptions, and shared storage validation. The memory store and D1 adapter use the same rules.
- [`src/connections/registry.ts`](src/connections/registry.ts) describes operations without executing them. The planner, checker, and UI share it. [`runner.ts`](src/connections/runner.ts) executes those operations.
- [`src/ai/pi.ts`](src/ai/pi.ts) defines conversations, tools, and traces. The Cloudflare implementation wraps Promise-based pi-ai and pi-durable in Effect and stores conversations in Durable Object SQLite. [`workers-ai.ts`](src/platform/cloudflare/workers-ai.ts) selects the real models; evals reuse it.
- [`src/http/entity-mcp.ts`](src/http/entity-mcp.ts) exposes the entity store over stateless MCP JSON-RPC. Handlers run within the request so they retain access to D1; the assistant uses application tools directly, not MCP.

D1 holds the automation directory because Cloudflare cannot enumerate Durable Object names. It also holds entity types and records, templates, roles, and subscriptions. Each automation’s Durable Object holds drafts, saved workflows, chat exchanges, pending planning work, run records, the replay journal, and pi conversations. Assistant sessions and change proposals have their own Durable Objects.

## Browser state and server state have separate lifecycles

[The Foldkit UI](src/ui/AGENTS.md) follows Elm-style Model → Message → Update → View, with side effects in Commands. The root owns the studio, run page, and run panel; overview, templates, entities, and traces are page Submodels.

Routes preserve the open automation and run in the URL. Page changes increment a revision so old requests and polls cannot overwrite the new page. The global assistant sits outside the page lifecycle and uses its own request sequencing. Follow-along uses actual assistant activity links and does not navigate over dirty forms or unsent messages.

Agent replies render Markdown tokens without setting raw HTML. Run results render as labelled fields, not raw JSON. The operation registry marks Email, Slack, and Calendar as simulated. A deployment with `SLACK_BOT_TOKEN` connects Slack; `GET /api/connections` lists what is connected, so the UI tags an operation "Simulated" only when it is, and a run's result says so from its own `simulated: true` record.

## Guarantees have deliberate limits

- Approval tasks record the role’s members when opened and check the Access email when answered. The private API trusts the Studio’s identity header; local dev and service-token requests have no email restriction. JWT verification and the rest of the security boundary need production review.
- `http.post` accepts only literal public HTTPS URLs without credentials. Both the catalog and connection runner enforce the URL boundary. It does not forward trace headers. Workflows must not contain secrets.
- Steps that are declined or skipped record nothing. Dependent steps are skipped; catalog checks guarantee that referenced steps precede their readers on every path.
- Email, Calendar, and human notifications do not send anything in the prototype. Slack posts only when `SLACK_BOT_TOKEN` is set ([setup](docs/slack.md)). HTTP requests are real.

Application tests use memory implementations and scripted models. UI Story and Scene tests exercise state transitions and accessible views. Native Worker behavior requires local end-to-end checks, and real-model evals measure prompt behavior that scripted tests cannot. See [the development guide](docs/development.md#evals) for commands.

## Principles for changes

These come from separating domain and Cloudflare code, splitting the design and execution lifecycles, and making persistence and replay explicit. Adapt them; they are not a directory template.

- **Group code by domain and ownership.** Keep a domain's models, validation, operations and service contracts together. Split a module when a responsibility has its own state, invariants, dependencies or lifecycle, not because a file grew. A facade composes components and joins their results; it doesn't keep the logic they were extracted to own.
- **Name services for capabilities.** `EntityStore`, not D1. Keep validation and merging in domain code so memory and production implementations obey the same rules. Not every component needs a service tag: an Effect constructor returning a record of operations is often enough. Add indirection only where it protects a real boundary.
- **Construct each resource at its lifetime's boundary:** application, request, tenant, session or execution. A lock protects only callers that share its instance, and an in-memory lock doesn't coordinate separate processes.
- **Application operations own complete use cases.** Ordering, authorization, transactions and partial-failure policy live in the operation, not its callers. Distinguish required writes from best-effort ones, and say what remains written after each failure and how a retry recovers.
- **Keep capabilities that share an invariant together.** Don't split persistence and job scheduling when they must commit together. Don't imply all-or-nothing behavior across stores that can't share a transaction.
- **Read configuration at composition boundaries** with Effect `Config`, and pass resolved values in. Add an option when the application needs a choice, not because a value could vary.
- **Test the guarantees, not just the happy path.** Cover partial failures, retries, concurrent updates and replay with inputs that tell correct behavior from plausible mistakes. A memory adapter passing a test doesn't prove the production adapter's transaction or runtime guarantees.
- **Refactor ownership separately from changing behavior,** and verify each reviewable stage before committing it.
