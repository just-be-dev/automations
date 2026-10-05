# Workflow DSL

An automation is a JSON `Workflow`: a name, an optional trigger event, and a tree of steps. The designer agent writes it, and runs execute the saved copy. The schema lives in `src/workflow.ts` and the designer's prompt in `src/design.ts`. The interpreter is `src/interpreter.ts`.

```json
{
  "name": "Onboard a new hire",
  "event": "hire.created",
  "steps": [
    {
      "id": "welcome",
      "title": "Draft welcome for {{new_hire_name}}",
      "kind": "agent",
      "instruction": "Write a welcome email for {{new_hire_name}}, who starts on {{start_date}}."
    },
    {
      "id": "approve",
      "title": "Manager approves",
      "kind": "human",
      "prompt": "Send this welcome to {{new_hire_name}}?",
      "assignee": "{{manager_email}}",
      "response": "approval",
      "timeout": "2 days"
    },
    {
      "id": "check",
      "title": "Approved?",
      "kind": "if",
      "cases": [
        {
          "when": { "ref": "steps.approve.approved", "op": "equals", "value": true },
          "steps": [
            {
              "id": "notify",
              "title": "Notify HR",
              "kind": "webhook",
              "url": "https://hr.example.com/hooks/welcome"
            }
          ]
        }
      ]
    },
    {
      "id": "before-start",
      "title": "A week before day one",
      "kind": "wait",
      "until": "input.start_date",
      "offset": "-7 days"
    }
  ]
}
```

## Workflow

| Field   | Meaning                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| `name`  | Non-blank, at most 120 characters.                                                                         |
| `event` | `null` for manual starts, or an identifier (`[a-zA-Z0-9_.-]{1,80}`) that `POST /events/:event` must match. |
| `steps` | 1–20 top-level steps. Each list runs in order.                                                             |

Rules for the whole tree:

- At most 60 steps in total, nested steps included.
- Steps nest at most 4 levels deep.
- Step IDs are unique across the whole tree.
- Every `steps.<id>` reference names a step that exists. The schema doesn't check that the step runs earlier.

## Steps

Every step has an `id` (`[a-zA-Z0-9_-]{1,40}`), a `title` (non-blank, up to 120 characters), and a `kind`. The kinds:

### `agent`

```json
{ "kind": "agent", "instruction": "..." }
```

An AI agent carries out the instruction, which can be up to 4000 characters. Records `{ "output": string }`.

### `webhook`

```json
{ "kind": "webhook", "url": "https://..." }
```

POSTs the run so far to the URL. This is the SSRF boundary: the URL must be HTTPS, carry no username or password, and not target `localhost`, `127.*`, `10.*`, `192.168.*`, `169.254.*`, or `172.16–31.*`. Delivery is at least once, so receivers must be idempotent. Records `{ "output": string }`, the response body.

### `wait` (for a duration)

```json
{ "kind": "wait", "duration": "3 days" }
```

Sleeps on a durable clock. A duration is `<1–4 digits> minute|hour|day|week`, with an optional plural `s`. Records nothing.

### `wait` (until a date)

```json
{ "kind": "wait", "until": "input.start_date", "offset": "-7 days" }
```

Sleeps until the date at the `until` ref, shifted by the optional `offset`. An offset is a duration that may be negative. The value must be a string that `Date.parse` accepts, or the step fails. If the target time has already passed, the run continues at once. Records nothing.

### `parallel`

```json
{ "kind": "parallel", "branches": [[Step, ...], [Step, ...]] }
```

Has 2–8 branches of 1–20 steps each. They run concurrently, and the run continues once all of them finish. What each branch records is merged into the run state. Records nothing under its own ID.

### `if`

```json
{ "kind": "if", "cases": [{ "when": Condition, "steps": [Step, ...] }], "otherwise": [Step, ...] }
```

Runs the steps of the first of its 1–8 cases whose condition holds. If none holds, it runs `otherwise`, which is optional. Records `{ "matched": index | null }`.

### `decide`

```json
{ "kind": "decide", "model": "clef-flash", "question": "...",
  "options": [{ "id": "...", "description": "...", "steps": [Step, ...] }] }
```

A decision model reads the run state, picks one of 2–8 options, and the run continues with that option's steps.

- `model` is `clef-flash` (simple routing), `clef` (nuanced calls), or `jev`. The schema accepts `jev`, but the designer is never told about it.
- `question` is up to 2000 characters.
- Option IDs follow the step ID pattern and are unique within the step. Each `description` is up to 500 characters.

Records `{ "choice": optionId, "confidence": number, "probabilities": { optionId: number } }`. The step fails if the model names an option that doesn't exist.

### `human`

```json
{ "kind": "human", "prompt": "...", "assignee": "...", "timeout": "2 days",
  "response": "approval" | { "fields": [{ "name": "snake_case", "label": "...", "type": "text" }] } }
```

Pauses the run until a person responds.

- `prompt` is up to 4000 characters.
- `assignee` is optional, up to 200 characters.
- `response` is `"approval"` (approve or reject) or a form of at least one field. Field types are `text`, `number`, `boolean`, and `date`.
- `timeout` is an optional duration. When it passes first, the step finishes with `timedOut: true`.

Records `{ "approved"?: boolean, "values"?: { field: JSON }, "respondedBy"?: string, "timedOut": boolean }`.

## Refs

A ref is a dotted path into the run state, with 1–4 segments after the root:

- `input.<field>…` reads the run input.
- `steps.<id>.<field>…` reads what an earlier step recorded, for example `steps.approve.approved`, `steps.route.choice`, or `steps.form.values.amount`.

A bare name such as `start_date` or `{{start_date}}` decodes as `input.start_date`. Refs appear in `wait.until` and in conditions.

## Conditions

```json
{ "ref": Ref, "op": "equals" | "notEquals" | "greaterThan" | "lessThan" | "contains", "value": JSON }
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
| `exists`                   | The value is neither missing nor `null`.                                |

A comparison between mismatched types is false. Conditions are deterministic and never call a model. Use `decide` for judgment calls.

## Variables

A `{{snake_case}}` placeholder in a `title`, `instruction`, `question`, `prompt`, or `assignee` names a field of the run input. The studio collects them (`workflowVariables`) to show what a run needs. When a placeholder is filled (`renderTemplate`), strings are inserted as-is, other JSON is stringified, and fields the input lacks stay as written. Placeholders read only the run input, never step results.

## Run state and execution

A run starts with `{ "input": <start payload>, "steps": {} }`, and each step adds its record under `steps.<id>`. `RunAutomation` maps the tree onto `effect/workflow` primitives:

| Kind                         | Primitive                                                                  |
| ---------------------------- | -------------------------------------------------------------------------- |
| `agent`, `webhook`, `decide` | An Activity, retried twice. A replay reuses its result.                    |
| `wait`                       | A `DurableClock`. `until` reads the current time in an Activity.           |
| `human`                      | A `DurableDeferred`, raced against a `DurableClock` when it has a timeout. |
| `parallel`, `if`             | Plain control flow, evaluated again on every replay.                       |

## What runs today

The `Automation` Durable Object doesn't use `RunAutomation` yet. Its own runner executes only workflows whose steps are all top-level `agent` and `webhook` steps. `start` rejects anything else with "Runs can't execute … steps yet". In that runner:

- An agent step gets its instruction, the run input, and earlier results as one prompt. `{{variables}}` aren't substituted, but the agent sees the input beside them.
- A webhook step POSTs `{ "input", "results" }`, times out after 30 seconds, and fails on a non-2xx status. The response body is kept up to 4000 characters.
