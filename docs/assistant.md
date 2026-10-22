# Studio assistant

The studio assistant, shown as the studio agent, is a page-aware chat that reads the catalog, proposes entity, type and template changes, asks the person questions, and hands workflow design to an automation's planner. It is the only way the studio designs automations: **New automation** opens a fresh thread, and the studio page shows the draft with no chat of its own. It never saves, activates or runs a workflow, and nothing it proposes is written until the person confirms it inline. Each person keeps a history of threads they can reopen, archive, clear, or stop. [Architecture](../ARCHITECTURE.md) places it in the whole system; this page follows one conversation through the code.

## One Durable Object holds each thread

```diagram
                        ┌───────────────────────────────────────┐
                        │ Browser · src/ui/assistant/           │
                        │ open thread's UUID in localStorage    │
                        │ studio-assistant-session              │
                        └───────────────────┬───────────────────┘
                                            │ HTTPS /api/assistant/:sessionId
                                            │ Cloudflare Access in deployed stages
                                            ▼
                        ┌───────────────────────────────────────┐
                        │ Studio Worker · edge.ts               │
                        │ forwards /api/* to env.API            │
                        └───────────────────┬───────────────────┘
                                            │ service binding
                                            ▼
                        ┌───────────────────────────────────────┐
                        │ Api Worker · private                  │
                        │ assistantRoutes · RequestIdentity     │
                        │ owner = Access email ?? "local"       │
                        └───────────────────┬───────────────────┘
                                            │ Assistants.get(owner, sessionId)
                                            │ getByName(JSON.stringify([owner, sessionId]))
                                            ▼
                        ┌───────────────────────────────────────┐
                        │ StudioAssistant · Durable Object      │
                        │ identity   owner + sessionId          │
                        │ assistant  state, owner, turnId       │
                        │ tool:<id>  one receipt per tool call  │
                        │ pi_*       pi-durable conversation    │
                        │ callback   assistantReply { turnId }  │
                        └───────────────────┬───────────────────┘
                                            │
          ┌──────────────────────┬──────────┴───────────┬──────────────────────┐
          ▼                      ▼                      ▼                      ▼
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│ Workers AI        │  │ D1 · entity-store │  │ AutomationAgent   │  │ ChangeCoordinator │
│ PLANNER_MODEL     │  │ EntityStoreLive   │  │ per automation    │  │ one per tenant    │
│ NAMING_MODEL      │  │ AutomationIndexD1 │  │ planner + draft   │  │ name "studio"     │
│                   │  │ AssistantThreadsD1│  │                   │  │                   │
└───────────────────┘  └───────────────────┘  └───────────────────┘  └───────────────────┘
```

A thread is a session: the browser keeps the open thread's UUID v4 under `studio-assistant-session` in `localStorage` ([`command.ts`](../src/ui/assistant/command.ts)) and addresses `/api/assistant/:sessionId`. A new thread is a new UUID, and opening a past one stores its UUID. [The routes](../src/http/assistant.ts) check that the session ID is a UUID v4, the same check the object makes, so a session it would refuse gets a 404 at the route; they take the owner from `RequestIdentity`, which [`access.ts`](../src/platform/cloudflare/access.ts) reads from `cf-access-authenticated-user-email`. Under `alchemy dev` it falls back to `DEV_USER_EMAIL` when that is set. Other local dev requests and service-token requests have no email and share the owner `local`.

| Route                                         | Body                       | Operation               |
| --------------------------------------------- | -------------------------- | ----------------------- |
| `GET /api/assistant`                          |                            | `AssistantThreads.list` |
| `GET /api/assistant/:sessionId`               |                            | `inspect`               |
| `POST /api/assistant/:sessionId/chat`         | `{ message, context }`     | `chat`                  |
| `POST /api/assistant/:sessionId/confirmation` | `{ proposalId, approved }` | `confirm`               |
| `POST /api/assistant/:sessionId/answers`      | `{ callId, answer }`       | `answer`                |
| `POST /api/assistant/:sessionId/stop`         |                            | `stop`                  |
| `POST /api/assistant/:sessionId/clear`        |                            | `clear`                 |
| `POST /api/assistant/:sessionId/archive`      | `{ archived }`             | `archiveThread`         |
| `DELETE /api/assistant/:sessionId`            |                            | `deleteThread`          |

