# Automations studio

This project is an experiment in exploring how to make repeatable, agent driven automations a transparent and trustworthy process. I've taken some opinionated technology decisions (like the usage of the [cafe stack](https://github.com/just-be-dev/cafe-stack)). That said, this is _not_ a production quality codebase and not all of the decisions herein should be considered a representation of how I would build software.

## Build repeatable automations through conversation

1. Describe a process you'd like to automate to the platform's assistant, in the drawer beside every app, and watch while it builds you a workflow.
2. Review what permissions it would need, what services it touches, and what actions would be taken. Iterate on it as needed.
3. Start by hand, react to a record changing, run on a schedule, or start relative to a date. Watch each run’s results and answer its open tasks in the studio.

## The Demo Scenario

The workflow starts with a request like this:

> Can you set up onboarding for new hires? They should get a welcome email and 30 minutes with their manager. Three days after they start, ask the manager how it's going.

Then refine it:

> I want to check the email before it goes out. Send the manager a heads-up on Slack too. For the check-in, ask who their buddy is, what they're working on, and whether they need any help.

It finds a welcome slot and gives the manager a heads-up **in parallel**. It chooses approved email wording based on the hire’s role, pauses for **someone to review the exact email**, and books a manager welcome. Three days after the start date, it asks the manager to record the onboarding buddy, first project, and any help the hire needs.

The [example workflow](docs/examples/first-week.json) uses the sample employee type and welcome templates that `mise run demo:reset` creates. Choose an employee with a start date and manager to try it. The screenshot below is a live model's draft from these two requests, so it differs in places from the example; see the [demo details](docs/development.md#readme-demo). `mise run demo:reset` prepares a local studio for the live demo; see [Live demo](docs/development.md#live-demo).

![The studio agent drafting and then refining a new-hire onboarding automation, beside the rendered draft: a welcome email chosen by role, a manager meeting, and a Slack heads-up running in parallel, a three-day wait, and a check-in form for the manager. Steps the last reply added or changed are marked.](docs/images/first-week.png)

_Both requests sent to the studio's former built-in agent in a local studio; the platform's assistant now takes them. The draft marks what the second reply added or changed. Calendar is simulated, and Email and Slack are too unless you connect them._

## Workflows with people in the loop

- **Branch, decide, and work in parallel.** Combine connection operations, AI steps, conditions, waits, and requests to people in one readable plan.
- **Reuse approved wording.** Templates keep standard messages consistent while filling in the right details for each record. New runs pick up template edits; runs already going keep their original wording.
- **Ask before acting.** An approval task shows what an operation will send and who can approve it. Human steps can also collect structured answers, not just a yes or no.
- **Keep track of the whole process.** The overview shows runs in flight and how each automation last went. Open a run beside the workflow to review results or answer a task without leaving your draft.
- **Get help across the platform.** The platform's assistant, in the hub shell's drawer, reads automations, runs and records, changes records and templates, and hands workflow design to the planner, all through the studio's MCP tools. It asks you to approve each change before making it, and it never saves or runs workflows for you.

## Prototype status

This is a **single-tenant prototype**, not a production-ready service. It runs on Cloudflare and supports long-lived workflows that pause for days or for a person’s response. The records automations act on, and their types, live in a separate service, entity-store, which automations reads and writes over a service binding; every change to them, wherever it’s made, can start automations.

Calendar currently **simulates its operations**: it records what would happen but contacts nobody. Email is simulated too until you [set a sender on a domain onboarded to Cloudflare Email Service](docs/email.md), and Slack until you [connect a workspace](docs/slack.md), which lets automations post messages and start from mentions. Human tasks reach people only as Slack DMs, once Slack is connected; otherwise their notifications are recorded rather than sent. HTTP webhooks make real requests. Do not put secrets in workflow definitions. Production use needs further security review; see the [operational caveats](docs/development.md#caveats).

## Development

[mise](https://mise.jdx.dev) installs the pinned tools and exposes the project’s tasks:

```sh
mise trust
mise install
mise run dev
```

Local development needs a Cloudflare profile for Workers AI, and runs a local stand-in for entity-store ([details](docs/development.md#entity-store-under-alchemy-dev)). The [development guide](docs/development.md#local-development) covers credentials and setup; `mise run dev` prints the studio address.

```sh
mise run typecheck
mise run lint
mise run test
mise run format-check
mise run eval planner --trials 3
mise run check                      # all checks, including real-model evals
```

- [Architecture](ARCHITECTURE.md) — components, storage, the design-to-run lifecycle, and the principles behind them.
- [Development and operations](docs/development.md) — setup, deployment with `mise run deploy`, evals, debugging, and the HTTP/MCP interfaces.
- [Workflow DSL](docs/workflow-dsl.md) — triggers, steps, references, templates, and permissions.
- [Workflow engine](docs/workflow-engine.md) — diagrams of how agents generate a workflow and how runs execute it.

## Inspiration

- [Callscript](https://github.com/vercel-labs/callscript): turn model output into an inert, validated plan rather than execute it as code.
- [JEXL](https://github.com/just-be-dev/jexl): a programming language whose syntax is pure JSON.
- [Forma](https://forma-lang.com/): schemas, APIs, and policies expressed through one language.
