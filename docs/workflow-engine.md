# Workflow engine

Agents write a workflow, the DSL holds it, and an interpreter runs a saved snapshot of it. One `AutomationAgent` Durable Object per automation hosts the planner, the saved workflow, and the interpreter; only naming a new automation runs in the Api Worker. [The architecture overview](../ARCHITECTURE.md) explains how the parts fit together, and [the Workflow DSL reference](workflow-dsl.md) defines every field. This page shows how the parts connect.

## Every hand-off is checked against the catalog

```diagram
┌───────────────────┐        ┌───────────────────┐        ┌───────────────────┐
│ Generation        │        │ DSL               │        │ Execution         │
│ namer titles it;  │ draft  │ Workflow: name,   │ saved  │ beginRun starts a │
│ planner edits a   │───────▶│ trigger, steps,   │───────▶│ run; the          │
│ working copy      │        │ permissions       │        │ interpreter       │
│ through pi tools  │        │                   │        │ replays its walk  │
└─────────┬─────────┘        └─────────┬─────────┘        └─────────┬─────────┘
          │                            │                            │
          └────────────────────────────┼────────────────────────────┘
                                       ▼
                         ┌───────────────────────────┐
                         │ checkWorkflow             │
                         │ entity types · templates ·│
                         │ roles · connection        │
                         │ registry                  │
                         └───────────────────────────┘
```

[`checkWorkflow`](../src/workflow/catalog.ts) runs at four points: when the planner calls [`check_workflow`](../src/agents/planner/tools.ts), when [`planDraft`](../src/agents/planner/planner.ts) settles its answer, on [save](../src/automation/workflow-store.ts), and when [a run starts](../src/automation/runs.ts). The tool, save, and run start each read the current catalog, so a type, template, or role that changed since the last check is caught at the next one. `planDraft` checks against the catalog read when the reply started, the same one its instructions describe, and skips the check when the working copy didn't change.

## Agents generate the workflow

### The planner edits a working copy, never a whole workflow

```diagram
┌────────────────────────────────┐
│ createAutomation               │ ◀── POST /api/automations
│ nameAutomation: namer model,   │
│ 5 s limit, else opening words  │
│ listNewAutomation(name)        │
└───────────────┬────────────────┘
                │ chat(id, description)
                ▼
┌────────────────────────────────┐ ◀── POST /:id/chat, or the
│ chat: one transaction stores   │     assistant through
│ pendingChat and schedules      │     Automations.chat
│ planReply                      │
└───────────────┬────────────────┘
                │ planReply callback {automationId, chatId}
                ▼
┌────────────────────────────────┐
│ planning.start: "plan" holds   │
│ planOf(draft), a flat working  │
│ copy keyed by step ID          │
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐      ┌───────────────────────────┐
│ planDraft                      │      │ Planner tools             │
│ instruct(plannerInstructions(  │ call │ set_workflow, put_steps,  │
│   catalog)) as system prompt   │─────▶│ remove_steps,             │
│ prompt chat:<chatId> with      │◀─────│ set_permissions,          │
│   turnMessage(draft as YAML)   │result│ show_workflow,            │
└───────────────┬────────────────┘      │ check_workflow,           │
                │ Markdown answer       │ ask_question              │
                ▼                       └───────────────────────────┘
┌────────────────────────────────┐      ┌───────────────────────────┐
│ settle                         │ fail │ prompt chat:<chatId>:retry│
│ Reply: 1–8,000 characters      │─────▶│ retryInstructions(        │
│ samePlan → keep the draft      │◀─────│   problems), once         │
│ else assemblePlan →            │      └───────────────────────────┘
│ decodeWorkflow → checkWorkflow │
└───────────────┬────────────────┘
                │ a second failure sets pendingChat failed
                ▼
┌────────────────────────────────┐
│ One transaction: draft, plus   │
│ permissions set meanwhile;     │
│ exchange:<n> with asked rounds │
│ and diffWorkflows(old, new);   │
│ clear pendingChat and plan     │
└───────────────┬────────────────┘
                ▼
     AutomationIndex.record, best effort
```