`GET /api/assistant`, `archive` and `DELETE` return `{ threads }`, the owner's threads with archived ones included, most recently used first. The other routes return the session's `AssistantState` ([`model.ts`](../src/assistant/model.ts)). [`assistantsLayer`](../src/platform/cloudflare/assistant.ts) names the object `JSON.stringify([owner, sessionId])`. The object accepts only a UUID v4. The first call stores that pair under `identity`; a call with another pair fails with `Session identity mismatch`, and [`makeAssistantSession`](../src/assistant/session.ts) checks the pair again against the stored `assistant` record.

The object's outer Effect binds Workers AI, the `Automation` and `ChangeCoordinator` namespaces, and the D1 adapters, the thread directory's among them. Its instance builds the session and opens pi once (`Effect.cached`), installing the session's tools before pi resumes, so a turn interrupted mid-call keeps them. [pi-durable](../src/platform/cloudflare/pi.ts) keeps the conversation in `pi_*` tables of the same SQLite database ([`pi-storage.ts`](../src/platform/cloudflare/pi-storage.ts)) and calls `PLANNER_MODEL` from [`workers-ai.ts`](../src/platform/cloudflare/workers-ai.ts). No route reads the assistant's transcript; the traces page shows automation traces only.

## Accepting a message and scheduling its reply commit together

```diagram
┌───────────────────────────────────┐
│ POST /:sessionId/chat             │
│ { message, context }              │
└─────────────────┬─────────────────┘
                  │
                  ▼
┌───────────────────────────────────┐
│ Assistant.chat · one transaction  │
│ requires status idle or failed    │
│ new turnId · status working       │
│ append the exchange               │
│ jobs.reply(turnId)                │
└─────────────────┬─────────────────┘
                  │ assistantReply callback · at least once
                  ▼
┌───────────────────────────────────┐
│ Assistant.reply(pi, turnId)       │
│ return if the turn is over        │
│ settle decided changes and        │
│ submitted drafts first            │
└─────────────────┬─────────────────┘
                  │
                  ▼
┌───────────────────────────────────┐        ┌───────────────────────────────────┐
│ pi.instruct(instructions)         │ call   │ typed tool call                   │
│ pi.prompt                         │───────▶│ decode arguments with Schema      │
│   requestId assistant:<turnId>    │◀───────│ start: receipt tool:<callId>      │
│ raced with hub.watchParked        │ result │ one unfinished tool per turn      │
└─────────────────┬─────────────────┘        └─────────────────┬─────────────────┘
                  │ answer or failure                          │ waits on the person or planner
                  ▼                                            ▼
┌───────────────────────────────────┐        ┌───────────────────────────────────┐
│ one transaction                   │        │ confirming, asking, or working    │
│ answer → reply · status idle      │        │ hub.parked(turnId)                │
│ failure → error · status failed   │        │ the race returns "parked"         │
│ fail unfinished receipts          │        │ the callback ends                 │
└───────────────────────────────────┘        └───────────────────────────────────┘
```

`Assistant.chat` accepts a message that isn't blank and is at most 10,000 characters, and refuses a message unless the status is `idle` or `failed`. It writes the turn and calls `jobs.reply(turnId)` in one storage transaction. [`AssistantHost`](../src/assistant/host.ts) requires that transaction to roll back storage and scheduling together; the Durable Object schedules the `assistantReply` callback.

The callback is delivered at least once. `reply` returns at once when `turnId` is no longer the current turn or the turn is `idle` or `failed`. It prompts pi with the request ID `assistant:<turnId>`, so a redelivery waits for the original submission instead of starting another. The prompt labels the page context as an untrusted selection hint.

The prompt races `hub.watchParked(turnId)`. A tool that waits parks the turn and the callback returns without holding the object open: `propose_change` and `ask_question` wait for the person and set `confirming` or `asking`, while `draft_automation` waits for the planner and stays `working`. When pi answers, one transaction stores the reply and returns to `idle`; a failure stores the error, fails the turn's unfinished receipts and sets `failed`.

