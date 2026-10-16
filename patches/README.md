# Dependency patches

Bun applies these patches on install through `patchedDependencies` in `package.json`. Each patch is tied to an exact version. When you upgrade a patched package, check whether upstream fixed the problem. Then either drop the patch or recreate it with `bun patch <pkg>` and `bun patch --commit node_modules/<pkg>`, and update this file.

Every patch needs an entry here. Inside the patched code, mark the change with a `PATCH(automations)` comment.

## Foldkit DevTools MCP reconnect loop under `alchemy dev`

Patches `@foldkit/vite-plugin@0.27.1` and `@foldkit/devtools-mcp@0.24.1`. Rechecked against `alchemy@2.0.0-beta.83`: neither upstream fix has landed.

**Symptom.** Under `alchemy dev`, every agent session's Foldkit DevTools MCP server connected to the relay and disconnected many times per second. The MCP tools were unusable, and the dev server log filled with `MCP client connected` and `MCP client disconnected` lines.

**Cause.** Two upstream behaviors combine:

1. `@foldkit/vite-plugin` hosts its MCP relay at `/__foldkit/devtools-mcp` on Vite's own `httpServer`. Alchemy's Cloudflare Vite integration (`handleWebSocket` in `@alchemy.run/cloudflare-runtime`, `src/vite/websockets.ts`) adds its own `upgrade` listener to the same server. That listener forwards every upgrade whose `sec-websocket-protocol` doesn't start with `vite` to workerd. The worker answers with a non-101 response, which Alchemy writes onto the socket Foldkit has already accepted and then closes it. Before beta.82 Alchemy destroyed the socket instead; the result is the same. The client sees the connection open and then close with code 1006 about 20 ms later.
2. `@foldkit/devtools-mcp` only backs off when an open fails. When a socket opens and then closes, it reconnects immediately, so (1) turns into a tight loop.

**Patches.**

- `@foldkit/vite-plugin`: `startMcpRelay` always uses `bindLoopbackRelay`, which is a token-protected listener on its own `127.0.0.1` port, published to the relay registry. The relay no longer attaches to Vite's `httpServer`, so Alchemy's upgrade listener never sees it. The fixed `devToolsMcpPort` path is unchanged.
- `@foldkit/devtools-mcp`: in `webSocketClient.js`, a connection that closes within 5 seconds of opening counts as a failure. Reconnects then back off exponentially, from 0.5 s up to 30 s. A connection that stays up longer resets the backoff.

**Remove when** either fix lands upstream and the dev server log shows one stable `MCP client connected` per MCP server under `alchemy dev`:

- Foldkit hosts the relay on a dedicated loopback listener, or otherwise keeps it away from other upgrade handlers, and backs off reconnects after short-lived connections.
- Alchemy's `handleWebSocket` stops forwarding upgrades that another listener has already handled, or only forwards paths the worker serves.

The backoff patch is worth keeping until Foldkit has its own backoff. It stops the loop whatever the cause of the drop.

## pi-ai gives up on Unified Billing's rate limit

Patches `@earendil-works/pi-ai@1.0.4`.

**Symptom.** With Claude through AI Gateway, paid by Cloudflare Unified Billing, a turn failed at once with `Agent did not answer: model_error (Unified billing rate limited)` whenever a few calls ran together, such as eval trials in parallel. pi never retried it.

**Cause.** pi-durable retries a failed model call only when pi-ai's `isRetryableAssistantError` (`dist/utils/retry.js`) says so. That function checks a list of quota and billing phrases first, so that an exhausted balance isn't retried, and one of them is `billing`. Unified Billing's throttle message contains "billing", so it matched as exhausted quota before the `rate.?limit` pattern that would have retried it.

**Patch.** `isRetryableAssistantError` treats a message matching `unified billing rate limited` as retryable before it checks the quota phrases. Every other message is classified as before, so real quota and billing errors still aren't retried.

Claude calls now authenticate with the Anthropic key stored on the `default` gateway (BYOK), so they reach Unified Billing only if that key is missing or not under the `default` alias. The patch stays as a guard for that fallback.

**Remove when** pi-ai classifies Unified Billing's rate limit as retryable, or Cloudflare words it without "billing". Check by running `mise run eval assistant --trials 3 --concurrency 8` with the planner model on Claude: no trial should fail with `Unified billing rate limited`.
