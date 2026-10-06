# Workflow DSL

An automation is a JSON `Workflow`: a name, a trigger, and a tree of steps. The planner agent builds it with its tools, and runs execute the saved copy. The pieces:

- **Entities** are the records a workflow is about, such as an `employee`. The `EntityStore` service keeps their types and records; its D1 layer is the implementation in use. A run's **subject** is the entity it's about.
- **Capabilities** are what the interpreter does itself: run an agent, wait, branch, run branches in parallel, decide, ask a person, and stop the run.
- **Connections** are outside services, such as email, Slack, a calendar, or HTTP. An `action` step performs one of their operations.
- **Templates** are approved, reusable wording, such as the standard welcome email. An `action` step fills its inputs from one, and a `match` picks a different one per case, for example by role.

Values don't have to be declared up front. A step reads what the run knows when it runs: the subject's fields (following references to other entities), and what earlier steps recorded. A value only a person has is collected by a human step at the point it's needed.

| Module                                       | Holds                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `src/workflow/model.ts`                      | The DSL schema, template strings, and conditions                       |
| `src/workflow/run.ts`                        | Run state, step results, and human tasks                               |
| `src/entities/model.ts`                      | Entity types, records, and reading paths through `ref` fields          |
| `src/entities/store.ts`                      | The `EntityStore` service (entities and templates), and a memory layer |
| `src/platform/cloudflare/entity-store-d1.ts` | The `EntityStore` layer on D1                                          |
| `src/connections/registry.ts`                | The connections and their operations                                   |
| `src/entities/templates.ts`                  | Templates, their checks, and expanding them before a run               |
| `src/workflow/catalog.ts`                    | Checks a workflow against the entity types and connections             |
| `src/agents/planner/planner.ts`              | The planner agent's prompt, and how its answer becomes a draft         |
| `src/agents/planner/plan.ts`                 | The working copy the planner's tools edit, and its YAML                |
| `src/agents/planner/tools.ts`                | The planner's tools                                                    |
| `src/workflow/interpreter.ts`                | `RunAutomation`, which executes a workflow                             |
| `src/workflow/durable-engine.ts`             | The `effect/workflow` engine journaled in the Durable Object's storage |
| `src/connections/runner.ts`                  | How operations execute                                                 |

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
  ],
  "permissions": {
    "calendar.createEvent": { "ask": "people_ops" },
    "calendar.findTimes": "auto"
  }
}
```

## Workflow

| Field         | Meaning                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `name`        | Non-blank, at most 120 characters.                                                                    |
| `trigger`     | What starts a run. See [Triggers](#triggers).                                                         |
| `steps`       | 1–20 top-level steps. Each list runs in order.                                                        |
| `permissions` | Whether each operation it uses runs on its own or asks a role first. See [Permissions](#permissions). |

Rules for the whole tree:

- At most 60 steps in total, nested steps included.
- Steps nest at most 4 levels deep.
- Step IDs (`[a-zA-Z0-9_-]{1,40}`) are unique across the whole tree.

Decoding checks the shape. Before a draft is accepted, on save, and again when a run starts, `checkWorkflow` checks it against the catalog: the entity types and templates in the store, and the connections.

- Every ref starts at the subject's type or at `steps`, and every field on its path exists.
- A step only reads steps that finish before it on every path. Steps inside a `parallel` step's branches are readable after the `parallel` step. Steps inside an `if` or `decide` branch are readable only later in that same branch, because the branch may not run.
- Action steps name a known operation. On every path through their `match`, each input comes from exactly one place (`with`, a template, or the case), every required input is there, and no unknown ones are. `people` inputs are lists, `person` inputs point at an entity with a text field named `email` (or at that field) or are an email address, and `url` inputs are literal public HTTPS URLs.
- Templates exist and still check against the entity types, every slot is filled, and an entity slot gets exactly one `{{ref}}` to an entity of its type. A template only fills `text` inputs.
- A human step's `assignee` is a person.

The planner can check its working copy with `check_workflow` while it works. When it answers, every problem left goes back to it and it retries once.

## Triggers

### `entity`

```json
{ "kind": "entity", "entity": "employee", "fields": ["start_date"], "when": Condition }
```

Starts a run when an entity of that type is created, or when one of `fields` changes. If `fields` is omitted, any field counts. `when` is optional and must hold for the new version. The entity becomes the run's subject, and refs to it start with its type: `employee.…`.

Saving the automation subscribes it to the type in the entity store. `PUT /api/entities/:type/:id` writes the entity and asks each subscribed automation whether its trigger matches. Every trigger that names an entity type (`entity`, `schedule` and `date` with their `entity`, and `manual` with its `subject`) subscribes to it, so the type can't be deleted while a saved automation uses it; only entity triggers start runs on a change.

### `schedule`

```json
{ "kind": "schedule", "cron": "0 9 * * 1-5", "timezone": "Europe/London" }
```

Starts runs on a recurring schedule. `cron` has five fields, `minute hour day-of-month month weekday`, with `*`, lists, ranges, steps, and month and weekday names. Occurrences must be at least 15 minutes apart. `timezone` is an IANA name and defaults to `UTC`, so `0 9 * * 1-5` above runs at 9:00 London time on weekdays, through daylight saving changes.

Without `entity`, each occurrence starts one run with no subject, and refs can only read `steps`. With `entity`, each occurrence starts one run for every entity of that type for which `when` (optional) holds at that moment, with the entity as the run's subject:

```json
{
  "kind": "schedule",
  "cron": "0 9 * * 1",
  "timezone": "Europe/London",
  "entity": "employee",
  "when": { "ref": "employee.start_date", "op": "after", "value": "now" }
}
```

`"now"` in `when` is the occurrence's time. One occurrence may start at most 50 runs. Nothing is skipped quietly: saving fails if more than 50 entities match when you save, and an occurrence that matches more starts none of them and records a failed run (`scheduled-<millis>`) that says how many matched, so the overview shows it. Narrow `when` so fewer match.

Saving the automation books its next occurrence as a durable job, in the same storage transaction as the snapshot, and saving a trigger that isn't timed cancels it. Each occurrence starts its runs and then books the next one. Its run IDs are fixed by its time and subject (`scheduled-<millis>` or `scheduled-<millis>-<entity id>`), so a redelivered occurrence doesn't start them twice. An occurrence that fires late still starts its runs once, then books the next one after the current time, so missed occurrences are skipped, not started together. `GET /api/overview` reports when a schedule next runs as `saved.nextRunAt`. A scheduled automation can still be started by hand.

### `date`

```json
{
  "kind": "date",
  "entity": "employee",
  "on": "employee.start_date",
  "offset": "3 days",
  "time": "09:00",
  "timezone": "Europe/London"
}
```

Starts a run for each entity of type `entity` on the day the date at `on` falls, shifted by `offset`, at `time` in `timezone`. `on` is a ref from the entity to a `date` or `datetime` field, possibly through `ref` fields (`employee.manager.start_date`). `offset` is optional and counts whole days or weeks; a negative one, such as `"-1 week"`, runs before the date. `time` is 24-hour `HH:MM` and defaults to `09:00`; `timezone` defaults to `UTC`. A `datetime` value counts as the day it falls on in `timezone`. `when` is optional and must hold for the entity on the day. The entity is the run's subject.

The trigger checks every day at `time`, reading each entity's date then, so a run follows the date when it changes: there's no run waiting on the old date. A date set or moved to a day that was already checked, including today after `time`, starts no run. Runs, their IDs, redelivery, and the limit of 50 runs per check work as for `schedule`.

To start when a record changes and then wait until a date, use an `entity` trigger and a `wait` step with `until` and `offset` instead. That run starts at once and keeps the date it read, so it suits processes with work to do before the date.

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

### Roles

A role is a named group of people who approve the operations a workflow [asks first](#permissions) about. Its members are entities with an `email` field, by type and ID:

```json
{
  "name": "people_ops",
  "label": "People Ops",
  "members": [{ "type": "employee", "id": "grace" }]
}
```

`migrations/0004_roles.sql` creates this role. `GET /api/roles` lists roles, and `PUT /api/roles/:name` creates or replaces one once every member exists and has an email: its type has a text field named `email`, and it's set. The MCP server's `list_roles` and `define_role` tools do the same.

The store keeps members able to approve. It refuses to delete an entity a role lists, to clear a member's email, to redefine a member's type without an `email` field, and to delete a type a role has members of. Take the member out of the role first. An approval task already open keeps the members it was opened with.

## Refs

A ref is a dotted path with up to 5 segments after its root:

- `employee.start_date` reads a field of the subject.
- `employee.manager` reads a whole entity through a `ref` field, and `employee.manager.email` reads one of its fields. `employee.id` is the subject's ID.
- `steps.<id>.<field>…` reads what an earlier step recorded, for example `steps.confirm-time.values.start`. Numeric segments index arrays.

A ref is written bare where one is expected (`until`, `assignee`, conditions, `match.on`); `{{employee.start_date}}` is unwrapped there. In text (titles, instructions, prompts, questions, action inputs, field defaults, and what fills a template's slots), refs are written as `{{employee.name}}`. The code calls such text a template string (`renderTemplate`); the stored, reusable [templates](#templates) are a different thing.

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

`model` is `clef-flash` (simple routing), `clef` (nuanced calls), or `jev`. The schema accepts `jev`, but the planner is never told about it. For now, every decision is made by the automation's pi agent, whatever `model` says.

It records `{ "choice": optionId, "confidence": number, "probabilities": { optionId: number } }`. The step fails if the model names an option that doesn't exist.

### `human`

```json
{ "kind": "human", "prompt": "...", "assignee": "employee.manager", "notify": "slack", "timeout": "2 days",
  "response": "approval" | { "fields": [{ "name": "start", "label": "...", "type": "datetime", "default": "{{steps.propose-time.output.start}}" }] } }
