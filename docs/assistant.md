# Studio assistant

The studio assistant is a page-aware chat that reads the catalog, proposes entity, type and template changes, asks the person questions, and hands workflow design to an automation's planner. It never saves, activates or runs a workflow, and nothing it proposes is written until the person confirms it inline. [Architecture](../ARCHITECTURE.md) places it in the whole system; this page follows one conversation through the code.

## One Durable Object holds each person's browser session

```diagram
                        ┌───────────────────────────────────────┐
                        │ Browser · src/ui/assistant/           │
                        │ session UUID in localStorage          │
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
│ Workers AI        │  │ D1                │  │ AutomationAgent   │  │ ChangeCoordinator │
│ PLANNER_MODEL     │  │ EntityStoreD1     │  │ per automation    │  │ one per tenant    │
│                   │  │ AutomationIndexD1 │  │ planner + draft   │  │ name "studio"     │
└───────────────────┘  └───────────────────┘  └───────────────────┘  └───────────────────┘
```

The browser keeps a UUID v4 under `studio-assistant-session` in `localStorage` ([`command.ts`](../src/ui/assistant/command.ts)) and addresses `/api/assistant/:sessionId`. [The routes](../src/http/assistant.ts) check that the session ID is a UUID v4, the same check the object makes, so a session it would refuse gets a 404 at the route; they take the owner from `RequestIdentity`, which [`access.ts`](../src/platform/cloudflare/access.ts) reads from `cf-access-authenticated-user-email`. Local dev and service-token requests have no email and share the owner `local`.

| Route                                         | Body                       | Session operation |
| --------------------------------------------- | -------------------------- | ----------------- |
| `GET /api/assistant/:sessionId`               |                            | `inspect`         |
| `POST /api/assistant/:sessionId/chat`         | `{ message, context }`     | `chat`            |
| `POST /api/assistant/:sessionId/confirmation` | `{ proposalId, approved }` | `confirm`         |
| `POST /api/assistant/:sessionId/answers`      | `{ callId, answer }`       | `answer`          |

Every route returns the session's `AssistantState` ([`model.ts`](../src/assistant/model.ts)). [`assistantsLayer`](../src/platform/cloudflare/assistant.ts) names the object `JSON.stringify([owner, sessionId])`. The object accepts only a UUID v4. The first call stores that pair under `identity`; a call with another pair fails with `Session identity mismatch`, and [`makeAssistantSession`](../src/assistant/session.ts) checks the pair again against the stored `assistant` record.

The object's outer Effect binds Workers AI, the `Automation` and `ChangeCoordinator` namespaces, and the D1 adapters. Its instance builds the session and opens pi once (`Effect.cached`), installing the session's tools before pi resumes, so a turn interrupted mid-call keeps them. [pi-durable](../src/platform/cloudflare/pi.ts) keeps the conversation in `pi_*` tables of the same SQLite database ([`pi-storage.ts`](../src/platform/cloudflare/pi-storage.ts)) and calls `PLANNER_MODEL` from [`workers-ai.ts`](../src/platform/cloudflare/workers-ai.ts). No route reads the assistant's transcript; the traces page shows automation traces only.

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

The last three call `start` first. It stores `tool:<callId>` with the turn ID, or returns the receipt already stored for that call. A turn has at most one unfinished tool. The assistant uses these tools directly, not the entity MCP.

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
│ snapshot ≠ before → stale ChangeError     │
│ otherwise write applying                  │
└─────────────────────┬─────────────────────┘
                      │
                      ▼
┌───────────────────────────────────────────┐
│ recover                                   │
│ write EntityStore (D1)                    │
│ putEntity → notify subscribers with       │
│   key change:<proposalId>                 │
│ entity writes → publish entity.*          │
│ terminal receipt · applied                │
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

[Preparation](../src/changes/application.ts) snapshots types, entities, templates, roles, subscriptions and each automation's template uses, applies the action with production validation to a memory store built from that snapshot, and stores `proposal:<id>` with both snapshots, the details and the consequences. The dry run writes nothing to D1, though preparation first finishes any earlier `applying` record. The panel shows the proposal with the same [`changeProposalView`](../src/ui/components/change-proposal.ts) as the manual change dialog.

`confirm` persists `approved` and schedules a reply before calling `Changes.decide`. If that call fails, the reply finds an approved receipt without a result and calls `decide` again; `decide` returns a stored receipt rather than applying twice.

