/** Hosts effect-channels: the public Slack webhook Worker and one mailbox Durable Object per Slack thread. */
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { ChannelsCloudflare, DeliveryMailboxes } from "@humanlayer/channels-alchemy-cloudflare";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { slackProvider } from "../../channels/slack.ts";
import { EventsQueue } from "./events.ts";

/**
 * The webhook Worker verifies and admits each Slack event into its thread's mailbox, a Durable
 * Object that stores it and runs the callbacks in `src/channels/slack.ts` from its alarm. Those
 * callbacks publish to the Events queue, which the private Api consumes like any other event.
 *
 * Slack must reach the webhook, so this Worker is public and outside Access. It serves only the
 * provider routes, which reject requests without a valid Slack signature, and not the delivery
 * API, because nothing hands deliveries off.
 */
export const channels = ChannelsCloudflare.make({
  // Persisted in every mailbox admission; changing it orphans waiting events.
  namespace: "automations",
  providers: [slackProvider],
  eventProcessing: { concurrency: 1, maxAttempts: 10, leaseMs: 30_000 },
});

/** One per Slack thread, keyed by its channels mailbox key. Its alarm belongs to channels. */
export class ChannelMailbox extends Cloudflare.DurableObject<ChannelMailbox>()(
  "ChannelMailbox",
  Effect.gen(function* () {
    const events = yield* EventsQueue;
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      // The publisher captures this instance's RuntimeContext, so build it per instance. The
      // mailbox's outer phase takes the services its callbacks need; its inner phase opens storage.
      const mailbox = yield* channels
        .mailbox({ rearmAfterMs: 1_000 })
        .pipe(Effect.provide(Layer.merge(events, BrowserCrypto.layer)));
      return yield* mailbox;
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
) {}

/** Serves `POST /integrations/slack/webhook`. Deployed only when Slack is configured (see stack). */
export default class Channels extends Cloudflare.Worker<Channels>()(
  "Channels",
  {
    main: import.meta.url,
    compatibility: { date: "2026-10-04" },
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
    },
  },
  Effect.gen(function* () {
    const mailboxes = yield* ChannelMailbox;
    // Building the routes reads SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN during Init, which binds
    // them to this Worker as secrets; the mailboxes it hosts read the same bindings.
    const fetch = yield* ChannelsCloudflare.serve(
      channels.routes.pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(DeliveryMailboxes, mailboxes), BrowserCrypto.layer),
        ),
      ),
    );
    return { fetch };
  }).pipe(Effect.provide(Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }))),
) {}