```

Pauses the run until a person responds.

- `prompt` is up to 4000 characters.
- `assignee` is a ref to a person: an entity with a text field named `email`. The schema allows leaving it out, but the planner is told to always set it.
- `notify` (`slack` or `email`) also sends the request through that connection. Both are simulated today, so the task records the channel and sends nothing.
- `response` is `"approval"` (approve or reject), or a form of at least one field. Field types are `text`, `number`, `boolean`, `date`, and `datetime`, and a field's `default` is a template that prefills the answer.
- `timeout` is an optional duration. When it passes first, the step finishes with `timedOut: true`, and a form keeps its defaults, so a proposal nobody objects to goes ahead.

Open requests appear on the run as tasks. `POST /api/automations/:id/runs/:runId/tasks/:stepId` answers one with `{ "approved": boolean }` or `{ "values": { field: value } }`, checked against the field types.

It records `{ "approved"?: boolean, "values"?: { field: JSON }, "respondedBy"?: string, "timedOut": boolean }`.

### `stop`

```json
{ "kind": "stop", "reason": "{{employee.name}} withdrew" }
```

Ends the run at once, every branch included: nothing after it runs, and its open tasks close. The run's status becomes `stopped`, with the rendered `reason` (up to 1000 characters) as its `stopReason`. Put it at the end of a branch; a step that follows a stop step in the same list never runs, so `checkWorkflow` rejects it. It records `{ "reason": string }`.

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

An action can also take inputs from a [template](#templates) with `template: { "use", "with" }`, and pick the inputs that vary with a `match`:

```json
{
  "id": "welcome",
  "title": "Welcome {{employee.name}}",
  "kind": "action",
  "use": "email.send",
  "with": { "to": "{{employee}}" },
  "match": {
    "on": "employee.role",
    "cases": [
      {
        "when": {
          "any": [
            { "op": "contains", "value": "engineer" },
            { "op": "contains", "value": "Engineer" }
          ]
        },
        "template": {
          "use": "engineering_welcome_email",
          "with": { "hire": "{{employee}}", "manager": "{{employee.manager}}" }
        }
      }
    ],
    "otherwise": { "template": { "use": "welcome_email", "with": { "hire": "{{employee}}" } } }
  }
}
```

- `match.on` is a ref. Each of the 1–8 `cases` has a `when` pattern: a [condition](#conditions) without `ref`, because `on` names the value once (`{ "op": "contains", "value": "engineer" }`, `{ "op": "exists" }`, `all`, `any`, `not`).
- The first case whose pattern holds supplies its `with`, its `template`, or both. When none holds, `otherwise` does; it's required, so a match always supplies its inputs.
- The step's own `with` and `template` hold what every case shares. An input given twice on one path is a problem, not an override.
- The case is picked from the values the step resolved, so a replay picks the same one. A pattern that compares with `"now"` reads the time once, in an Activity.

| Operation              | Inputs (`?` = optional)                                                              | Records                                  |
| ---------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `email.send`           | `to` person, `subject`, `body`                                                       | `messageId`                              |
| `slack.sendMessage`    | `to` (a person, or a channel such as `#team`), `text`                                | `channel`, `ts`                          |
| `calendar.findTimes`   | `attendees` people, `after` datetime, `duration`                                     | `times`, a few open start times          |
| `calendar.createEvent` | `title`, `attendees` people, `start` datetime, `duration`, `description?`, `repeat?` | `eventId`, `start`                       |
| `http.post`            | `url` (literal), `body?` JSON                                                        | `status`, `body` (up to 4000 characters) |