- [`createAutomation`](../src/automation/creation.ts) runs in the Api Worker. [`nameAutomation`](../src/agents/namer/namer.ts) never fails: a slow, failed, or empty answer falls back to the description's opening words. The description becomes the first chat message.
- [`chat`](../src/automation/design-session.ts) only stores `pendingChat` and schedules `planReply`; while questions are open it answers them instead. The reply runs later in the object's alarm, so a reload mid-answer loses nothing.
- [`planDraft`](../src/agents/planner/planner.ts) sets the instructions, generated from the catalog, as the root pi conversation's system prompt on every turn. pi resends them only when they change.
- [The tools](../src/agents/planner/tools.ts) edit [the `Plan`](../src/agents/planner/plan.ts) stored under `plan`. Each step lives once in `stepsById`, and container steps name their children by ID. Every edit sets or replaces by ID, so a call pi reruns after a restart changes nothing more.
- Settling compares the working copy with where it started (`samePlan`) before assembling it. `assemblePlan` reports missing, repeated, and unplaced steps before `decodeWorkflow` and `checkWorkflow` run. pi failures are not retried.
- When the reply edits an existing draft, its exchange records [`diffWorkflows`](../src/workflow/changes.ts) against the draft as it is at commit, so permissions the person set meanwhile don't count as the planner's. Steps match by ID wherever they sit, and each changed step keeps its fields' old values. A first draft or a reply that changed nothing records no changes.
- While the turn runs, `trackProgress` polls pi's live answer every 2 seconds. Tool names map to fixed phrases; otherwise [`pickProgress`](../src/agents/planner/planner.ts) asks the [`Classifier`](../src/ai/classifier.ts) to pick one from the latest reasoning with `clef-flash`, keeping the last phrase when it fails or isn't sure.

### Questions park the turn without holding the object

```diagram
Studio        design-session.ts          planning.ts            pi root turn
                                         + AnswerHub              (planner)
  │                   │                       │                       │
  │ POST /:id/chat    │                       │                       │
  │──────────────────▶│                       │                       │
  │                   │ tx: pendingChat +     │                       │
  │                   │ planReply job         │                       │
  │                   │                       │                       │
  │                   │ planReply callback    │                       │
  │                   │ start: planOf(draft)  │                       │
  │                   │──────────────────────▶│                       │
  │                   │ watchParked(chatId)   │                       │
  │                   │──────────────────────▶│                       │
  │                   │ planDraft · prompt chat:<chatId>              │
  │                   │──────────────────────────────────────────────▶│
  │                   │                       │ ask_question(callId)  │
  │                   │                       │◀──────────────────────│
  │                   │                       │ answerSlot(callId)    │
  │                   │                       │ questions → plan      │
  │                   │ parked(chatId)        │                       │
  │                   │◀──────────────────────│                       │
  │                   │ returns, writes       │                       │
  │                   │ nothing               │                       │
  │ poll → asking     │                       │                       │
  │◀──────────────────│                       │                       │
  │                   │                       │                       │
  │ POST /:id/answers │                       │                       │
  │──────────────────▶│                       │                       │
  │                   │ tx: recordAnswer +    │                       │
  │                   │ planReply job         │                       │
  │                   │ deliver(callId)       │                       │
  │                   │──────────────────────▶│                       │
  │                   │                       │ answer → tool result  │
  │                   │                       │──────────────────────▶│
  │                   │ planReply again       │                       │
  │                   │ joins chat:<chatId>   │                       │
  │                   │ Markdown reply        │                       │
  │                   │◀──────────────────────────────────────────────│
  │                   │ settle → draft +      │                       │
  │                   │ exchange with asked   │                       │
```

[`ask_question`](../src/ai/ask-question/tool.ts) checks every question (`questionnaireProblems`) before showing any, then calls the host's `Ask`. [`planning.ts`](../src/automation/planning.ts) stores the questions in `plan` under pi's call ID and tells [`AnswerHub`](../src/ai/ask-question/answer-hub.ts) the turn has parked. `planReply` races the turn against that signal and returns without writing: callbacks run one at a time, and a parked turn may wait for days.

Answering stores the answer and schedules `planReply` in one transaction, then wakes the tool if it still waits in memory. After a restart, pi reruns the tool with the same call ID, and it finds the answer in `plan`. Either way, the redelivered `planReply` joins the same pi turn through its request ID.