The browser polls `GET /api/assistant/:sessionId` every second while the status is `working` and stops at any other status ([`update.ts`](../src/ui/assistant/update.ts)). Each request carries its own sequence number; a response for an older sequence or another session is dropped. This sequencing is separate from the page `revision`.

## Tools reach the studio only through application services

```diagram
                             ┌─────────────────────────────┐
                             │ pi root conversation        │
                             │ sequential · replay: safe   │
                             └──────────────┬──────────────┘
          ┌──────────────────────┬──────────┴───────────┬──────────────────────┐
          ▼                      ▼                      ▼                      ▼
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│ read_studio       │  │ propose_change    │  │ draft_automation  │  │ ask_question      │
│ no receipt        │  │ receipt: change   │  │ receipt: draft    │  │ receipt: question │
└─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
          │                      │                      │                      │
          ▼                      ▼                      ▼                      ▼
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│ EntityStore       │  │ Changes.prepare   │  │ AutomationIndex   │  │ state.questions   │
│ AutomationIndex   │  │ ChangeCoordinator │  │ Automations.chat  │  │ inline answers    │
│ Automations       │  │ then park         │  │ then park         │  │ then park         │
│ .inspectWorkflow  │  │                   │  │                   │  │                   │
└───────────────────┘  └───────────────────┘  └───────────────────┘  └───────────────────┘
```

[`session.ts`](../src/assistant/session.ts) defines four `AgentTool`s ([`src/ai/pi.ts`](../src/ai/pi.ts)). [The pi adapter](../src/platform/cloudflare/pi.ts) offers them to the root conversation only, with `replay: "safe"` and `executionMode: "sequential"`. Each tool decodes its arguments with Schema; a decode failure reaches the model as an `AgentToolError` result before any receipt exists. A later failure in `propose_change` or `draft_automation` also fails the tool's open receipt.

- `read_studio` reads the `catalog` (types, templates, roles, automations), the `entities` of a type, one `entity`, or one `automation`'s workflow. It writes nothing and keeps no receipt. The instructions treat what it returns as untrusted data.
- `propose_change` takes a `ChangeAction` ([`src/changes/model.ts`](../src/changes/model.ts)): put or delete an entity, type or template. Roles have no action.
- `draft_automation` hands design to the planner; see below.
- `ask_question` is the shared [ask-question tool](../src/ai/ask-question/tool.ts): 1–4 questions with 2–4 options each, checked before anything is shown.

The last three call `start` first. [The ledger](../src/assistant/ledger.ts), which owns the `assistant` record and the receipts, stores `tool:<callId>` with the turn ID, or returns the receipt already stored for that call. A turn has at most one unfinished tool. The assistant uses these tools directly, not the entity MCP.

## Questions and confirmations park the turn, not the object

```diagram
┌───────────────────────────────────┐
│ tool stores its proposal or       │
│ questions in tool:<callId>        │
│ park: hub.parked(turnId)          │
└─────────────────┬─────────────────┘
                  │ POST /:sessionId/confirmation or /answers
                  ▼
┌───────────────────────────────────┐
│ one transaction                   │
│ check the call is still current   │
│ record approved or answer         │
│ jobs.reply(turnId)                │
└─────────────────┬─────────────────┘
                  ├────────────────────────────────────────────┐
                  ▼                                            ▼
┌───────────────────────────────────┐        ┌───────────────────────────────────┐
│ same instance:                    │        │ after a restart:                  │
│ hub.deliver(callId) wakes         │        │ pi replays the call with its      │
│ the waiting tool                  │        │ ID and the tool reads tool:<id>   │
└─────────────────┬─────────────────┘        └─────────────────┬─────────────────┘
                  │                                            │
                  ▼                                            │
┌───────────────────────────────────┐                          │
│ tool returns the stored result    │◀─────────────────────────┘
│ to the model and the turn goes on │
└───────────────────────────────────┘
```

A parking tool stores what it waits for in its receipt and in `AssistantState` (`confirmation` or `questions`), then calls `hub.parked`. pi keeps the call unfinished in its own tables. [`AnswerHub`](../src/ai/ask-question/answer-hub.ts) lives only in memory; a tool opens its answer slot before reading the receipt, so an answer that lands in between is not missed.

