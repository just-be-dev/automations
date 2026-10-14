/** Hosts effect-channels and Slack interactivity: the public Slack webhook Worker and one mailbox Durable Object per Slack thread. */
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { ChannelsCloudflare, DeliveryMailboxes } from "@humanlayer/channels-alchemy-cloudflare";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { slackProvider } from "../../channels/slack.ts";
import { slackInteractivityRoutes } from "../../channels/slack-interactivity.ts";
import { EventsQueue } from "./events.ts";
import { SlackActionsQueue } from "./slack-actions.ts";

/**
 * The webhook Worker verifies and admits each Slack event into its thread's mailbox, a Durable
 * Object that stores it and runs the callbacks in `src/channels/slack.ts` from its alarm. Those
 * callbacks publish to the Events queue, which the private Api consumes like any other event.
 *
 * The same Worker takes Slack's interactivity requests: clicks on an approval task's Approve and
 * Reject buttons, which it queues for the Api to decide (`src/channels/slack-interactivity.ts`).
 *
 * Slack must reach both, so this Worker is public and outside Access. It serves only these two
 * routes, which reject requests without a valid Slack signature, and not the delivery API,
 * because nothing hands deliveries off.
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

/**
 * Serves `POST /integrations/slack/webhook` and `POST /integrations/slack/interactivity`.
 * Deployed only when Slack is configured (see stack).
 */
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
    const actions = yield* SlackActionsQueue;
    // Building the routes reads SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN during Init, which binds
    // them to this Worker as secrets; the mailboxes it hosts read the same bindings.
    const signingSecret = yield* Config.Redacted("SLACK_SIGNING_SECRET");
    const fetch = yield* ChannelsCloudflare.serve(
      Layer.merge(
        channels.routes.pipe(
          Layer.provide(
            Layer.merge(Layer.succeed(DeliveryMailboxes, mailboxes), BrowserCrypto.layer),
          ),
        ),
        slackInteractivityRoutes(signingSecret),
      ),
    );
    // The queue writer captures the request's RuntimeContext, so build it per request.
    return { fetch: fetch.pipe(Effect.provide(actions)) };
  }).pipe(
    Effect.provide(
      Layer.merge(
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
) {}