### pi conversations carry every agent's model calls

[`PiAgent`](../src/ai/pi.ts) is the conversation contract; [the Cloudflare implementation](../src/platform/cloudflare/pi.ts) runs pi-durable inside the Durable Object. The planner is the root conversation and the only one offered the tools. Each run creates its own conversation for its agent steps. `transcript` reads either one back as a [`Trace`](../src/ai/trace.ts). The namer and the [`Classifier`](../src/ai/classifier.ts), which picks progress phrases and makes decide steps' decisions, call Workers AI directly through [`workers-ai.ts`](../src/platform/cloudflare/workers-ai.ts); neither keeps a conversation.

## The DSL is a trigger and a tree of steps

```diagram
┌──────────────────────────────────────────────────────────────────────┐
│ Workflow · name · permissions? { operation: "auto" | { ask: role } } │
│                                                                      │
│ ┌──────────────────────────────┐  ┌────────────────────────────────┐ │
│ │ trigger · one of             │  │ steps · Step[], 1–20 top level │ │
│ │                              │  │                                │ │
│ │ manual    subject?           │  │ Leaf capabilities              │ │
│ │ entity    entity, fields?    │  │   agent   instruction, output? │ │
│ │ event     event, subject?    │  │   wait    duration | until,    │ │
│ │ schedule  cron, timezone?,   │  │           offset?              │ │
│ │           entity?            │  │   human   prompt, assignee?,   │ │
│ │ date      entity, on,        │  │           notify?, response,   │ │
│ │           offset?, time?,    │  │           timeout?             │ │
│ │           timezone?          │  │   stop    reason               │ │
│ │                              │  │                                │ │
│ │ when?: Condition, on all     │  │ Containers hold Step[]         │ │
│ │ but manual                   │  │   parallel  branches[][]       │ │
│ │                              │  │   if        cases[].when +     │ │
│ └──────────────────────────────┘  │             cases[].steps,     │ │
│                                   │             otherwise?         │ │
│                                   │   decide    model, question,   │ │
│                                   │             options[].steps    │ │
│                                   │                                │ │
│                                   │ Connection                     │ │
│                                   │   action    use, with,         │ │
│                                   │             template?, match?  │ │
│                                   └────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

[`model.ts`](../src/workflow/model.ts) defines these as Schemas. `Step` is a recursive union that `childSequences` and `flattenSteps` walk. The `Workflow` schema enforces 1–20 top-level steps, at most 60 in total, 4 levels of nesting, and unique IDs. [The DSL reference](workflow-dsl.md) specifies each trigger, capability, connection, and template.

### Refs tie steps to the subject, earlier steps, and the event

```diagram
┌────────────────────────────┐     ┌────────────────────────────┐
│ {{ref}} in text            │     │ Bare Ref                   │
│ titles, instructions,      │     │ wait until, assignee,      │
│ prompts, inputs, defaults, │     │ match.on, Condition.ref,   │
│ template slot values       │     │ a date trigger's on        │
└─────────────┬──────────────┘     └──────────────┬─────────────┘
              └─────────────────┬─────────────────┘
                                ▼
                 ┌─────────────────────────────┐
                 │ Ref: a root + up to 5 fields│
                 └──────────────┬──────────────┘
           ┌────────────────────┼────────────────────┐
           ▼                    ▼                    ▼
 ┌───────────────────┐ ┌─────────────────┐ ┌───────────────────┐
 │ <subject type>.…  │ │ steps.<id>.…    │ │ event.…           │
 │ the subject, and  │ │ what an earlier │ │ envelope and data │
 │ entities its ref  │ │ step recorded   │ │ (event triggers)  │
 │ fields point to   │ │                 │ │                   │
 └───────────────────┘ └─────────────────┘ └───────────────────┘