`confirm` and `answer` reject a call that is no longer current (`Stale confirmation`, `Stale proposal`, `Stale questions`, `Stale question call`). `answer` checks the answers with `answerProblem`. Each records the decision or answer and calls `jobs.reply` in one transaction. A second, different decision for the same proposal fails with `Decision already recorded`.

After a restart, pi replays the unfinished call with the same ID and the tool returns the result stored in `tool:<callId>` instead of acting again. Free text is never approval: `chat` is refused while a turn is `confirming` or `asking`, so only the confirmation route decides a proposal. Answers to planner questions are not delivered through the hub; the next reply forwards them (see below).

Receipts live in the object's storage, not in pi-durable, even though pi already stores each tool call's intent and replays it. pi only runs while something has it open, and nothing wakes it from outside: the `assistantReply` callback reopens it. So a decision or answer must commit in the same transaction as the reply job that acts on it, and pi commits through its own SQLite transaction, which can't take the job. A receipt is also what the confirmation and answer routes and the UI read, and what tells a replayed `draft_automation` which planner it already started. pi's durability covers the conversation; the receipts cover what the world outside pi has said to a waiting call. The planner keeps its questions and answers in `plan` for the same reason.

## Proposed changes go through the tenant's ChangeCoordinator

```diagram
┌───────────────────────────────────────────┐
│ assistant propose_change                  │
│ manual /api/changes and MCP use it too    │
└─────────────────────┬─────────────────────┘
                      │ Changes.prepare(owner, action, requestId)
                      ▼
┌───────────────────────────────────────────┐
│ ChangeCoordinator.prepare · one at a time │
│ same owner + requestId → same proposal    │
│ recover applying records                  │
│ snapshot the catalog: before              │
│ apply to a memory store of before         │
│ details + consequences                    │
│ proposal:change-N · pending               │
└─────────────────────┬─────────────────────┘
                      │ ChangeProposal → state.confirmation
                      ▼
┌───────────────────────────────────────────┐
│ person confirms or cancels inline         │
│ POST /:sessionId/confirmation             │
│ receipt.approved + jobs.reply             │
└─────────────────────┬─────────────────────┘
                      │ Changes.decide(owner, proposalId, approved)
                      ▼
┌───────────────────────────────────────────┐
│ ChangeCoordinator.decide · one at a time  │
│ owner must match                          │
│ stored receipt → return it                │
│ applying → resume recovery                │
│ cancel → terminal · cancelled             │
│ what it read changed → stale ChangeError  │
│ otherwise write applying                  │
└─────────────────────┬─────────────────────┘
                      │
                      ▼
┌───────────────────────────────────────────┐
│ settle                                    │
│ landed already? (changeId at its rev)     │
│ else write entity-store with expectedRev  │
│   and meta { depth, changeId }            │
│ terminal receipt · applied                │
│ entity.* and triggers follow from         │
│   entity-store's change queue             │
└─────────────────────┬─────────────────────┘
                      │ ChangeDecision
                      ▼
┌───────────────────────────────────────────┐
│ assistant receipt stores the decision     │
│ activity completed or cancelled           │
│ status working · hub.deliver              │
└───────────────────────────────────────────┘
```

`propose_change` calls `Changes.prepare(owner, action, "<sessionId>:<callId>")`. [`changesLayer`](../src/platform/cloudflare/changes.ts) routes every call to the one object named `studio`, the same one manual forms reach through [`/api/changes`](../src/http/changes.ts). A replayed call finds its proposal by owner and request ID; a different action under the same ID fails.

[Preparation](../src/changes/application.ts) checks the action as its write will and reads only what it touches: an entity's data, revision, type and watchers; a type; or a template and each automation's template uses. It stores `proposal:<id>` with what it read, the result it expects, the details and the consequences. It writes nothing to entity-store or D1, though preparation first settles any earlier `applying` record. The panel shows the proposal with the same [`changeProposalView`](../src/ui/components/change-proposal.ts) as the manual change dialog.

`confirm` persists `approved` and schedules a reply before calling `Changes.decide`. If that call fails, the reply finds an approved receipt without a result and calls `decide` again; `decide` returns a stored receipt rather than applying twice.