Approval compares a fresh snapshot with `before`, so even an unrelated edit makes the proposal stale. The coordinator writes `applying` before touching D1, then writes the entity store, notifies subscribers under `change:<proposalId>` for entity puts, publishes `entity.created`, `entity.updated` or `entity.deleted` for entity writes, and stores the terminal receipt. A later call resumes an `applying` record, or blocks changes when current data matches neither snapshot. Cancelling stores a terminal `cancelled` receipt; the instructions forbid the assistant to retry it.

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
│ automationId = given ?? assistant-<uuid>  │
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

`draft_automation` takes a name, the person's description, and optionally an existing `automationId`. A new draft gets `assistant-<uuid>` and a directory entry through `AutomationIndex.recordIfMissing`. The ID is stored in the receipt before any call leaves the object, so a replay reuses it.

It submits the description with `Automations.get(id).chat(id, description, "<sessionId>:<callId>")`. [The design session](../src/automation/design-session.ts) uses that request ID as the pending chat's ID, so resubmitting returns the same pending chat. The planner then works in the automation's own Durable Object, as [Conversation produces a draft, not a running program](../ARCHITECTURE.md#conversation-produces-a-draft-not-a-running-program) describes.

The assistant follows the planner by polling: while `pendingChat` is `working`, each reply schedules the next one a second later. When the planner asks, the assistant mirrors its questions under a `plannerCall` ID and a signature of the questions. The person's answer is stored on the draft receipt, and the next reply forwards it with `client.answer` only if the planner still asks the same questions.

When `pendingChat` clears or reports `failed`, the receipt completes with the draft, or fails if the planner failed or left no draft. A pending chat with another ID means the planner turn was replaced, and the receipt fails. The activity links to `/?automation=<id>`; saving the draft is left to the person.

## Turn status is a small state machine

```diagram
           chat                                             chat
┌────────┐          ┌───────────────────────────────────┐            ┌────────┐
│        │─────────▶│                                   │◀───────────│        │
│ idle   │          │ working                           │            │ failed │
│        │◀─────────│                                   │───────────▶│        │
└────────┘          └───┬───────────────────────┬───────┘            └────────┘
        model answer    │   ▲               ▲   │          model or reply error
         propose_change │   │ decided       │   │ ask_question or
               prepared │   │        answer │   │ planner asks
                        ▼   │               │   ▼
                  ┌─────────┴────┐      ┌───┴────────┐
                  │ confirming   │      │ asking     │
                  └──────────────┘      └────────────┘
```

`AssistantState.status` is `idle`, `working`, `confirming`, `asking` or `failed`. Only `idle` and `failed` accept a message; a failed turn keeps its conversation and shows its error. Any error that escapes a reply moves the turn to `failed` from `working`, `confirming` or `asking`.

Each receipt has its own lifecycle: started, then holding a proposal, questions or automation ID, then `approved`, `answer` or `submitted`, and finally a `result`. A receipt with a result is never reopened. The panel's activities (`working`, `completed`, `failed`, `cancelled`) mirror the change and draft receipts; a question shows an activity only if it fails.

## Failures stay visible and retries reuse stored work

- Receipts are written before effects that cross services: the automation ID before `Automations.chat`, the decision before `Changes.decide`. A repeated callback or replayed call finds earlier work through `assistant:<turnId>`, `tool:<callId>`, and the `<sessionId>:<callId>` request IDs.
- `deliverReply` catches any typed reply failure for the current turn. It fails the turn's unfinished receipts, sets `failed` with the error, clears the confirmation and questions, and releases tools still waiting in memory with an empty answer. Storage stays the source of truth.
- A stale proposal fails the turn instead of retrying. The person sends a new message and the assistant prepares a fresh proposal against current data.
- Storage errors inside a transaction become `AssistantError`. Scheduling runs inside the same transaction, so a message is never accepted without its reply.
- pi failures, such as `Agent did not answer: <reason>`, fail the turn with that message.

## The browser panel lives outside the page lifecycle

[`src/ui/assistant/`](../src/ui/assistant/update.ts) is a submodel of the root. [`update/assistant.ts`](../src/ui/update/assistant.ts) folds it with the current `pageContext` and whether the page has dirty forms or an unsent message. Its only subscription is dictation into the message box ([`subscriptions.ts`](../src/ui/assistant/subscriptions.ts)); polling is a delayed `RequestAssistant` command.

A newly completed activity makes the root reload its resources. With Follow on, the panel navigates to the newest activity link it hasn't seen that passes `trustedHref`, and never while the page is dirty. A failed request shows the error and a "Reconnect assistant" button that reads the session again.