```

`stepRefs` lists what a step reads. `stepNeeds` lists the IDs of the steps whose values it reads, leaving out `exists` checks. Conditions (`holds`) evaluate refs without a model, and a `match` turns each pattern into a condition on `match.on` (`patternCondition`). `{{ref}}` text (`renderTemplate`) is not a stored [template](../src/entities/templates.ts); `expandTemplates` turns those into plain action inputs before a run.

### checkWorkflow proves the tree fits the catalog

```diagram
┌──────────────────────────┐      ┌──────────────────────────────┐
│ Workflow                 │      │ Catalog, read when checked   │
│ decoded by its Schema:   │      │ types, templates, roles      │
│ shape, sizes, IDs        │      │ (catalogOf over EntityStore) │
└────────────┬─────────────┘      │ + connection registry        │
             │                    └───────────────┬──────────────┘
             └────────────────┬───────────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ workflowProblems                                                 │
│ triggerProblems      the type exists, watched fields exist, when │
│                      reads no steps, a date trigger reads a date │
│                      or datetime field                           │
│ checkSequence        each ref resolves; steps.<id> only once     │
│                      that step finished on every path; actions   │
│                      name an operation, give each input once on  │
│                      every match path, and fill template slots;  │
│                      person and url inputs fit; an assignee is a │
│                      person                                      │
│ unreachableProblems  nothing follows a stop step in its list     │
│ permissionProblems   every operation used has "auto" or a known  │
│                      role, and none named is unknown             │
└───────────────────────────────┬──────────────────────────────────┘
                                ▼
     no problems: the Workflow   ·   some: InvalidWorkflow, one per line
```

`checkSequence` carries the steps finished on every path. After a `parallel` step, every step its branches finish on every path joins them; after an `if` or `decide`, only the step itself does, because a branch may not run. That guarantee lets the interpreter treat a missing record as a step that didn't run. `describeCatalog` writes the same catalog into the planner's instructions. [`docs.test.ts`](../src/workflow/docs.test.ts) checks the DSL reference's examples against the seeded catalog.

## Execution replays a saved snapshot

### Saving fixes what runs

[`save`](../src/automation/workflow-store.ts) checks the draft and refuses a timed trigger that already matches more than 50 subjects. It stores `saved` and books or cancels the `tick` job in one transaction, subscribes the automation to its trigger's entity type, then updates the directory, best effort. Runs read only `saved`.

### AutomationAgent supplies storage, jobs, and models

```diagram
┌──────────────────────────────────────────────────────────────────┐
│ AutomationAgent · src/platform/cloudflare/automation.ts          │
│                                                                  │
│ Outer Effect, at plan time and cold start                        │
│   DurableObjectState · Workers AI · EntityStoreD1 ·              │
│   AutomationIndexD1 · EventsQueue · SLACK_BOT_TOKEN ·            │
│   STUDIO_URL · ALCHEMY_DEV, read only on a dev_ stage ·          │
│   EMAIL_FROM → send_email binding (remote)                       │
│                                                                  │
│ Instance                                                         │
│   AutomationHost.storage → the object's storage, transactions    │
│   AutomationHost.jobs    → Alchemy callbacks                     │
│     planReply   job <chatId>                  at once            │
│     advance     job <executionId>             at once            │
│     clock       job <executionId>/<deferred>  at a time          │
│     tick        job schedule                  at a time          │
│   AutomationHost.erase   → delete storage, jobs, alarm; reset    │
│   planner tools + AnswerHub → openPiAgent(PLANNER_MODEL)         │
│   Classifier (clef models)                                       │
│   SlackSender · EmailSender, null without credentials            │
│   LocalDevelopment, false unless ALCHEMY_DEV was read            │
│   makeAutomation() → operations, called over RPC                 │
└──────────────────────────────────────────────────────────────────┘
```

[`AutomationHost`](../src/automation/host.ts) makes storage and jobs one capability: a job scheduled inside `storage.transaction` commits or rolls back with the writes. Callback names and payloads are persisted contracts. The planner tools exist before pi opens, so a turn resumed after a restart still has them. [The facade](../src/automation/application.ts) joins the design session and runs, which share no state except [the workflow store](../src/automation/workflow-store.ts) and the host's services.

### Four entry points start a run, all through beginRun

```diagram
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ start           │ │ entityChanged   │ │ eventReceived   │ │ tick {at}       │
│ POST /:id/start │ │ a confirmed     │ │ Events queue;   │ │ schedule or     │
│ any trigger;    │ │ entity write    │ │ Api fans out to │ │ date trigger;   │
│ event data given│ │ via subscribers │ │ every automation│ │ subjects.due    │
│ id: UUID        │ │ id: entity-<key>│ │ id: event-<id>  │ │ id: scheduled-… │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         └───────────────────┴─────────┬─────────┴───────────────────┘
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │ beginRun(saved, subject, id, event?)    │
                  │ checkWorkflow against today's catalog   │
                  │ expandTemplates into plain inputs       │
                  │ on failure: a failed run, no execution  │
                  └────────────────────┬────────────────────┘
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │ One storage transaction                 │
                  │ run:<runId>       status running        │
                  │ execution:<eid>   its run ID            │
                  │ wf:<eid>:payload  runId, workflow,      │
                  │                   subject, event?       │
                  │ advance job       {executionId}         │
                  └─────────────────────────────────────────┘
