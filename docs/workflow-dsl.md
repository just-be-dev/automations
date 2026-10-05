# Workflow DSL

An automation is a JSON `Workflow`: a name, a trigger, and a tree of steps. The designer agent writes it, and runs execute the saved copy. The pieces:

- **Entities** are the records a workflow is about, such as an `employee`. The `EntityStore` service keeps their types and records; its D1 layer is the implementation in use. A run's **subject** is the entity it's about.
- **Capabilities** are what the interpreter does itself: run an agent, wait, branch, run branches in parallel, decide, and ask a person.
- **Connections** are outside services, such as email, Slack, a calendar, or HTTP. An `action` step performs one of their operations.

Values don't have to be declared up front. A step reads what the run knows when it runs: the subject's fields (following references to other entities), and what earlier steps recorded. A value only a person has is collected by a human step at the point it's needed.

| Module                     | Holds                                                                  |
| -------------------------- | ---------------------------------------------------------------------- |
| `src/workflow.ts`          | The schema, templates, and conditions                                  |
| `src/entities.ts`          | Entity types, records, and reading paths through `ref` fields          |
| `src/entity-store.ts`      | The `EntityStore` service, and an in-memory layer for tests            |
| `src/entity-store-d1.ts`   | The `EntityStore` layer on D1                                          |
| `src/connections.ts`       | The connections and their operations                                   |
| `src/catalog.ts`           | Checks a workflow against the entity types and connections             |
| `src/design.ts`            | The designer agent's prompt                                            |
| `src/interpreter.ts`       | `RunAutomation`, which executes a workflow                             |
| `src/durable-engine.ts`    | The `effect/workflow` engine journaled in the Durable Object's storage |
| `src/connection-runner.ts` | How operations execute                                                 |

## Example

When a new hire's start date is set, remind the manager to greet them, propose a weekly 1:1 time the manager can keep or change, book it, and check on day one's evening that the greeting happened.

```json
{
  "name": "Onboard a new hire",
  "trigger": {
    "kind": "entity",
    "entity": "employee",
    "fields": ["start_date"],
    "when": { "ref": "employee.start_date", "op": "after", "value": "now" }
  },
  "steps": [
    {
      "id": "manager-prep",
      "title": "Set up day one with {{employee.manager}}",
      "kind": "parallel",
      "branches": [
        [
          {
            "id": "greet-reminder",
            "title": "Remind {{employee.manager}} to greet {{employee.name}}",
            "kind": "action",
            "use": "calendar.createEvent",
            "with": {
              "title": "Greet {{employee.name}} in person",
              "attendees": ["{{employee.manager}}"],
              "start": "{{employee.start_date}}T09:00:00Z",
              "duration": "15 minutes",
              "description": "{{employee.name}} starts today as {{employee.role}}."
            }
          }
        ],
        [
          {
            "id": "find-times",
            "title": "Find open 1:1 slots",
            "kind": "action",
            "use": "calendar.findTimes",
            "with": {
              "attendees": ["{{employee.manager}}", "{{employee}}"],
              "after": "{{employee.start_date}}T00:00:00Z",
              "duration": "30 minutes"
            }
          },
          {
            "id": "propose-time",
            "title": "Pick a weekly 1:1 time",
            "kind": "agent",
            "instruction": "From these open times: {{steps.find-times.times}}, pick the best start for a recurring weekly 1:1 between {{employee.manager}} and {{employee.name}}. Prefer early in their first week.",
            "output": { "fields": [{ "name": "start", "type": "datetime" }] }
          },
          {
            "id": "confirm-time",
            "title": "{{employee.manager}} confirms the 1:1 time",
            "kind": "human",
            "prompt": "Your weekly 1:1 with {{employee.name}} is proposed below. Keep it or pick another time.",
            "assignee": "employee.manager",
            "notify": "slack",
            "response": {
              "fields": [
                {
                  "name": "start",
                  "label": "First 1:1",
                  "type": "datetime",
                  "default": "{{steps.propose-time.output.start}}"
                }
              ]
            },
            "timeout": "2 days"
          },
          {
            "id": "book-1on1",
            "title": "Book the weekly 1:1",
            "kind": "action",
            "use": "calendar.createEvent",
            "with": {
              "title": "{{employee.manager}} / {{employee.name}} 1:1",
              "attendees": ["{{employee.manager}}", "{{employee}}"],
              "start": "{{steps.confirm-time.values.start}}",
              "duration": "30 minutes",
              "repeat": "weekly"
            }
          }
        ]
      ]
    },
    {
      "id": "end-of-day-one",
      "title": "End of day one",
      "kind": "wait",
      "until": "employee.start_date",
      "offset": "17 hours"
    },
    {
      "id": "check-greeted",
      "title": "Did {{employee.manager}} greet {{employee.name}}?",
      "kind": "human",
      "prompt": "Quick check: did you get to greet {{employee.name}} in person today?",
      "assignee": "employee.manager",
      "notify": "slack",
      "response": "approval",
      "timeout": "1 day"
    }
  ]
}
```

