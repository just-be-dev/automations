# Architecture

Automations studio separates **designing a workflow** from **executing a saved version**. Models help assemble and interpret plans, but they do not get unrestricted execution: workflows are schema-checked, checked against the current catalog, and run through a fixed set of operations.

This is a single-tenant Cloudflare application. [Development and operations](docs/development.md) covers setup and the HTTP/MCP interfaces; [Workflow DSL](docs/workflow-dsl.md) defines the workflow format. [Workflow engine](docs/workflow-engine.md) traces the engine through the code in more detail. This document covers how the parts fit together:

1. [Deployment](#cloudflare-hosts-the-application-not-its-business-rules): Workers, Durable Objects, storage and queues.
2. [Code layout](#code-is-layered-by-ownership): layers and which module owns each lifetime.
3. [Automations and the planner](#an-automation-is-one-durable-object): how a conversation becomes a saved workflow.
4. [The workflow engine](#the-workflow-engine-replays-a-run-from-its-journal): how a run executes, suspends and resumes.
5. [The hub's assistant](#the-hubs-assistant-works-through-mcp): the platform's agent, and the MCP server it uses.
6. [Entities](#entity-store-is-the-system-of-record-for-entities), [changes](#every-data-change-goes-through-one-coordinator) and [events](#events-flow-through-one-queue): where entities live, confirmed writes, and the event pipeline.
7. [Browser](#browser-state-and-server-state-have-separate-lifecycles), [limits](#guarantees-have-deliberate-limits) and [principles](#principles-for-changes).

## Cloudflare hosts the application, not its business rules

```diagram
┌──────────────────────┐                           ┌──────────────────────┐
│ Browser · Foldkit UI │                           │ Slack                │
└──────────┬───────────┘                           └──────────┬───────────┘
           │ HTTPS · Cloudflare Access                        │ signed webhook
           ▼                                                  ▼
┌──────────────────────┐                           ┌──────────────────────┐
│ Studio Worker        │                           │ Channels Worker      │
│ assets + /api proxy  │                           │ public · optional    │
└──────────┬───────────┘                           └──────────┬───────────┘
           │ service binding                                  ▼
           ▼                                       ┌──────────────────────┐
┌──────────────────────┐                           │ ChannelMailbox DO    │
│ Api Worker · private │      publish + consume    │ one per Slack thread │
│ routes + identity    │◀──────────┐               └──────────┬───────────┘
│ queue consumer       │           │                          │ slack.*
└──────────┬───────────┘           ▼                          │
           │              ┌──────────────────────┐            │
           │              │ Events queue         │◀───────────┘
           │              │ + FailedEvents (DLQ) │
           │              └──────────────────────┘
           │                         ▲ events.emit · entity.* facts
           │ Durable Object RPC      │
           ▼                         │
┌────────────────────────────────────┴────────────────────────────────────┐
│ AutomationAgent                                   ChangeCoordinator     │
│ one per automation                                one, named "studio"   │
│ drafts, runs, journal                             proposals, receipts   │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    ▼
┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
│ entity-store          │ │ D1                    │ │ Workers AI            │
│ its own stack · types │ │ directory, templates  │ │ pi models, namer,     │
│ entities              │ │ + subscriptions       │ │ clef                  │
└───────────┬───────────┘ └───────────────────────┘ └───────────────────────┘
            │ change queue: every committed entity write, consumed by Api
            ▼
  Api Worker: entity.* facts to the Events queue, entity triggers
```

`alchemy.run.ts` re-exports [the Cloudflare stack](src/platform/cloudflare/stack.ts). Alchemy declares infrastructure and hosts the Effect implementations in one program. The `Studio` Worker serves the browser app behind Cloudflare Access in deployed stages; [its edge entry](src/platform/cloudflare/edge.ts) only forwards `/api/*` to `Api`. `Api` has `workersDev: false` and no public URL.

The Durable Objects call each other, so the tier in the diagram is not flat:

| Host                | D1   | Workers AI | Publishes events | Calls over RPC                                   |
| ------------------- | ---- | ---------- | ---------------- | ------------------------------------------------ |
| `Api` Worker        | ✓    | ✓          | ✓ (and consumes) | AutomationAgent, ChangeCoordinator, entity-store |
| `AutomationAgent`   | ✓    | ✓          | ✓                | entity-store                                     |
| `ChangeCoordinator` | ✓    | none       | none             | AutomationAgent (template uses), entity-store    |
| `ChannelMailbox`    | none | none       | ✓                | none                                             |

When Slack is configured, a third Worker, [`Channels`](src/platform/cloudflare/channels.ts), takes Slack's webhooks through [effect-channels](https://github.com/humanlayer/effect-channels), and clicks on an approval DM's buttons. It is public because Slack must reach it, and it serves only signature-checked Slack routes. [Events](#events-flow-through-one-queue) describes what it publishes, and [approving from Slack](#approvals-from-slack-go-through-respond) where clicks go.

[The API host](src/platform/cloudflare/api.ts) rebuilds its service layers for each request, because they capture the request's runtime context and Access identity. Besides `fetch`, its default entrypoint has one RPC method, `mcp`, for the hub's assistant in the agents stack ([MCP](docs/development.md#mcp)). [HTTP routes](src/http/api.ts) decode inputs, call one application operation, and encode results. They do not know about D1 bindings or Durable Object namespaces. JSON routes cap bodies at 32 KB and return `{ "error": string }` on failure; MCP returns JSON-RPC errors.

## Code is layered by ownership

```diagram
┌─────────────────────────────────────────────────────────────────────────┐
│ src/ui/  Foldkit browser app                                            │
│ imports shared schemas only; talks to the server as JSON over /api/*    │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ HTTP
┌────────────────────────────────────▼────────────────────────────────────┐
│ src/platform/cloudflare/  Alchemy stack, Workers, Durable Objects,      │
│ D1 / Queue / Workers AI / pi adapters, Access identity                  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ provides layers for service tags
┌────────────────────────────────────▼────────────────────────────────────┐
│ src/http/  routes, RequestIdentity, the studio's MCP server             │
├─────────────────────────────────────────────────────────────────────────┤
│ application: automation/, agents/, changes/, events/,                   │
│ channels/                                                               │
├─────────────────────────────────────────────────────────────────────────┤
│ domain and contracts: workflow/, entities/, connections/, ai/,          │
│ */service.ts, */host.ts                                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

Dependencies point from the Cloudflare adapters into the application and domain modules, never back. [The boundary test](src/platform/boundary.test.ts) checks every module outside `ui/` and `platform/`: none may import Alchemy, `cloudflare:*`, `@cloudflare/*`, `agents`, or `src/platform/`, or name native types such as `D1Database` or `DurableObjectStorage`. Alchemy binding declarations run at plan time and cold start; storage, AI, and callbacks are used only inside request or instance handlers.

| Owner                     | Responsibility                                                               | Implementation                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Browser application       | Navigation, editable forms, workflow rendering, run panels, polling          | [`src/ui/`](src/ui/AGENTS.md)                                                                                |
| API request               | Boundary validation, identity, per-request service composition               | [`src/http/`](src/http/api.ts), [`api.ts`](src/platform/cloudflare/api.ts)                                   |
| Automation                | Design session, saved snapshot, runs, durable callbacks, pi conversations    | [`src/automation/`](src/automation/application.ts), [`automation.ts`](src/platform/cloudflare/automation.ts) |
| Planner and namer         | Planner instructions, working copy and tools; naming new automations         | [`src/agents/`](src/agents/planner/planner.ts), [`planning.ts`](src/automation/planning.ts)                  |
| Workflow execution        | Replay journal, completed activities, clocks, deferred answers               | [`durable-engine.ts`](src/workflow/durable-engine.ts), [`interpreter.ts`](src/workflow/interpreter.ts)       |
| MCP server                | The studio's tools for the hub's assistant and other MCP clients             | [`mcp-server.ts`](src/http/mcp-server.ts), [`api.ts`](src/platform/cloudflare/api.ts)                        |
| Tenant change coordinator | Validated proposals, stale-decision checks, recovery, receipts               | [`src/changes/`](src/changes/application.ts), [`changes.ts`](src/platform/cloudflare/changes.ts)             |
| Tenant catalog            | Entity types and records (entity-store); templates, subscriptions, directory | [`EntityStore`](src/entities/store.ts), [`AutomationIndex`](src/automation/index.ts), adapters               |
| Events                    | Event model, publishing, queue delivery, Slack ingress                       | [`src/events/`](src/events/delivery.ts), [`src/channels/`](src/channels/slack.ts)                            |

`AutomationHost` treats persistence and durable job scheduling as one capability: writes and scheduling commit or roll back together. Application tests substitute an in-memory host and scripted `PiAgent`; production hosts supply SQLite storage, Alchemy callbacks, and Workers AI.

## An automation is one Durable Object

```diagram
                 Automations service: DO RPC by automation id
                                      │
┌─────────────────────────────────────▼───────────────────────────────────┐
│ AutomationAgent Durable Object                                          │
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ Automation facade · chat, answer, save, start, respond, reads       │ │
│ └─────────┬───────────────────────────────────────────────┬───────────┘ │
│           ▼                                               ▼             │
│ ┌───────────────────┐    ┌───────────────────┐    ┌───────────────────┐ │
│ │ Design session    │───▶│ Workflow store    │◀───│ Runs              │ │
│ │ chat · planReply  │    │ draft · saved     │    │ triggers · tasks  │ │
│ │ answer · progress │    │ save              │    │ engine callbacks  │ │
│ └───┬───────────┬───┘    └───────────────────┘    └────┬─────────┬────┘ │
│     ▼           │                                      │         ▼      │
│ ┌───────────┐   │                                      │  ┌───────────┐ │
│ │ Planning  │   │                                      │  │ Run store │ │
│ │ plan +    │   │                                      │  │ run:*     │ │
│ │ questions │   ▼                                      ▼  └───────────┘ │
│ └─────┬─────┘ ┌──────────────────────────────────────────┐              │
│       │       │ PiAgent · pi-durable in SQLite (pi_*)    │              │
│       │       │ root conversation: planner tools         │              │
│       │       │ one conversation per run: agent steps    │              │
│       ▼       └──────────────────────────────────────────┘              │
│ ┌───────────┐                                                           │
│ │ AnswerHub │ ┌──────────────────────────────────────────────────────┐  │
│ │ in memory │ │ AutomationHost: storage + jobs in one transaction    │  │
│ └───────────┘ │ callbacks: planReply · advance · clock · tick        │  │
│               └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     ▼
      EntityStore (entity-store + D1), AutomationIndex (D1) · Events queue
```

[The automation facade](src/automation/application.ts) composes two independent lifecycles: [design sessions](src/automation/design-session.ts) and [runs](src/automation/runs.ts). Both use [the workflow store](src/automation/workflow-store.ts); neither imports the other. The facade merges their callbacks and joins their reads.

Each automation's Durable Object holds its draft, saved workflow, chat exchanges, pending planning work, run records, the replay journal, and pi conversations. D1 holds what must be listed across automations: the directory, because Cloudflare cannot enumerate Durable Object names, plus templates and subscriptions. Entity types and entities live in [entity-store](#entity-store-is-the-system-of-record-for-entities).

### Creation names the automation, then sends the first message

The studio designs automations only through [the hub's assistant](#the-hubs-assistant-works-through-mcp): **New automation** opens its drawer with a prompt, its `create_automation` tool runs the creation below, and the studio page shows the draft without a chat of its own. `POST /api/automations` runs the same creation for API clients and the demo reset. It runs in the Api Worker. [A fast model](src/agents/namer/namer.ts) names the automation from its description, falling back to the description's opening words, so creation never fails on naming. [Creation](src/automation/creation.ts) claims a slug ID in the directory, then sends the description as the first chat message. If that send fails, the automation stays listed without a pending chat.

### Conversation produces a draft, not a running program

```diagram
 POST chat, or Automations.chat from MCP's draft tools with a request ID
          │
          ▼
┌──────────────────────────────────┐  questions open?
│ chat                             │──── yes: the message becomes the answer
│ one transaction:                 │
│   pendingChat = working          │
│   schedule planReply(chatId)     │
└────────────────┬─────────────────┘
                 │ callback, at least once
                 ▼
┌──────────────────────────────────┐
│ planReply                        │◀───────────────────────────────┐
│ still working? questions open?   │                                │
│ working copy from the draft,     │                                │
│ kept across redeliveries         │                                │
└────────────────┬─────────────────┘                                │
                 ▼                                                  │
┌──────────────────────────────────┐    ┌─────────────────────────┐ │
│ planDraft · pi turn chat:<id>    │    │ ask_question            │ │
│ instructions from the catalog    │───▶│ store questions in plan │ │
│ tools edit the stored copy       │    │ park: planReply returns │ │
│ progress raced alongside         │    │ and writes nothing      │ │
└────────────────┬─────────────────┘    └────────────┬────────────┘ │
                 │                                   │ status asking│
                 │                                   ▼              │
                 │                      ┌─────────────────────────┐ │
                 │                      │ POST answers            │ │
                 │                      │ one transaction: store  │─┘
                 │                      │ answer + schedule       │
                 │                      │ planReply; then wake an │
                 │                      │ in-memory turn          │
                 │                      └─────────────────────────┘
                 ▼
┌──────────────────────────────────┐
│ assemble the tree, check catalog │
│ invalid: one retry with problems │
└────────────────┬─────────────────┘
                 ▼
┌──────────────────────────────────┐
│ one transaction:                 │
│   changed: draft (keep the       │
│   person's permissions)          │
│   exchange, clear pendingChat    │
│   failed: pendingChat = failed   │
└────────────────┬─────────────────┘
                 ▼
     directory name, best effort
```

`chat` only stores the message and schedules `planReply`, so a reload mid-answer loses nothing. A second message while one is working is refused, and a message sent while questions are open answers them. MCP's `draft_automation` may pass a request ID, which makes its delegated chat idempotent.

The planner's instructions come from the current entity types, templates, and connection registry, rebuilt on each turn and resent only when they change. [Planner tools](src/agents/planner/tools.ts) edit [a flat working copy](src/agents/planner/plan.ts): each step is stored once, and container steps name their children by ID. Tools set or replace values so replaying a call does not apply the edit twice. The planner reads workflow content as YAML; tool arguments remain JSON.

When the answer arrives, the application assembles the tree and checks its schema and catalog references. An invalid, empty or oversized answer gets one retry with the problems; a pi failure marks the chat failed. A turn that changes nothing leaves the draft alone. A turn that edits an existing draft records [what it changed](src/workflow/changes.ts) with its exchange: steps matched by ID, old field values, and the name, trigger and permissions. Questions live beside the working copy, so asking one is not a workflow edit.

`ask_question` parks the pi turn without holding the Durable Object's callback open: the callback returns, and the pi submission waits. Answers and rescheduling commit together. [AnswerHub](src/ai/ask-question/answer-hub.ts) wakes a turn still in memory; after a restart, the replayed tool finds the persisted answer by call ID. Browsers poll while the chat is working or asking.

Progress phrases come from two sources. Tool and request state map to fixed phrases, and a small classifier picks a phrase from the planner's recent reasoning. They are held in memory and never expose raw reasoning.

Saving validates the draft and refuses a timed trigger that already matches more than 50 subjects. It commits the snapshot and its timed-trigger job together, updates its entity subscription, then best-effort updates the directory. The subscription is in D1 and cannot share the snapshot transaction. If it fails, the snapshot remains saved and the caller gets an error; retrying save repairs it. A directory failure does not fail the save.

A draft can also come from outside the planner: `PUT /api/automations/:id/draft` replaces it with a workflow that checks against the catalog, as long as no reply is in progress. The conversation stays as it was, and the planner edits the new draft on the next message.

Removing an automation (`DELETE /api/automations/:id`) drops its subscription and its directory entry, then [erases](src/automation/host.ts) its Durable Object. Erasing deletes every key, pi's tables, and the scheduler's jobs with the native alarm, so runs in flight stop and nothing fires later. pi keeps handles to its tables, so the object then resets itself. That reset fails the RPC, and [the client](src/platform/cloudflare/automations.ts) recognizes it by its reason. The next call to that ID opens an empty automation. The D1 writes come first because the reset ends the call; a retry finishes a removal that failed partway.

## The workflow engine replays a run from its journal

```diagram
 manual start · entityChanged · eventReceived · tick
                       │ DO RPC or callback
                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Runs · src/automation/runs.ts                                            │
│ beginRun · advance · clock · tick · respond                              │
└──────┬─────────────────────┬─────────────────────────────────┬───────────┘
       │ settle              │ replay, fireClock               │ builds
       ▼                     ▼                                 ▼
┌──────────────┐   ┌───────────────────┐        ┌──────────────────────────┐
│ Run store    │   │ Durable engine    │        │ StepRunner               │
│ run:<runId>  │   │ wf:<executionId>: │        │ resolve · agent · decide │
│ execution:*  │◀─┐│ one replay at a   │        │ action · requestHuman ·  │
│              │  ││ time per run      │        │ requestPermission ·      │
│              │  ││                   │        │ report                   │
└──────────────┘  │└─────────┬─────────┘        └──▲────┬─────┬────┬────┬──┘
                  │          │ executes            │    │     │    │    │
                  │          ▼                     │    ▼     │    ▼    │
                  │┌───────────────────┐ Activity  │ ┌──────┐ │ ┌─────┐ │
                  ││ Interpreter       │───────────┘ │ pi + │ │ │ D1  │ │
                  ││ RunAutomation     │             │ clef │ │ └─────┘ │
                  ││ deterministic walk│             └──────┘ │         │
                  │└───────────────────┘                      ▼         │
                  │                            ┌──────────────────────┐ │
                  │                            │ action runner        │ │
                  │                            │ Events, Slack, email │ │
                  │                            │ HTTPS, simulated ops │ │
                  │                            └──────────────────────┘ │
                  └─────────────────────────────────────────────────────┘
                                 report: step results
```

[The interpreter](src/workflow/interpreter.ts) is an Effect Workflow named `RunAutomation`. It walks the step tree and reaches the outside world only through `StepRunner`, inside Activities. [The durable engine](src/workflow/durable-engine.ts) implements Effect's `WorkflowEngine` over the automation's storage. A callback wakes the engine, which rebuilds the execution from the start rather than relying on a process staying alive. [Run coordination](src/automation/runs.ts) builds the `StepRunner` and connects the engine's wakeups to Alchemy jobs.

### A run starts from the saved snapshot

```diagram
┌──────────────────────────────────────────────────────────────────┐
│ beginRun(saved workflow, subject, run ID, event?)                │
│ check against the current catalog · expand templates             │
│   fails: record a failed run, start no execution                 │
└───────────────────────────────┬──────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ one transaction                                                  │
│   run:<runId> = running                                          │
│   execution:<executionId> = runId                                │
│   wf:<executionId>:payload = expanded workflow, subject, event   │
│   schedule advance(executionId)                                  │
└───────────────────────────────┬──────────────────────────────────┘
                                │ advance callback, at least once
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ advance: waiting → running, then replay                          │
│ interpreter walks from the first step                            │
│   Activity already journaled? reuse its stored exit              │
│   otherwise run it through StepRunner and journal the exit       │
│   deferred missing? suspend                                      │
│ StepRunner.report updates step results as the walk goes          │
└───────────────────────────────┬──────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ settle the run record from the replay result                     │
│ suspended → waiting · success → completed                        │
│ stop step → stopped · failure → failed                           │
└──────────────────────────────────────────────────────────────────┘
```

Runs start from the **saved workflow**, never the draft. `beginRun` checks it against the current catalog and expands stored templates into plain action inputs. The expanded workflow travels in the execution payload, so template edits cannot change a run already in flight. A run that fails this check is recorded as failed without an execution.

Four triggers call `beginRun`, and each picks a deterministic run ID so a redelivery finds the existing run:

| Trigger         | Entry point     | Run ID                                    |
| --------------- | --------------- | ----------------------------------------- |
| Manual          | `start`         | random                                    |
| Entity change   | `entityChanged` | `entity-entity-store:<seq>`               |
| Named event     | `eventReceived` | `event-<eventId>`                         |
| Schedule / date | `tick`          | `scheduled-<at>` or `scheduled-<at>-<id>` |

Entity and event notifications are serialized per automation. Each event leaves a receipt, matched or ignored, and a run committed before its receipt is recovered instead of started again. A matching event run journals the original event, which the interpreter exposes to refs, agent context, and `events.emit` depth.

Timed triggers schedule one pending `tick`. Each tick starts its occurrence's runs, then books the next occurrence after the later of its own time and now, so a late tick does not replay missed occurrences. An occurrence that matches more than 50 subjects starts none and records a failure. Date triggers tick daily in their configured time zone and use each entity's current date.

### Suspension leaves nothing running

```diagram
┌─────────────────────────────────┐    ┌─────────────────────────────────┐
│ human task or approval          │    │ wait, or a human step timeout   │
│ Activity <step>/request adds a  │    │ over 60 s: wf:…:clock:<name>    │
│ task with a token to the run    │    │ and schedule clock(at)          │
│ await deferred <step> or        │    │ 60 s or less: in-memory sleep   │
│ <step>/approval                 │    │ inside an Activity              │
└────────────────┬────────────────┘    └────────────────┬────────────────┘
                 │ deferred missing: replay suspends,   │
                 │ run settles as waiting               │
                 ▼                                      ▼
┌─────────────────────────────────┐    ┌─────────────────────────────────┐
│ POST respond, or a Slack click  │    │ clock callback at `at`          │
│ task open? who answered?        │    │ fireClock                       │
│ values valid?                   │    │                                 │
└────────────────┬────────────────┘    └────────────────┬────────────────┘
                 │                                      │
                 └──────────────────┬───────────────────┘
                                    ▼
                 ┌─────────────────────────────────────┐
                 │ write wf:…:deferred:<name>,         │
                 │ first write wins                    │
                 │ schedule advance(executionId)       │
                 └──────────────────┬──────────────────┘
                                    ▼
                 ┌─────────────────────────────────────┐
                 │ advance: replay from the start;     │
                 │ completed Activities are reused,    │
                 │ the deferred is now present         │
                 └─────────────────────────────────────┘
```

A suspended run holds no fiber, lock or open callback. Parallel branches that suspend make the whole replay suspend, but their completed Activities stay journaled. A human step with a timeout races its answer against a durable clock under `raceAll/<step>/outcome`.

### The journal is authoritative

Three representations serve different purposes:

- **`Run`** is the application record people see: the executed workflow, subject, step results, tasks, and status. [The run store](src/automation/run-store.ts) serializes parallel reports, never moves a finished step backwards, and settles the run from engine outcomes.
- **`ExecutionValues`** is the run ID, subject, optional event, and completed-step values rebuilt during each interpreter walk. It is never seeded from the application run record.
- **The journal** is authoritative for completed Activities, deferred answers, clocks, and execution outcomes. It lives under `wf:<executionId>:`.

| Journal key                 | Holds                                                        |
| --------------------------- | ------------------------------------------------------------ |
| `payload`                   | The expanded workflow, subject and event; written once       |
| `activity:<name>:<attempt>` | Each attempt's exit, success or failure                      |
| `deferred:<name>`           | A human answer, approval or fired clock; first write wins    |
| `clock:<name>`              | The wake time; the first one scheduled is kept               |
| `result`                    | The final outcome, written only when the execution completes |

`RunId` addresses the application record; `ExecutionId` addresses the journal. They are distinct branded types with unchanged string wire formats. `execution:<executionId>` maps an execution to its run.

Each step kind maps onto the engine's primitives:

| Step       | Durable mapping                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `agent`    | Activity `<step>`, retried twice; pi request ID `agent:<key>` includes the attempt                |
| `decide`   | Activity `<step>`, retried twice; asks the step's clef model, then runs the chosen option's steps |
| `action`   | Optional approval (`<step>/approval-request`, deferred `<step>/approval`), then Activity `<step>` |
| `human`    | Activity `<step>/request`, deferred `<step>`, optional timeout clock                              |
| `wait`     | Durable clock, reading the time through Activity `<step>/now` for `until`                         |
| `if`       | Records the matched case, reading `<step>/now` when a case needs the time                         |
| `parallel` | Runs branches concurrently and merges their values                                                |
| `stop`     | Records the reason and fails with `RunStopped`                                                    |

Steps that read refs resolve them first in Activity `<step>/refs`. A step whose needed step did not run is skipped.

Callbacks are delivered at least once. Agent Activities reuse a pi request ID within one attempt, and a retry asks again under a new one. Decide steps call a classifier that keeps no conversation, so asking again repeats nothing. Action steps use a key that stays the same across retries: `http.post` sends it as `Idempotency-Key`, and `events.emit` uses it as the event ID. Receivers must handle duplicate delivery. Callback names, Activity names, deferred names, and storage keys are persisted contracts: changing them can make a waiting run repeat work.

## The hub's assistant works through MCP

```diagram
┌─────────────────────────────────────────────────────────────────────────┐
│ Browser · Studio page + hub shell (rail, assistant drawer)              │
│ New automation · Ask the assistant: hub:open { prompt }                 │
└─────────────┬──────────────────────────────────────────┬────────────────┘
              │ /api/*                                   │ /_hub/api/*, email only when
              ▼                                          ▼ Access's JWT vouches for it
┌───────────────────────────┐              ┌──────────────────────────────┐
│ Api Worker · routes       │◀──── mcp ────│ agents · platform assistant  │
│ mcp(body, headers) RPC    │  (binding)   │ app_tools · call_app_tool    │
│ acts for the person named │              │ approval card before every   │
│ in the email header       │              │ call without readOnlyHint    │
└─────────────┬─────────────┘              └──────────────────────────────┘
              │ StudioTools: one stateless MCP server, also at /api/mcp
              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ reads:   list_automations · get_automation · get_run · list_entity_types│
│          list_entities · get_entity · list_templates · preview_change   │
│          list_pending_changes                                           │
│ changes: put/delete entity, type, template → Changes.prepare + decide   │
│          decide_change (a proposal waiting from elsewhere)              │
│ design:  create_automation · draft_automation → Automations.chat/answer │
└─────────────────────────────────────────────────────────────────────────┘
```

automations has one assistant: the platform's, in the hub shell's drawer, served by the agents project. It reaches the studio only through [the studio's MCP server](src/http/mcp-server.ts), which `Api` serves to agents' Worker as the `mcp(body, headers)` RPC method. A call acts for the person `cf-access-authenticated-user-email` names; with no person, every tool that changes something refuses.

Every tool that isn't marked read-only changes something when it's called, and agents asks the person in an approval card before each such call, so the card is the person's one decision per change. A change tool prepares the change through the coordinator and decides it at once, keeping every check below; a write refused or found stale at apply is cancelled rather than left pending. `preview_change` shows the details and consequences first and stores nothing, and `list_pending_changes` finds proposals waiting from elsewhere for `decide_change`. The design tools hand the person's words to the automation's planner (`create_automation` through [creation](src/automation/creation.ts), `draft_automation` through `Automations.chat`, or `answer` while the planner asks) and wait up to about 25 seconds for its reply. No tool saves, starts, or answers a run's task: the person does that in the studio.

The studio had its own agent before, a `StudioAssistant` Durable Object per person and thread with a panel on every page. The hub's assistant replaced it: its class was deleted with its conversations, and its thread directory dropped.

## entity-store is the system of record for entities

Entity types and entities live in entity-store, a separate Alchemy stack with its own D1, schema versions and lenses. automations reaches it over a service binding to its API Worker, whose default entrypoint serves RPC methods and isn't routed publicly: having the binding is the authorization. [`EntityStoreApi`](src/entities/entity-store-api.ts) decodes each call's `Result`, and [`EntityStore`](src/entities/store.ts) keeps its role for the rest of the code, adding automations' rules: snake_case names and the dependencies that keep a type from being deleted. Templates and trigger subscriptions stay in automations' D1. automations defines no entity type of its own, and its old `entity_types`, `entities` and `roles` tables are dropped.

[The type adapter](src/entities/entity-store-types.ts) reads an entity-store type at its latest version as automations' `EntityType`: `string` is text (or a date or datetime by its format), `enum` is text, `link` is a ref, and `nullable` is what it holds. `array`, `object` and `json` fields, and names that aren't snake_case, are left out, so checks, paths and entity data never see them, and writes leave them alone. Saving a type from automations creates it, or adds a version whose lens adds and removes fields; a field whose kind changes is refused, because only entity-store can author the lens that converts it.

entity-store records a change row with every write, in the same batch, and delivers it at least once, in no particular order, to its change queue. [The Api consumes it](src/entities/change-feed.ts): for each message it reads the change, publishes `entity.created`, `entity.updated` or `entity.deleted` as `entity-store:<seq>`, and notifies the automations watching the type under the same key. Keys use the change's `seq` rather than the entity and revision: deleting a type purges its deleted entities, so an ID can come back at revision 1. A message whose change is gone, or whose data can't be presented at its type's latest version (`ProjectionFailed`), is dropped with a warning rather than retried. Every entity write therefore starts automations, whoever made it: the studio, MCP (the hub's assistant included), a workflow's `entity.put`, or entity-store's own UI and API. Writes made by automations carry `meta` `{ depth, sourceEventId?, changeId? }`, which entity-store stores without reading, so an event chain keeps its depth across the boundary. Under `alchemy dev`, where a reference can't reach another checkout's stack, [a Durable Object](src/platform/cloudflare/entity-store-dev.ts) stands in for entity-store behind the same RPC methods and feeds a local change queue.

## Every data change goes through one coordinator

Manual forms, MCP tools, and `entity.put` events all use the tenant's single [`ChangeCoordinator`](src/changes/application.ts). It serializes `prepare` and `decide`, and stores proposals under `proposal:<id>`.

```diagram
  prepare(owner, action, requestId?)                prepare(..., sourceEvent)
  manual UI · MCP                                   applyEvent for entity.put
           │                                                   │
           ▼                                                   │
┌────────────────────────────┐                                 │
│ same owner + requestId?    │                                 │
│ return that proposal       │                                 │
│ else check the action and  │                                 │
│ read what it touches: the  │                                 │
│ entity and its revision,   │                                 │
│ type or template           │                                 │
└─────────────┬──────────────┘                                 │
              ▼                                                ▼
┌────────────────────────────┐  approve, what it   ┌────────────────────────────┐
│ pending                    │  read is unchanged  │ applying                   │
│                            │────────────────────▶│ intent persisted           │
└──┬────────┬────────────────┘                     └─────────────┬──────────────┘
   │        │ changed since          ▲ write refused             │ settle
   │        ▼                        │ (person's)                ▼
   │ ┌────────────────────────────┐  │             ┌────────────────────────────┐
   │ │ error: stale               │  └─────────────│ landed already? the change │
   │ │ stays pending              │                │   at its revision has this │
   │ └────────────────────────────┘                │   changeId: done           │
   │ decline                                       │ else write with expectedRev│
   │                                               │   and meta                 │
   │                                               └─────────────┬──────────────┘
   ▼                                                             ▼
┌────────────────────────────┐                     ┌────────────────────────────┐
│ terminal: cancelled        │                     │ terminal: applied          │
└────────────────────────────┘                     └────────────────────────────┘
```

Preparation checks the action as its write will (an entity write through entity-store's own `checkEntity` dry run, and a delete against its backlinks, since it refuses to delete what others link to), and reads only what it touches: for an entity, its data, revision, type and watchers; for a type, the type; for a template, the template and each automation's template uses. Approval checks that these are unchanged. An entity write then goes to entity-store as `upsertEntity` or `deleteEntity` with the reviewed revision as `expectedRev` (0 for a new entity), so a write that loses a race to another writer fails there instead of overwriting.

entity-store and proposal storage cannot share a transaction. Every write carries the proposal's ID in `meta.changeId`. Recovery reads the change at the revision the write makes, and, when entity-store refuses the write because the entity moved on, at the `currentRev` it reports (a write revived from a tombstone takes the next revision, which only entity-store knows for sure) and, for a delete, at the revision that deleted the entity, since a deleted entity reports 0. If either change carries this proposal's ID the write landed, otherwise it didn't. Recovery is lazy: the next `prepare` or approval settles any proposal left applying. A person's approved change that can no longer apply, or that entity-store or the checks refuse when it applies (of any kind: entity, type or template), goes back to pending with the reason and writes nothing; it holds no other change back. If an earlier write's change can't be read (`ProjectionFailed`), recovery can't tell whether it landed, so it fails closed: nothing is written again. An authorized `entity.put` command is checked again against the newer data, since nobody reviewed a particular version; one entity-store refuses, such as a link to a missing entity, is settled as cancelled with the reason, and the event fails into the dead letters.

Confirmed writes no longer publish anything or start runs themselves; their receipt is `{ entity }` or `{ deleted }`. Lifecycle events and entity triggers follow from entity-store's change queue, keyed by the change's `seq` in entity-store's log, which is never reused, so a redelivered message, or a write recovered after a restart, starts nothing twice. Proposals stored before entity-store keep their receipts; one without a receipt must be prepared again.

[The studio's MCP server](src/http/mcp-server.ts) has one approval per change: its tools without `readOnlyHint` change something when called, so the client's approval of that call (the hub assistant's approval card) is the person's decision. Its change tools ([`entity-mcp.ts`](src/http/entity-mcp.ts)) prepare through the coordinator and decide at once, so they keep every check above; a write refused or found stale is cancelled rather than left pending. `preview_change` describes a change as preparing it would and stores nothing, and `decide_change` decides a proposal waiting from elsewhere. A client that passes a `requestId` can retry a change tool and get the first outcome.

## Events flow through one queue

```diagram
┌──────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────────────┐
│ events.emit  │ │ POST          │ │ entity-store  │ │ Channels Worker       │
│ action step  │ │ /api/events   │ │ change queue  │ │ verify signature      │
│ action:<key> │ │ caller's ID   │ │ entity.*      │ │ ChannelMailbox DO     │
│ depth + 1    │ │ depth 0       │ │ entity:<id>:  │ │ per thread, in order  │
│              │ │               │ │ <rev>, meta   │ │                       │
│              │ │               │ │ .depth        │ │                       │
└──────┬───────┘ └───────┬───────┘ └───────┬───────┘ └───────────┬───────────┘
       │                 │                 │                     │ slack.mention
       │                 │                 │                     │ .message
       ▼                 ▼                 ▼                     ▼ .reaction
┌─────────────────────────────────────────────────────────────────────────────┐
│ Events queue · retried, then FailedEvents (dead letters)                    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Api Worker · deliverEvent                                                   │
└───────────────┬─────────────────────────────────────────────┬───────────────┘
                │ entity.put first                            │ then every event
                ▼                                             ▼
┌──────────────────────────────────┐          ┌──────────────────────────────────┐
│ ChangeCoordinator.applyEvent     │          │ each automation in the directory │
│ prepare as applying, approve     │          │ eventReceived                    │
│ writes to entity-store at depth  │          │ receipt event:<id>               │
│ + 1, whose change comes back     │          │ run ID event-<id>                │
└──────────────────────────────────┘          └──────────────────────────────────┘
```

Named events are an application capability in [`src/events/`](src/events/delivery.ts), hosted by a Cloudflare Queue. The private Api Worker consumes the queue. It applies `entity.put` through the tenant change coordinator, then fans every event out through `Automations.eventReceived`. Any failure retries the whole message, which receipts make safe. The Api also consumes entity-store's change queue, with the same retries and dead letters, and publishes each change's lifecycle event to this one.

Every source picks an event ID that is stable across its own retries, so redeliveries reach each automation's receipts and start nothing twice. `events.emit` is a normal permission-controlled action. Authorized `entity.put` commands persist their applying intent during preparation, so a restart before application cannot make the command stale. Event depth follows commands, lifecycle facts and entity-triggered runs, and stops publication at 16 hops. A command's write carries its depth + 1 in entity-store's `meta`; the change consumer publishes the lifecycle fact at that depth and gives runs it starts the fact as their origin, so the count survives the round trip. A write made outside automations starts a chain at 0. `events.emit` fails a step that would go past the limit, including an `entity.put` at depth 16, whose lifecycle fact could not be published. Delivery drops a command that can never apply, with a warning, rather than retrying it into the dead-letter queue. See [events and entity commands](docs/workflow-dsl.md#publishing-events-and-entity-commands) for authorization and delivery semantics.

Each Slack thread gets a `ChannelMailbox` Durable Object that stores its events and runs them in order from its alarm, with retries. [Its callbacks](src/channels/slack.ts) only publish `slack.mention`, `slack.message`, and `slack.reaction` under IDs taken from Slack's. A mention also subscribes the mailbox to its thread. The mailbox never touches automations directly. Outgoing Slack messages are a separate path: the `slack.sendMessage` action posts through `SlackSender` when `SLACK_BOT_TOKEN` is set ([setup](docs/slack.md)). With the same sender, [opening a task](src/automation/task-notifications.ts) DMs a human step's assignee, linking to the run at the studio origin that `STUDIO_URL` sets or the latest save recorded.

### Approvals from Slack go through respond

An ask-first action's DM, sent before roles were removed, has **Approve** and **Reject** buttons; new tasks name no one to DM, but those buttons still work. [The interactivity route](src/channels/slack-interactivity.ts) on `Channels` checks Slack's signature over the exact body, puts the click on the `SlackActions` queue, and answers within Slack's 3 seconds. `Channels` can't reach the Automation objects, and the `Api` stays private, so the queue is the hand-off. The `Api` consumes it with [`decideFromSlack`](src/channels/slack-approvals.ts), which looks up the clicker's email address in Slack and calls `Automation.respond` with it, just as HTTP passes the Access email. A click is never answered without an email address, so every decision records who made it.

`respond` takes one answer at a time per automation and records the first as the task's `decision`. Every later click, of either button and by anyone, finds the task closed and redraws the message from that decision, so a redelivered or retried click repeats nothing. While the task is open, a refused click (no email address, or a task that isn't an approval) gets an ephemeral reply and changes nothing. The button's action IDs and its value, the task's automation, run and step, are persisted in sent messages.

## Catalogs and adapters keep validation consistent

- [`src/workflow/model.ts`](src/workflow/model.ts) defines the pure workflow DSL, references, and conditions. [`catalog.ts`](src/workflow/catalog.ts) checks entity references, path ordering, operation inputs, template slots, and permissions.
- [`src/entities/`](src/entities/store.ts) owns entity models, approved templates, subscriptions, the entity-store contract and type adapter, and automations' rules on top. The memory store runs the same store code over [an in-memory entity-store](src/entities/entity-store-fake.ts).
- [`src/connections/registry.ts`](src/connections/registry.ts) describes operations without executing them. The planner, checker, and UI share it. [`runner.ts`](src/connections/runner.ts) executes those operations; [`slack.ts`](src/connections/slack.ts) posts to Slack with a bot token, and [`email.ts`](src/connections/email.ts) is the email sender's contract, which [the Cloudflare adapter](src/platform/cloudflare/email.ts) fills with Email Service.
- [`src/ai/pi.ts`](src/ai/pi.ts) defines the `PiAgent` conversation contract and tools; [`trace.ts`](src/ai/trace.ts) defines traces. The Cloudflare implementation wraps Promise-based pi-ai and pi-durable in Effect and stores conversations in Durable Object SQLite. [`src/ai/classifier.ts`](src/ai/classifier.ts) defines the clef classifier that picks progress phrases and makes decide steps' decisions. [`workers-ai.ts`](src/platform/cloudflare/workers-ai.ts) selects the pi, classifier and naming models; evals reuse it.
- [`src/http/mcp-server.ts`](src/http/mcp-server.ts) exposes the studio over stateless MCP JSON-RPC: the catalog's tools ([`entity-mcp.ts`](src/http/entity-mcp.ts)) and the automations' ([`automation-mcp.ts`](src/http/automation-mcp.ts)), which read automations and runs and delegate design to the planner through `Automations.chat`. `/api/mcp` serves it over HTTP, and `Api`'s `mcp(body, headers)` RPC method serves it to the hub's assistant in the agents stack, acting for the person its `cf-access-authenticated-user-email` header names. Handlers run within the request or RPC call so they retain access to D1 and entity-store.

| Use                                 | Model                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Planner, agent steps                | `claude-sonnet-5-5` at medium thinking, through AI Gateway `default` (BYOK) |
| Progress phrases                    | `@cf/cloudflare/clef-flash`                                                 |
| Decide steps, by the step's `model` | `@cf/cloudflare/clef-flash` or `@cf/cloudflare/clef`                        |
| Naming automations                  | `@cf/meta/llama-3.1-8b-instruct-fp8`                                        |

## Browser state and server state have separate lifecycles

[The Foldkit UI](src/ui/AGENTS.md) follows Elm-style Model → Message → Update → View, with side effects in Commands. The root owns the studio, run page, and run panel; overview, templates, entities, and traces are page Submodels. The change-confirmation dialog belongs to the templates and entities pages.

Routes preserve the open automation and run in the URL. Page changes increment a revision so old requests and polls cannot overwrite the new page; the open run and the overview keep their own counters. Polling is driven by Commands and stops when there is nothing in flight.

The hub's assistant lives in the shell's drawer, outside the app. The studio opens it with a prompt (`hub:open`) and learns of its work by watching: an idle studio page reloads the open automation every few seconds in its own chain, and follows the planner as soon as a message reaches it.

The draft marks what the latest reply changed that isn't saved yet: it compares the reply's recorded changes with the saved version, so saving clears the marks and a reload keeps them. Steps the reply added or changed get a box and a badge, old values are struck through, the rest is dimmed, and one line names removed steps and other changes.

Agent replies render Markdown tokens without setting raw HTML. Run results render as labelled fields, not raw JSON. The operation registry marks Email, Slack, and Calendar as simulated. A deployment with `EMAIL_FROM` connects Email, and one with `SLACK_BOT_TOKEN` connects Slack; `GET /api/connections` lists what is connected, so the UI tags an operation "Simulated" only when it is, and a run's result says so from its own `simulated: true` record.

## Guarantees have deliberate limits

- Anyone who can reach the studio may answer an approval task; the answer records the Access email, or the Slack email of whoever clicked in a DM. The private API trusts the Studio's identity header; local dev requests carry `DEV_USER_EMAIL` when it is set, and otherwise, like service-token requests, carry no email and share the `local` owner. JWT verification and the rest of the security boundary need production review.
- `http.post` accepts only literal public HTTPS URLs without credentials. Both the catalog and connection runner enforce the URL boundary. It does not forward trace headers. Workflows must not contain secrets.
- Steps that are declined or skipped record nothing. Dependent steps are skipped; catalog checks guarantee that referenced steps precede their readers on every path.
- automations' entity rules (snake_case names, the dependencies that block deleting a type) hold for writes made through automations. A write made in entity-store directly passes only entity-store's own checks, though it still reaches automations through the change queue.
- entity-store delivers changes at least once and in no set order. A trigger compares the change's own before and after, and run IDs come from the change's `seq`, so neither duplicates nor reordering start extra runs; a trigger's condition that reads through a ref sees the referenced entity as it is at delivery.
- Calendar and `notify: "email"` send nothing in the prototype. Email sends through Cloudflare Email Service only when `EMAIL_FROM` is set ([setup](docs/email.md)), and Slack posts, including task DMs, only when `SLACK_BOT_TOKEN` is set. Neither takes an idempotency key, so a retried step can send twice. A task DM records each recipient before and after posting, and looks for its own key in the DM before posting again. HTTP requests are real.

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