```

- `start` serves the Run button. For an event trigger it builds an unpublished event with a fresh ID and requires `when` to hold.
- `entityChanged` starts a run only for an entity trigger, when the entity is new or a watched field changed, and `when` holds. A confirmed change passes the key `change:<proposalId>`, so the run ID is `entity-change:<proposalId>` and a retried or recovered change finds its run instead of starting another; without a key it is a UUID.
- `tick` starts each due subject's run under `scheduled-<at>` or `scheduled-<at>-<entity id>`, then books the next occurrence. More than 50 due subjects start none and record one failed run.
- [`beginRun`](../src/automation/runs.ts) derives the `ExecutionId` from the payload (`RunAutomation.executionId`, keyed by run ID). The payload carries the expanded workflow, so template edits never reach a run in flight.

### Events reach every automation through a queue

```diagram
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ events.emit step │  │ confirmed entity │  │ Slack webhook    │
│ POST /api/events │  │ write: entity.*  │  │ ChannelMailbox   │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         └─────────────────────┼─────────────────────┘
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ Events queue → Api consumer → deliverEvent                    │
│ entity.put first goes through the ChangeCoordinator, unless   │
│ it can never apply (depth 16, not an entity): logged, acked   │
│ then eventReceived on every automation in AutomationIndex     │
│ other failures retry the message: 10 times, then dead-letter  │
└────────────────────────────────┬──────────────────────────────┘
                                 ▼
┌───────────────────────────────────────────────────────────────┐
│ eventReceived, one at a time per automation                   │
│ event:<id> receipt exists → return it                         │
│ run event-<id> exists → return it; its receipt wasn't written │
│ saved trigger is this event, subject type fits, when holds    │
│   → beginRun                                                  │
│ write the receipt: { runId } or { runId: null }               │
└───────────────────────────────────────────────────────────────┘
```

[`deliverEvent`](../src/events/delivery.ts) acknowledges a message only after every automation answers, and receipts make the redelivery harmless. Ignored events keep a receipt too, so a redelivery is never matched against a newer workflow. An `entity.put` past the chain limit, or whose data isn't an entity, can never apply: delivery logs a warning and acknowledges it without reaching any automation, instead of retrying it into the dead letters. Publishers refuse both first, and `events.emit` fails a step that would pass the 16-hop limit. [The consumer](../src/platform/cloudflare/api.ts) runs in the private Api Worker.

### A replay walks the tree from the start

```diagram
┌───────────────────────────────┐
│ advance {executionId}         │
│ runForExecution → runId       │
│ run waiting → running         │
└───────────────┬───────────────┘
                ▼
┌───────────────────────────────┐ result stored ┌───────────────────┐
│ durable.replay                │──────────────▶│ return it as is   │
│ one replay per execution at a │               └───────────────────┘
│ time; decode wf:<eid>:payload │
└───────────────┬───────────────┘
                ▼
┌───────────────────────────────┐      ┌──────────────────────────────┐
│ runSteps from the first step  │      │ Journal lookup               │
│ stepNeeds unmet → skipped     │ each │ Activity or deferred stored: │
│ Activity <id>/refs, if any    │─────▶│ reuse its Exit               │
│ agent, action, decide:        │◀─────│ Activity missing: execute it │
│   Activity <id>, retried twice│      │ and store its Exit           │
│ wait: DurableClock <id>       │      │ Clock: store clock:<name>,   │
│ human, ask-first action:      │      │ wakeAt the host              │
│   request Activity + deferred │      │ Deferred missing: suspend    │
│ if, match, parallel: plain    │      └──────────────────────────────┘
│ code; stop: RunStopped        │
└───────────────┬───────────────┘
                │ Complete, stored as result, or Suspended
                ▼