Approval reads the same things again, and fails as stale if any changed. The coordinator writes `applying` before touching entity-store, then writes the entity conditioned on the reviewed revision, with the proposal's ID in `meta`, and stores the terminal receipt. A later call resumes an `applying` record: it looks for the change at the revision the write makes, and if it carries the proposal's ID the write landed. A write entity-store refuses because the entity moved on puts a person's proposal back to pending, unwritten. The coordinator publishes nothing and starts no runs: `entity.created`, `entity.updated` or `entity.deleted`, and entity triggers, follow from entity-store's change queue. Cancelling stores a terminal `cancelled` receipt; the instructions forbid the assistant to retry it.

## Design is delegated to the automation's planner

```diagram
┌───────────────────────────────────────────┐
│ draft_automation                          │
│ { name, description, automationId? }      │
└─────────────────────┬─────────────────────┘
                      │
                      ▼
┌───────────────────────────────────────────┐
│ one transaction                           │
│ automationId = given ?? <name>-<8 hex>    │
│ activity working · jobs.reply in 1 s      │
└─────────────────────┬─────────────────────┘
                      │
                      ▼
┌───────────────────────────────────────────┐        ┌─────────────────────────────────┐
│ new id → AutomationIndex.recordIfMissing  │        │ AutomationAgent                 │
│ Automations.get(id).chat(id, description, │───────▶│ pendingChat + planReply         │
│   requestId sessionId:callId)             │        │ planner edits its working copy  │
│ receipt.submitted · jobs.reply in 1 s     │        │ assembles and validates a draft │
│ park                                      │        │                                 │
└─────────────────────┬─────────────────────┘        └─────────────────────────────────┘
                      │ reply callback
                      ▼
┌───────────────────────────────────────────┐
│ Assistant.reply                           │
│ client.inspectWorkflow().pendingChat      │
└─────────────────────┬─────────────────────┘
                      │
          ┌───────────┴──────────┬──────────────────────┬──────────────────────┐
          ▼                      ▼                      ▼                      ▼
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│ working           │  │ asking            │  │ another chat id   │  │ cleared or failed │
│ reply again, 1 s  │  │ mirror questions  │  │ receipt failed:   │  │ completed + draft │
│                   │  │ under plannerCall │  │ turn was replaced │  │ or failed         │
│                   │  │ status asking     │  │                   │  │                   │
└───────────────────┘  └───────────────────┘  └───────────────────┘  └───────────────────┘
```

`draft_automation` takes a name, the person's description, and optionally an existing `automationId`. The instructions tell the assistant to pass the open automation's ID from the selection hint when the person asks to change "this" automation, and to omit it only for a new one. A new draft gets a readable ID from its name with a random suffix (`welcome-employees-3f9a1c2e`) and a directory entry through `AutomationIndex.recordIfMissing`. The ID is stored in the receipt before any call leaves the object, so a replay reuses it.

