/** Hosts the private API Worker and supplies request-scoped application services and authenticated identity. */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { deliverEvent } from "../../events/delivery.ts";
import {
  decideFromSlack,
  SlackTaskAction,
  SlackWorkspace,
} from "../../channels/slack-approvals.ts";
import { makeSlackWebWorkspace } from "../../channels/slack-workspace.ts";
import { AutomationNamer } from "../../agents/namer/namer.ts";
import { LiveConnections } from "../../connections/live.ts";
import { Automations } from "../../automation/service.ts";
import { EntitySubscribers } from "../../entities/subscribers.ts";
import { apiRoutes } from "../../http/api.ts";
import { accessIdentity } from "./access.ts";
import Automation from "./automation.ts";
import { automationsLayer } from "./automations.ts";
import { AutomationIndexD1 } from "./automation-index-d1.ts";
import { EntityStoreD1 } from "./entity-store-d1.ts";
import { workersAiNamer } from "./workers-ai.ts";
import StudioAssistant, { assistantsLayer } from "./assistant.ts";
import ChangeCoordinator, { changesLayer } from "./changes.ts";
import { Transcription } from "../../http/transcription.ts";
import { workersAiTranscription } from "./transcription.ts";
import { EventQueue, EventsQueue, FailedEventQueue, failedEventQueueName } from "./events.ts";
import { SlackActionQueue } from "./slack-actions.ts";

/** Only the Access-protected Studio Worker can reach this private API. */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    compatibility: { date: "2026-10-04" },
    workersDev: false,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
    },
  },
  Effect.gen(function* () {
    const namespace = yield* Automation;
    const assistantNamespace = yield* StudioAssistant;
    const changeNamespace = yield* ChangeCoordinator;
    const ai = yield* Cloudflare.Workers.AI();
    const index = yield* AutomationIndexD1;
    const entities = yield* EntityStoreD1;
    const events = yield* EventsQueue;
    // The Automation objects this Worker hosts send with the same credentials; see automation.ts.
    const slackToken = yield* Config.option(Config.Redacted("SLACK_BOT_TOKEN")).pipe(Effect.orDie);
    const resendKey = yield* Config.option(Config.Redacted("RESEND_API_KEY")).pipe(Effect.orDie);
    const live = [
      ...(Option.isSome(resendKey) ? ["email"] : []),
      ...(Option.isSome(slackToken) ? ["slack"] : []),
    ];
    const automations = automationsLayer(namespace);
    const subscribers = Layer.unwrap(
      Automations.use((service) =>
        Effect.succeed(
          EntitySubscribers.layer((id, change, key, event) =>
            service.get(id).entityChanged(change.before, change.after, key, event),
          ),
        ),
      ),
    ).pipe(Layer.provideMerge(Layer.merge(entities, automations)));
    const namer = Layer.effect(AutomationNamer, Effect.map(ai.raw, workersAiNamer));
    const services = Layer.mergeAll(
      index,
      events,
      subscribers,
      accessIdentity,
      namer,
      assistantsLayer(assistantNamespace),
      changesLayer(changeNamespace),
      Layer.effect(Transcription, Effect.map(ai.raw, workersAiTranscription)),
      Layer.succeed(LiveConnections, live),
    );
    // Consumer settings are plan-time only; Stage is not a service in the Worker runtime.
    const deadLetterQueue = globalThis.__ALCHEMY_RUNTIME__
      ? undefined
      : yield* Effect.gen(function* () {
          yield* FailedEventQueue;
          return yield* failedEventQueueName;
        });
    yield* Cloudflare.Queues.consumeQueueMessages(
      yield* EventQueue,
      {
        batchSize: 10,
        maxRetries: 10,
        retryDelay: "30 seconds",
        deadLetterQueue,
      },
      (stream) =>
        Stream.runForEach(stream, (message) =>
          Effect.gen(function* () {
            const runtime = yield* Alchemy.RuntimeContext;
            yield* deliverEvent(message.body, (event) =>
              changeNamespace
                .getByName("studio")
                .applyEvent(event)
                .pipe(Effect.provideService(Alchemy.RuntimeContext, runtime)),
            ).pipe(Effect.provide(Layer.merge(index, automations)));
            yield* Effect.sync(() => message.ack());
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("Event delivery failed", cause).pipe(
                  Effect.annotateLogs("queueMessageId", message.id),
                );
                yield* Effect.sync(() => message.retry());
              }),
            ),
          ),
        ),
    );
    // Approve and Reject clicks from Slack. Deciding is idempotent, so a retry repeats nothing.
    const slackWorkspace = Option.map(slackToken, (token) => makeSlackWebWorkspace(token));
    yield* Cloudflare.Queues.consumeQueueMessages(
      yield* SlackActionQueue,
      // One click per batch, so a full batch goes at once and the message updates promptly.
      { batchSize: 1, maxRetries: 3, retryDelay: "5 seconds" },
      (stream) =>
        Stream.runForEach(stream, (message) =>
          Effect.gen(function* () {
            const action = Schema.decodeUnknownOption(SlackTaskAction)(message.body);
            if (Option.isNone(action) || Option.isNone(slackWorkspace)) {
              // Neither can change on a retry: drop the click rather than retry it.
              yield* Effect.logWarning(
                Option.isNone(action)
                  ? "Dropped a Slack click that isn't a task action"
                  : "Dropped a Slack click: SLACK_BOT_TOKEN isn't set",
              );
            } else {
              yield* decideFromSlack(action.value).pipe(
                Effect.provide(automations),
                Effect.provideService(SlackWorkspace, slackWorkspace.value),
              );
            }
            yield* Effect.sync(() => message.ack());
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("Slack click failed", cause).pipe(
                  Effect.annotateLogs("queueMessageId", message.id),
                );
                yield* Effect.sync(() => message.retry());
              }),
            ),
          ),
        ),
    );
    const handler = yield* HttpRouter.toHttpEffect(apiRoutes);
    // RuntimeContext and request headers exist only when this returned effect handles a request.
    return { fetch: handler.pipe(Effect.provide(services)) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Workers.AIBinding,
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Queues.EventSourceLive,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
) {}