┌───────────────────────────────┐
│ records.settle                │
│ Suspended → waiting           │
│ success → completed           │
│ RunStopped → stopped          │
│ failure → failed, with error  │
│ ended: open tasks close       │
└───────────────────────────────┘
```

[The durable engine](../src/workflow/durable-engine.ts) keeps nothing in memory between events. [The interpreter](../src/workflow/interpreter.ts) reruns everything outside an Activity on each replay, so that code must be deterministic; the current time (`<id>/now`) and refs (`<id>/refs`) are Activities for that reason. Effect runs a clock of 60 seconds or less as an in-memory sleep inside an Activity instead of scheduling it. Activity and deferred names are journal keys: renaming one makes a waiting run redo that step. [The DSL reference](workflow-dsl.md#run-state-and-execution) maps every step kind to its primitive.

`StepRunner` is the interpreter's only way out; [`runs.ts`](../src/automation/runs.ts) implements it. Agent steps prompt the run's conversation with [`agentPrompt`](../src/workflow/agent-step.ts) under the request ID `agent:<key>`. The key includes the attempt, so a retry asks again and a replay reuses the journal. `agentOutput` checks requested fields against their types. Decide steps skip pi: [`decideRequest`](../src/workflow/agent-step.ts) asks the `Classifier` the step's `model` names, with the question, each option's description, and the subject, event, and step values as state. `decision` decodes its choice, confidence, and probabilities, and the interpreter fails the step on a choice that isn't an option. The decide Activity journals the decision, so a replay reuses it; the classifier keeps no conversation, so a retry repeats nothing. An action's key stays the same across retries, and `http.post` sends it as `Idempotency-Key`. Email Service and Slack take no key, so their steps are delivered at least once.

### Waits and people resume through the journal

```diagram
Trigger, alarm,      runs.ts            durable-engine.ts        interpreter.ts
or person                               wf:<eid>: journal         + StepRunner
  │                     │                       │                       │
  │ trigger fires       │                       │                       │
  │────────────────────▶│                       │                       │
  │                     │ beginRun: check,      │                       │
  │                     │ expandTemplates;      │                       │
  │                     │ tx: run:<id>,         │                       │
  │                     │ execution:<eid>       │                       │
  │                     │ execute (discard)     │                       │
  │                     │──────────────────────▶│                       │
  │                     │                       │ store payload,        │
  │                     │                       │ wake → advance job    │
  │                     │                       │                       │
  │ advance             │                       │                       │
  │────────────────────▶│                       │                       │
  │                     │ replay(eid)           │                       │
  │                     │──────────────────────▶│                       │
  │                     │                       │ run from step 1       │
  │                     │                       │──────────────────────▶│
  │                     │                       │ Activity <id>/refs    │
  │                     │                       │◀──────────────────────│
  │                     │                       │ Activity <id> (agent) │
  │                     │                       │◀──────────────────────│
  │                     │                       │ not journaled: run,   │
  │                     │                       │ store activity:       │
  │                     │                       │ <name>:<attempt>      │
  │                     │                       │ DurableClock <id>     │
  │                     │                       │◀──────────────────────│
  │                     │                       │ store clock:<name>    │
  │                     │ wakeAt → clock job    │                       │
  │                     │◀──────────────────────│                       │
  │                     │ Suspended             │                       │
  │                     │◀──────────────────────│                       │
  │                     │ settle: waiting       │                       │
  │                     │                       │                       │
  │ clock (at time)     │                       │                       │
  │────────────────────▶│                       │                       │
  │                     │ fireClock             │                       │
  │                     │──────────────────────▶│                       │
  │                     │                       │ store deferred:       │
  │                     │                       │ DurableClock/<id>,    │
  │                     │                       │ wake → advance job    │
  │ advance             │                       │                       │
  │────────────────────▶│                       │                       │
  │                     │ replay(eid)           │                       │
  │                     │──────────────────────▶│                       │
  │                     │                       │ run from step 1       │
  │                     │                       │──────────────────────▶│
  │                     │                       │                       │ journaled steps
  │                     │                       │                       │ reuse results
  │                     │                       │ Activity <id>/request │
  │                     │                       │◀──────────────────────│
  │                     │ requestHuman: open task, DM it on Slack       │
  │                     │◀──────────────────────────────────────────────│
  │                     │                       │ await deferred <id>   │
  │                     │                       │◀──────────────────────│
  │                     │ Suspended             │                       │
  │                     │◀──────────────────────│                       │
  │                     │ settle: waiting       │                       │
  │                     │                       │                       │
  │ POST …/tasks/:step  │                       │                       │
  │ or a Slack click    │                       │                       │
  │────────────────────▶│                       │                       │
  │                     │ respond: approvers,   │                       │
  │                     │ field types           │                       │
  │                     │ respondToHuman        │                       │
  │                     │──────────────────────▶│                       │
  │                     │                       │ store deferred:<id>,  │
  │                     │                       │ wake → advance job    │
  │ advance             │                       │                       │
  │────────────────────▶│                       │                       │
  │                     │ replay(eid)           │                       │
  │                     │──────────────────────▶│                       │
  │                     │                       │ run from step 1       │
  │                     │                       │──────────────────────▶│
  │                     │                       │                       │ record answer,
  │                     │                       │                       │ run the rest
  │                     │                       │ Complete              │
  │                     │                       │◀──────────────────────│
  │                     │                       │ store result          │
  │                     │ result                │                       │
  │                     │◀──────────────────────│                       │
  │                     │ settle: completed,    │                       │
  │                     │ close open tasks      │                       │