It submits the description with `Automations.get(id).chat(id, description, "<sessionId>:<callId>")`. [The design session](../src/automation/design-session.ts) uses that request ID as the pending chat's ID, so resubmitting returns the same pending chat. The planner then works in the automation's own Durable Object, as [Conversation produces a draft, not a running program](../ARCHITECTURE.md#conversation-produces-a-draft-not-a-running-program) describes.

The assistant follows the planner by polling: while `pendingChat` is `working`, each reply schedules the next one a second later. When the planner asks, the assistant mirrors its questions under a `plannerCall` ID and a signature of the questions. The person's answer is stored on the draft receipt, and the next reply forwards it with `client.answer` only if the planner still asks the same questions.

When `pendingChat` clears or reports `failed`, the receipt completes with the draft and the planner's reply (`plannerReply`), which the assistant relays, or fails if the planner failed or left neither a draft nor a reply. A planner that replied without drafting, such as with questions written in its reply, completes the receipt with no draft; the assistant relays the reply and sends the person's answer to the same automation. A pending chat with another ID means the planner turn was replaced, and the receipt fails. The activity links to `/?automation=<id>`; saving the draft is left to the person. The studio page has no chat of its own: while the planner works it shows the planner's progress phrase above the draft, and the assistant relays its questions.

## Threads are listed in D1 and named by a fast model

```diagram
┌──────────────────────────────┐   ┌──────────────────────────────┐   ┌──────────────────────────────┐
│ chat                         │   │ first reply                  │   │ GET /api/assistant           │
│ after the turn commits:      │   │ beside the pi prompt:        │   │ POST /:sessionId/archive     │
│ AssistantThreads.touch       │   │ nameThread(first message)    │   │ AssistantThreads.list ·      │
│ list it, move it to the top, │   │ NAMING_MODEL, 5 s, else the  │   │ archive, scoped to the owner │
│ take it out of the archive   │   │ message's opening words      │   │                              │
│ best effort                  │   │ state.title, then rename     │   │                              │
└──────────────────────────────┘   └──────────────────────────────┘   └──────────────────────────────┘
```

Cloudflare can't list Durable Objects, so the `assistant_threads` table ([migration](../migrations/0005_assistant_threads.sql), [`threads.ts`](../src/assistant/threads.ts), [D1 adapter](../src/platform/cloudflare/assistant-threads-d1.ts)) records each owner's threads: ID, title, when they were created and last used, and whether they're archived. It only feeds the history view, so a failure to write it fails no turn, as with the automation directory. The thread's own object stays the authority for its conversation and its title, `AssistantState.title`.

`chat` touches the thread after its transaction commits. `deliverReply` names an untitled thread from its first message alongside the reply, with [`nameThread`](../src/agents/namer/namer.ts): the same fast model and cleanup as automation names, asked for the conversation's subject rather than its request. It never fails the reply; a slow or failed answer falls back to the message's opening words. The title is stored only if the thread is still untitled and still starts with that message, then copied to the directory.

Archiving only sets a flag, so an archived thread still opens and answers; sending it a message takes it out of the archive. The panel moves on to a new thread when the person archives the open one.

Deleting, which only the API and `mise run demo:reset` offer, clears the thread as **Clear thread** does and then removes its row. It clears first, so a failed erase leaves the thread listed for another try. A later message to the same ID starts the thread over and lists it again.

## Stopping ends the turn before aborting anything

```diagram
┌───────────────────────────────────────────┐
│ POST /:sessionId/stop · Assistant.stop    │
│ turn idle or failed? return the state     │
└─────────────────────┬─────────────────────┘
                      ▼
┌───────────────────────────────────────────┐
│ change receipts with a proposal:          │
│   Changes.decide(approved ?? false)       │
│   a recorded decision stands; a pending   │
│   proposal is cancelled                   │
└─────────────────────┬─────────────────────┘
                      ▼
┌───────────────────────────────────────────┐
│ one transaction                           │
│ every open receipt: cancelled "Stopped"   │
│ status idle · message stopped: true       │
│ clear confirmation and questions          │
└─────────────────────┬─────────────────────┘
                      ▼
┌───────────────────────────────────────────┐        ┌─────────────────────────────────┐
│ submitted drafts: Automations.stopChat    │───────▶│ design session stop(chatId)     │
│ pi.abort · release waiting tools          │        │ pendingChat failed "Stopped"    │
└───────────────────────────────────────────┘        │ drop plan · abort planner's pi  │
                                                     └─────────────────────────────────┘
```

The person can stop a turn that is working or waiting on them. Storage says the turn is over before anything is aborted, so work that finishes late finds an idle turn and writes nothing: `reply` returns for an idle turn, `updateTurn` changes the session only while its turn is in progress, `finish` leaves a receipt that already has a result, and `put` never drops one. A draft tool checks its receipt again before calling the planner, and sends the message and records it as submitted without interruption; if the turn stopped meanwhile, it stops the planner it just started. Either way, `stop` or the tool sees the other's write. A proposal prepared after the turn stopped is not stored.

A change the person already approved or declined is decided before the turn ends, since that decision stands; a proposal still waiting is cancelled through `Changes.decide`. A planner the turn handed design to is stopped with `stopChat("<sessionId>:<callId>")`, which marks its pending chat failed with `Stopped`, drops its working copy, and aborts the planner's pi turn, so the draft stays as it was.

`PiAgent.abort` aborts the root conversation. pi signals the tools it is running, and [the pi adapter](../src/platform/cloudflare/pi.ts) passes that signal to the tool's Effect, so a tool parked on a question is interrupted rather than holding the abort open.

## Clearing erases the thread in place

`POST /:sessionId/clear` stops the turn in progress, untitles the thread in the directory, and erases the object: `deleteAll` takes pi's tables, the receipts and the reply jobs with it, then the instance resets with `Assistant thread cleared`. [The client](../src/platform/cloudflare/assistant.ts) recognizes that reset and returns the empty thread. The thread keeps its ID and its place in the history view, and the next message binds the identity again and names it anew.

## Turn status is a small state machine

```diagram
           chat                                             chat
┌────────┐          ┌───────────────────────────────────┐            ┌────────┐
│        │─────────▶│                                   │◀───────────│        │
│ idle   │          │ working                           │            │ failed │
│        │◀─────────│                                   │───────────▶│        │
└────────┘          └───┬───────────────────────┬───────┘            └────────┘
   model answer, or     │   ▲               ▲   │          model or reply error
   stop from any of the │   │               │   │
   three in progress    │   │               │   │
         propose_change │   │ decided       │   │ ask_question or
               prepared │   │        answer │   │ planner asks
                        ▼   │               │   ▼
                  ┌─────────┴────┐      ┌───┴────────┐
                  │ confirming   │      │ asking     │
                  └──────────────┘      └────────────┘
```

`AssistantState.status` is `idle`, `working`, `confirming`, `asking` or `failed`. Only `idle` and `failed` accept a message; a failed turn keeps its conversation and shows its error. Any error that escapes a reply moves the turn to `failed` from `working`, `confirming` or `asking`, and stopping moves it to `idle` from any of them.

Each receipt has its own lifecycle: started, then holding a proposal, questions or automation ID, then `approved`, `answer` or `submitted`, and finally a `result`. A receipt with a result is never reopened. The panel's activities (`working`, `completed`, `failed`, `cancelled`) mirror the change and draft receipts; a question shows an activity only if it fails.

## Failures stay visible and retries reuse stored work

- Receipts are written before effects that cross services: the automation ID before `Automations.chat`, the decision before `Changes.decide`. A repeated callback or replayed call finds earlier work through `assistant:<turnId>`, `tool:<callId>`, and the `<sessionId>:<callId>` request IDs.
- `deliverReply` catches any typed reply failure for the current turn. It fails the turn's unfinished receipts, sets `failed` with the error, clears the confirmation and questions, and releases tools still waiting in memory with an empty answer. Storage stays the source of truth.
- A stale proposal fails the turn instead of retrying. The person sends a new message and the assistant prepares a fresh proposal against current data.
- Storage errors inside a transaction become `AssistantError`. Scheduling runs inside the same transaction, so a message is never accepted without its reply.
- pi failures, such as `Agent did not answer: <reason>`, fail the turn with that message.

## The browser panel lives outside the page lifecycle

[`src/ui/assistant/`](../src/ui/assistant/update.ts) is a submodel of the root. [`update/assistant.ts`](../src/ui/update/assistant.ts) folds it with the current `pageContext` and whether the page has dirty forms. Its only subscription is dictation into the message box ([`subscriptions.ts`](../src/ui/assistant/subscriptions.ts)); polling is a delayed `RequestAssistant` command.

The header has **New thread**, **Past threads**, **Clear thread** (once the thread has messages, after an inline confirmation), Follow, and Collapse. While a turn is in progress, **Stop** replaces Send. Past threads swaps the chat for the owner's threads, with archived ones behind a toggle; each row opens the thread or archives or restores it. **New automation** in the sidebar and on the overview opens a new thread with "Draft an automation that " in the composer, through `startThread`.

Opening a thread, new or past, starts a new request sequence and drops the previous thread's state, so a late reply for it is ignored. A newly completed activity makes the root reload its resources. With Follow on, the panel navigates to the newest activity link it hasn't seen that passes `trustedHref`, and never while the page is dirty; the first read of a thread marks its earlier activities seen, so opening one never jumps to old work. A failed request shows the error and a "Reconnect assistant" button that reads the session again.