Email, Slack, and Calendar are **simulated**: there are no credentials yet, so their operations contact nothing. They succeed and record what they would have sent, with `simulated: true`. Their IDs derive from the step's idempotency key. `calendar.findTimes` offers weekday slots at 10:00 and 14:00 UTC.

### Permissions

`permissions` maps each operation the workflow uses to `"auto"` (the run performs it on its own) or `{ "ask": "<role>" }` (each run waits until a member of that [role](#roles) approves it). The studio shows them as allow and ask first, with the role beside it. The planner sets one for every operation, and reads the current ones with the draft on every turn. The person can change any of them in the studio, or with `POST /api/automations/:id/permissions` and `{ "permissions": { "email.send": { "ask": "people_ops" } } }`, which merges into the draft. The planner's edits start from the draft's permissions, and a permission the person sets for another operation while the planner works is kept. `checkWorkflow` rejects a workflow that leaves an operation it uses without a permission, names an unknown operation, or asks an unknown role. Runs follow the saved copy.

When an action asks first, the run resolves its inputs and opens an approval task that shows the operation, those inputs, and the role with its members at that moment. The step waits as `waiting`. Answer it like a human step's task with `{ "approved": boolean }`. When the studio knows who is answering (Cloudflare Access's authenticated email, on deployed stages), only the role's members may answer, and the answer records them as `respondedBy`. Under `alchemy dev` there's no Access, so anyone can answer. Approving performs the operation with the inputs shown. Declining marks the step `declined`, and it records nothing. Every later step that reads its record is then `skipped`, as are the steps that read theirs; the rest of the run carries on. Use a [`stop`](#stop) step to end the run instead. A human step's `notify` doesn't ask.

`http.post` really sends:

- This is the SSRF boundary. The URL must be HTTPS, carry no username or password, and not target `localhost`, `127.*`, `10.*`, `192.168.*`, `169.254.*`, or `172.16–31.*`. It's checked when the workflow is checked and again before sending.
- Without `body`, it sends `{ "subject", "steps" }`.
- Delivery is at least once. Every request carries an `Idempotency-Key` header that stays the same across retries, so receivers can drop duplicates.
- It doesn't forward trace headers, times out after 30 seconds, and fails on a non-2xx status.

## Templates

A template is approved wording an action fills its inputs with, stored next to the entity types:

```json
{
  "name": "engineering_welcome_email",
  "label": "Engineering welcome email",
  "description": "The standard welcome email for new engineers: software engineers, engineering managers, and other engineering roles. Send it to the new hire before they start.",
  "slots": [
    {
      "name": "hire",
      "label": "New hire",
      "type": "ref",
      "to": "employee"
    },
    {
      "name": "manager",
      "label": "Their manager",
      "type": "ref",
      "to": "employee"
    }
  ],
  "content": {
    "subject": "Welcome to engineering, {{hire.name}}",
    "body": "Hi {{hire.name}},\n\nWelcome to the engineering team! You start on {{hire.start_date}}, and {{manager.name}} will be your manager.\n\nIn your first week you'll set up your development environment, pair with a teammate on a small change, and ship it to production. {{manager.name}} will walk you through the engineering handbook on day one.\n\nIf you have questions before you start, write to {{manager.email}}.\n\nSee you soon!"
  }
}
```

- `name` is snake_case. `label` and `description` (up to 500 characters) tell the planner who and what it's for; it reads them to decide when the template fits.
- `slots` are its insertion points, declared like an entity type's fields. A `ref` slot (`hire → employee`) takes an entity; any other slot takes text.
- `content` fills the action inputs of the same names, up to 4000 characters each. Its `{{refs}}` start at a slot and follow `ref` fields like any ref: `{{hire.name}}`, `{{hire.manager.email}}`. A text slot is read whole: `{{note}}`.
- A template is checked against the entity types when it's written.

An action uses one with `"template": { "use": "engineering_welcome_email", "with": { "hire": "{{employee}}", "manager": "{{employee.manager}}" } }`. Each value in `with` fills a slot:

- An entity slot takes exactly one `{{ref}}` that starts at the subject's type and leads to an entity of the slot's type. The content's refs read through it, so `{{manager.name}}` reads `employee.manager.name`.
- A text slot takes text that may contain `{{refs}}`, such as `"{{steps.draft.output}}"`.

The planner prefers templates to writing text itself or adding an agent step to write it, and uses a `match` when the right template depends on the subject.

When a run starts, `expandTemplates` replaces each use with the inputs its content fills, so the run's workflow carries plain text and replays the same wording after a template changes. Editing a template changes the runs that start afterwards. If a template a saved workflow uses is deleted, or no longer fits it, the next run is recorded as `failed` with the problems instead of starting.

`migrations/0003_templates.sql` creates `engineering_welcome_email` and `welcome_email`, which welcomes any new hire.

| Endpoint                               | Purpose                                          |
| -------------------------------------- | ------------------------------------------------ |
| `GET /api/templates`                   | List templates                                   |
| `GET /api/templates/:name`             | Read one template                                |
| `PUT /api/templates/:name`             | Create or replace a template once it checks      |
| `DELETE /api/templates/:name`          | Delete a template                                |
| `GET /api/templates/:name/automations` | Automations whose saved workflow or draft use it |

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

A step that didn't run records nothing, so `{ "ref": "steps.<id>", "op": "exists" }` tests whether it ran. Unlike a ref that reads a value, it doesn't make the step that holds it skip.

A comparison between mismatched types is false. Conditions never call a model; use `decide` for judgment calls. An `if` step reads the current time once, in an Activity, so a replay gets the same answer.

## Run state and execution

A run executes the saved workflow with its templates expanded. It starts with `{ "runId", "subject": { "type", "id", "data" } | null, "steps": {} }`, and each step adds its record under `steps.<id>`. The subject is a snapshot taken when the run starts; refs through `ref` fields load the current version when the step runs.

`RunAutomation` maps the tree onto `effect/workflow` primitives:

| Kind                        | Primitive                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Every step's refs           | An Activity named `<id>/refs`.                                                                                                 |
| `agent`, `action`, `decide` | An Activity, retried twice. A replay reuses its result.                                                                        |
| `action` that asks first    | Before that, an Activity `<id>/approval-request` opens the task, and a `DurableDeferred` `<id>/approval` waits for the answer. |
| `stop`                      | Fails the execution with `RunStopped`, which interrupts every branch.                                                          |
| `wait`                      | A `DurableClock`. The current time is an Activity.                                                                             |
| `human`                     | A `DurableDeferred`, raced against a `DurableClock` when it has a timeout.                                                     |
| `parallel`, `if`, `match`   | Plain control flow, evaluated again on every replay.                                                                           |

The engine in `src/workflow/durable-engine.ts` journals payloads, Activity results, deferred completions, and clock times in the Automation object's storage under `wf:<executionId>:…`. It never keeps a run in memory between events: each `advance` callback replays the run from the start, reusing everything journaled, until it completes or reaches a clock or a person. A `clock` callback fires each durable clock at its time, and answering a task completes its deferred. Both schedule another replay.

Before a step runs, the interpreter checks the steps it needs a value from: those its refs read, except through `exists` checks. If one of them didn't run, because it was declined or skipped, the step is `skipped` without resolving anything. The checker guarantees every step a ref names finishes on every path before the reader, so a missing record always means a step that didn't run.

As it goes, the interpreter reports each step as `running`, `waiting`, `done` (with its record), `declined`, or `skipped`. That fills in the run's `steps` and `tasks` (`GET /api/automations/:id/runs/:runId`). A run's status is `running`, `waiting` (on a clock or a person), `completed`, `failed` with an `error`, or `stopped` with a `stopReason`. When a run ends, its open tasks close.