```

Each `advance` reruns the walk from the first step, reusing what the journal holds, until the run completes or reaches a clock or a person. A clock fires through the `clock` callback; an answer completes its deferred through `respond`. Both store the completion and schedule another `advance`.

In local development, `resumeNow` fires a waiting wait step's clock early by calling the same `clock` operation with the deferred `DurableClock/<id>`. Deferreds are first-write-wins, so the scheduled callback later finds it complete, writes nothing and schedules no `advance`. A run's `resumesAt` comes from the same journal: a `clock:<name>` whose deferred isn't stored yet.

A human step with a `timeout` races its deferred against the clock `<id>/timeout` in `DurableDeferred.raceAll`, named `<id>/outcome` (journaled as `deferred:raceAll/<id>/outcome`). An ask-first action opens its task with `<id>/approval-request` and waits on `<id>/approval`. Opening a task, either way, also sends it as a Slack DM when the deployment has a bot token ([task notifications](../src/automation/task-notifications.ts)). That happens inside the request Activity, records each recipient on the task, and never fails the step. `respond` checks the answer against the task's field types, and, when the studio knows who answers, an approval against the role members the task recorded. An approval DM's **Approve** and **Reject** buttons reach `respond` too: the Api takes each click off its Slack actions queue and answers with the clicker's Slack email ([approving from Slack](slack.md#approving-from-slack)). `respond` takes one answer at a time and records the first as the task's `decision`. A `stop` step fails the execution with `RunStopped`, which interrupts every branch.

### Three records describe one run

| Record            | Storage                                                                                                                  | Owner                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `Run`             | `run:<runId>`: the executed workflow, subject, event, status, step results, tasks, conversation                          | [`run-store.ts`](../src/automation/run-store.ts)         |
| Execution link    | `execution:<executionId>`: its run ID                                                                                    | [`run-store.ts`](../src/automation/run-store.ts)         |
| Journal           | `wf:<executionId>:` + `payload`, `result`, `interrupted`, `activity:<name>:<attempt>`, `deferred:<name>`, `clock:<name>` | [`durable-engine.ts`](../src/workflow/durable-engine.ts) |
| `ExecutionValues` | Not stored: the subject, event, and step values rebuilt on each walk                                                     | [`execution.ts`](../src/workflow/execution.ts)           |

Reports update the `Run` people see; only an engine outcome settles its status. The interpreter never reads the `Run`, and the journal is authoritative for completed work. `RunId` and `ExecutionId` are distinct branded strings.
