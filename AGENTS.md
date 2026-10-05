# Automations studio

A single-tenant prototype on Cloudflare: you design sequential automations in a chat, then run them in a Durable Object. Setup, deploy steps, and the HTTP API are in `README.md`. UI rules are in `src/ui/AGENTS.md`.

## Layout

- `alchemy.run.ts`: the Alchemy 2 Stack. It declares the `Studio` Foldkit website, which carries Cloudflare Access and the test service token, and exports `StudioEnv`.
- `src/api.ts`: the Effect-native `Api` Worker. It holds the `HttpRouter` routes under `/api/automations` and has no public URL (`workersDev: false`).
- `src/automation.ts`: the `Automation` Durable Object. It stores the draft and saved workflow and the chat transcript, keeps the runs, and drives step execution with `Alchemy.makeCallback`.
- `src/automation-index.ts`: the `AutomationsDatabase` D1 database and its queries. Cloudflare can't enumerate Durable Object names, so `Api` records each automation in the `automations` table on chat and save, and when an existing automation is opened. It backs `GET /api/automations`. Each automation's data stays in its Durable Object; the table only lists them.
- `migrations/`: D1 migrations, applied in numeric order on deploy and under `alchemy dev`.
- `src/workflow.ts`: the pure domain code. It holds the Schema models (`Workflow`, `Step`, `Run`), the decoders, and `graph`.
- `src/pi.ts` and `src/pi-storage.ts`: pi-durable and pi-ai running inside the Durable Object, with pi's tables stored in the object's SQLite.
- `src/edge.ts`: the Studio Worker's async entry. It only forwards `/api/*` to `Api`. Keep logic out of it.
- `src/ui/`: the Foldkit browser app. `public/_headers` sets the CSP for static assets.

## Verify before finishing

```sh
bun run typecheck && bun run lint && bun run test && bun run format:check
```

- Tests use `bun:test` and sit next to the code they cover. Run Effects with `Effect.runSync` or `Effect.runPromise`.
- Worker and Durable Object behavior can only be tested end to end. Run `mise run dev` and call `/api/automations/...` on the Studio URL it prints. Chat and agent steps call Workers AI for real.

## Debugging a user's automation

The UI keeps the open automation in the URL (`/?automation=<id>`). When a user shares that URL from `mise run dev`, read the automation over the local API. Dev mode skips Access, so no credentials are needed:

```sh
curl -s "$STUDIO_URL/api/automations"                    # every automation with a draft
curl -s "$STUDIO_URL/api/automations/<id>"               # draft, saved, graph, conversation
curl -s "$STUDIO_URL/api/automations/<id>/runs/<runId>"  # one run; the UI shows the run ID
```

Stick to these `GET` routes unless the user asks for more. `chat` calls Workers AI and replaces the draft, and `save` and `start` change what runs.

## Effect

- Before writing Effect code, run `bunx effect-solutions list`, then `bunx effect-solutions show <topic>` for the patterns you need.
- Import from bare modules, e.g. `import * as Effect from "effect/Effect"`.
- New Worker and Durable Object code is Effect-native.
  - Decode every boundary with Schema: request bodies, path params, LLM output, and values read back from storage.
  - Model expected failures with `Schema.TaggedError`.
  - Name operations with `Effect.fn("Module.operation")`.
- Durable Object RPC errors reach the Worker as plain objects. Map them structurally (see `messageOf` in `src/api.ts`); don't use `instanceof`.
- pi-ai and pi-durable stay on purpose even though they are Promise-based. Wrap them in `src/pi.ts` with `Effect.tryPromise` and `PiError`. Don't swap them for Effect AI.

## Alchemy 2

- Alchemy 2 is a beta Effect API, and the v1 (`await alchemy(...)`) docs don't apply.
  - Docs index: https://alchemy.run/llms.txt (append `.md` to a page URL to get markdown).
  - The installed source in `node_modules/alchemy/src` is the final reference.
- Each Worker and Durable Object has two phases:
  - The outer Effect runs at plan time and at cold start. Keep it to binding calls such as `yield* Automation` and `Cloudflare.Workers.AI()`.
  - The inner Effect or handler runs per instance or per request. Storage, the AI binding's `raw`, and callbacks are only usable there.
- Plan time imports `alchemy.run.ts` and everything it reaches under Bun. Never import a module that loads `cloudflare:*` at top level. This is why `src/pi-storage.ts` replaces `agents/harness/pi`.
- `Alchemy.makeCallback` delivers at least once. Keep handlers idempotent:
  - Agent steps reuse the pi `requestId` `${runId}:${stepId}`, and their conversation id is saved on the run before submitting.
  - Callback names (`advance`) and payload shapes are persisted contracts. Keep them compatible.
- Storage keys are persisted contracts too: `draft`, `saved`, `run:<id>`, `exchange:<000000>`, and `exchangeCount` in `Automation`.
- Never edit an applied D1 migration. Add the next numbered file in `migrations/` instead; Alchemy tracks applied files by hash in `__alchemy_migrations`.

## Invariants

- The Schema filters in `src/workflow.ts` are the SSRF boundary. Webhooks must be HTTPS, carry no credentials, and target no private or loopback host. Don't loosen them without tests.
- Runs always execute the saved snapshot, never the draft. Workflows must not contain secrets.
- Webhook POSTs don't forward trace headers.
- `/api` keeps a 32 KB request-body limit and returns `{ "error": string }` on failure. The UI relies on that shape.
- `Api` stays private. Only the Access-protected Studio Worker can reach it.

## Deploy and dependencies

- Never run `alchemy deploy`, `alchemy destroy`, or `alchemy dev --stage <deployed stage>` unless asked.
- `alchemy dev` runs locally on stage `dev_$USER`, skips Access, and still needs a Cloudflare profile for Workers AI.
- Never commit `.alchemy/` or Access service-token secrets.
- Foldkit, `@foldkit/*`, Vite, and `@effect/platform-*` are pinned exactly on purpose. To upgrade Foldkit, follow `src/ui/AGENTS.md`.