## Workflow

| Field     | Meaning                                        |
| --------- | ---------------------------------------------- |
| `name`    | Non-blank, at most 120 characters.             |
| `trigger` | What starts a run. See [Triggers](#triggers).  |
| `steps`   | 1–20 top-level steps. Each list runs in order. |

Rules for the whole tree:

- At most 60 steps in total, nested steps included.
- Steps nest at most 4 levels deep.
- Step IDs (`[a-zA-Z0-9_-]{1,40}`) are unique across the whole tree.

Decoding checks the shape. Before a draft is accepted and again on save, `checkWorkflow` checks it against the catalog, the entity types in the store and the connections:

- Every ref starts at the subject's type or at `steps`, and every field on its path exists.
- A step only reads steps that finish before it on every path. Steps inside a `parallel` step's branches are readable after the `parallel` step. Steps inside an `if` or `decide` branch are readable only later in that same branch, because the branch may not run.
- Action steps name a known operation, give every required input, and give no unknown ones. `people` inputs are lists, `person` inputs point at an entity with a text field named `email` (or at that field) or are an email address, and `url` inputs are literal public HTTPS URLs.
- A human step's `assignee` is a person.

The designer gets every problem back and retries once.

## Triggers

### `entity`

```json
{ "kind": "entity", "entity": "employee", "fields": ["start_date"], "when": Condition }
```

Starts a run when an entity of that type is created, or when one of `fields` changes. If `fields` is omitted, any field counts. `when` is optional and must hold for the new version. The entity becomes the run's subject, and refs to it start with its type: `employee.…`.

Saving the automation subscribes it to the type in the entity store. `PUT /api/entities/:type/:id` writes the entity and asks each subscribed automation whether its trigger matches.

### `manual`

```json
{ "kind": "manual", "subject": "employee" }
```

Started from the studio or `POST /api/automations/:id/start`. With `subject`, the starter picks an entity of that type (`{ "subject": "<entity id>" }`). Without it, the run has no subject, and refs can only read `steps`.

## Entities

An entity type has a `name` and `label`, a `title` field that names an entity when it's shown as text, and fields. Field types are `text`, `number`, `boolean`, `date` (`YYYY-MM-DD`), `datetime`, `email`, and `ref`, which holds another entity's ID and names its type in `to`:

```json
{
  "name": "employee",
  "label": "Employee",
  "title": "name",
  "fields": [
    { "name": "name", "label": "Name", "type": "text" },
    { "name": "email", "label": "Email", "type": "text" },
    { "name": "role", "label": "Role", "type": "text" },
    { "name": "start_date", "label": "Start date", "type": "date" },
    { "name": "manager", "label": "Manager", "type": "ref", "to": "employee" }
  ]
}
```

`migrations/0002_entities.sql` creates this type and two employees: `grace`, and `ada`, who reports to Grace and has no start date yet.

| Endpoint                        | Purpose                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/entities/types`       | List entity types                                                                                            |
| `PUT /api/entities/types/:type` | Create or replace a type                                                                                     |
| `GET /api/entities/:type`       | List a type's entities                                                                                       |
| `GET /api/entities/:type/:id`   | Read one entity                                                                                              |
| `PUT /api/entities/:type/:id`   | Merge `{ "data": { … } }` over the entity, check it against its type, and start the runs its change triggers |

## Refs and templates

A ref is a dotted path with up to 5 segments after its root:

- `employee.start_date` reads a field of the subject.
- `employee.manager` reads a whole entity through a `ref` field, and `employee.manager.email` reads one of its fields. `employee.id` is the subject's ID.
- `steps.<id>.<field>…` reads what an earlier step recorded, for example `steps.confirm-time.values.start`. Numeric segments index arrays.

A ref is written bare where one is expected (`until`, `assignee`, conditions); `{{employee.start_date}}` is unwrapped there. In text (titles, instructions, prompts, questions, action inputs, and field defaults), refs are written as `{{employee.name}}`.

Before a step runs, the refs it reads are resolved in one Activity, loading the entities that `ref` fields point to. A replay reuses those values even if the entities have changed since. When text is rendered, strings are inserted as they are, entities as their title, lists as comma-separated items, and other JSON as JSON. A ref with no value stays as written. An action input that is exactly one `{{ref}}` passes the value through unrendered, which is how a person entity reaches an operation.

## Capabilities

Every step has an `id`, a `title` (non-blank, at most 120 characters), and a `kind`.

### `agent`

```json
{
  "kind": "agent",
  "instruction": "...",
  "output": { "fields": [{ "name": "start", "type": "datetime", "description": "..." }] }
}
```

An AI agent does work that needs judgment or writing. The instruction can be up to 4000 characters. The agent sees the subject and what earlier steps recorded, but it can't contact anyone; action steps do that with its answer.

- Without `output`, it records `{ "output": text }`.
- With `output`, it answers with those fields, checked against their types (`text`, `number`, `boolean`, `date`, `datetime`), and records `{ "output": { field: value } }`.

The agent steps in a run share one pi conversation. Each attempt has its own request ID, so a retry asks again.

### `wait`

```json
{ "kind": "wait", "duration": "3 days" }
{ "kind": "wait", "until": "employee.start_date", "offset": "-7 days" }
```

Sleeps on a durable clock, either for a duration, or until the date at a ref shifted by an optional offset. A duration is `<1–4 digits> minute|hour|day|week`, with an optional plural `s`; an offset may start with `-`. The `until` value must be a string `Date.parse` accepts, or the step fails. A target in the past continues at once. It records `null`.

### `parallel`

```json
{ "kind": "parallel", "branches": [[Step, ...], [Step, ...]] }
```

Has 2–8 branches of 1–20 steps each. They run concurrently, and the run continues once all of them finish. What each branch records is merged into the run state. It records nothing under its own ID.

### `if`

```json
{ "kind": "if", "cases": [{ "when": Condition, "steps": [Step, ...] }], "otherwise": [Step, ...] }
```

Runs the steps of the first of its 1–8 cases whose condition holds. If none holds, it runs `otherwise`, which is optional. It records `{ "matched": index | null }` before its branch runs.

### `decide`

```json
{ "kind": "decide", "model": "clef-flash", "question": "...",
  "options": [{ "id": "...", "description": "...", "steps": [Step, ...] }] }
```

A model reads the run so far, picks one of 2–8 options, and the run continues with that option's steps. The question can be up to 2000 characters. Option IDs follow the step ID pattern and are unique within the step, and each description is up to 500 characters.

`model` is `clef-flash` (simple routing), `clef` (nuanced calls), or `jev`. The schema accepts `jev`, but the designer is never told about it. For now, every decision is made by the automation's pi agent, whatever `model` says.

It records `{ "choice": optionId, "confidence": number, "probabilities": { optionId: number } }`. The step fails if the model names an option that doesn't exist.

### `human`

```json
{ "kind": "human", "prompt": "...", "assignee": "employee.manager", "notify": "slack", "timeout": "2 days",
  "response": "approval" | { "fields": [{ "name": "start", "label": "...", "type": "datetime", "default": "{{steps.propose-time.output.start}}" }] } }
```

Pauses the run until a person responds.

- `prompt` is up to 4000 characters.
- `assignee` is a ref to a person: an entity with a text field named `email`. The schema allows leaving it out, but the designer is told to always set it.
- `notify` (`slack` or `email`) also sends the request through that connection. Both are simulated today, so the task records the channel and sends nothing.
- `response` is `"approval"` (approve or reject), or a form of at least one field. Field types are `text`, `number`, `boolean`, `date`, and `datetime`, and a field's `default` is a template that prefills the answer.
- `timeout` is an optional duration. When it passes first, the step finishes with `timedOut: true`, and a form keeps its defaults, so a proposal nobody objects to goes ahead.

Open requests appear on the run as tasks. `POST /api/automations/:id/runs/:runId/tasks/:stepId` answers one with `{ "approved": boolean }` or `{ "values": { field: value } }`, checked against the field types.

It records `{ "approved"?: boolean, "values"?: { field: JSON }, "respondedBy"?: string, "timedOut": boolean }`.

## Connections

### `action`

```json
{
  "kind": "action",
  "use": "calendar.createEvent",
  "with": {
    "title": "...",
    "attendees": ["{{employee.manager}}"],
    "start": "...",
    "duration": "30 minutes"
  }
}
```

Performs one connection operation. Each input in `with` is a template string, or a list of them for `people` inputs. The step records what the operation returns.

| Operation              | Inputs (`?` = optional)                                                              | Records                                  |
| ---------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `email.send`           | `to` person, `subject`, `body`                                                       | `messageId`                              |
| `slack.sendMessage`    | `to` (a person, or a channel such as `#team`), `text`                                | `channel`, `ts`                          |
| `calendar.findTimes`   | `attendees` people, `after` datetime, `duration`                                     | `times`, a few open start times          |
| `calendar.createEvent` | `title`, `attendees` people, `start` datetime, `duration`, `description?`, `repeat?` | `eventId`, `start`                       |
| `http.post`            | `url` (literal), `body?` JSON                                                        | `status`, `body` (up to 4000 characters) |

Email, Slack, and Calendar are **simulated**: there are no credentials yet, so their operations contact nothing. They succeed and record what they would have sent, with `simulated: true`. Their IDs derive from the step's idempotency key. `calendar.findTimes` offers weekday slots at 10:00 and 14:00 UTC.

`http.post` really sends:

- This is the SSRF boundary. The URL must be HTTPS, carry no username or password, and not target `localhost`, `127.*`, `10.*`, `192.168.*`, `169.254.*`, or `172.16–31.*`. It's checked when the workflow is checked and again before sending.
- Without `body`, it sends `{ "subject", "steps" }`.
- Delivery is at least once. Every request carries an `Idempotency-Key` header that stays the same across retries, so receivers can drop duplicates.
- It doesn't forward trace headers, times out after 30 seconds, and fails on a non-2xx status.

## Conditions

```json
{ "ref": Ref, "op": "equals" | "notEquals" | "greaterThan" | "lessThan" | "contains", "value": JSON }
{ "ref": Ref, "op": "before" | "after", "value": "now" | "2026-11-02" }
{ "ref": Ref, "op": "exists" }
{ "all": [Condition, ...] }
{ "any": [Condition, ...] }
{ "not": Condition }
```

| Op                         | True when                                                               |
| -------------------------- | ----------------------------------------------------------------------- |
| `equals` / `notEquals`     | The values are (not) equal. Objects and arrays compare by their JSON.   |
| `greaterThan` / `lessThan` | Both are numbers, or both are strings (compared with `localeCompare`).  |
| `contains`                 | A string contains the substring, or an array contains an equal element. |
| `before` / `after`         | Both are dates `Date.parse` reads. `"now"` is the current time.         |
| `exists`                   | The value is neither missing nor `null`.                                |

A comparison between mismatched types is false. Conditions never call a model; use `decide` for judgment calls. An `if` step reads the current time once, in an Activity, so a replay gets the same answer.

## Run state and execution

A run starts with `{ "runId", "subject": { "type", "id", "data" } | null, "steps": {} }`, and each step adds its record under `steps.<id>`. The subject is a snapshot taken when the run starts; refs through `ref` fields load the current version when the step runs.

`RunAutomation` maps the tree onto `effect/workflow` primitives:

| Kind                        | Primitive                                                                  |
| --------------------------- | -------------------------------------------------------------------------- |
| Every step's refs           | An Activity named `<id>/refs`.                                             |
| `agent`, `action`, `decide` | An Activity, retried twice. A replay reuses its result.                    |
| `wait`                      | A `DurableClock`. The current time is an Activity.                         |
| `human`                     | A `DurableDeferred`, raced against a `DurableClock` when it has a timeout. |
| `parallel`, `if`            | Plain control flow, evaluated again on every replay.                       |

The engine in `src/durable-engine.ts` journals payloads, Activity results, deferred completions, and clock times in the Automation object's storage under `wf:<executionId>:…`. It never keeps a run in memory between events: each `advance` callback replays the run from the start, reusing everything journaled, until it completes or reaches a clock or a person. A `clock` callback fires each durable clock at its time, and answering a task completes its deferred. Both schedule another replay.

As it goes, the interpreter reports each step as `running`, `waiting`, or `done`, with its record. That fills in the run's `steps` and `tasks` (`GET /api/automations/:id/runs/:runId`). A run's status is `running`, `waiting` (on a clock or a person), `completed`, or `failed` with an `error`.
