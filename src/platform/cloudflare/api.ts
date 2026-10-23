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
import { Namer } from "../../agents/namer/namer.ts";
import { LiveConnections } from "../../connections/live.ts";
import { LocalDevelopment } from "../../automation/local-development.ts";
import { Automations } from "../../automation/service.ts";
import { deliverEntityChange } from "../../entities/change-feed.ts";
import { EntitySubscribers } from "../../entities/subscribers.ts";
import { apiRoutes } from "../../http/api.ts";
import { handleMcp, type McpHeaders } from "../../http/mcp-server.ts";
import { accessIdentity } from "./access.ts";
import { localDevelopment } from "./local-development.ts";
import Automation from "./automation.ts";
import { automationsLayer } from "./automations.ts";
import { AutomationIndexD1 } from "./automation-index-d1.ts";
import { EntityStoreChangesQueue, EntityStoreLive } from "./entity-store.ts";
import { workersAiNamer } from "./workers-ai.ts";
import ChangeCoordinator, { changesLayer } from "./changes.ts";
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
    const changeNamespace = yield* ChangeCoordinator;
    const ai = yield* Cloudflare.Workers.AI();
    const index = yield* AutomationIndexD1;
    const entities = yield* EntityStoreLive;
    const events = yield* EventsQueue;
    // The Automation objects this Worker hosts send with the same credentials; see automation.ts.
    const slackToken = yield* Config.option(Config.Redacted("SLACK_BOT_TOKEN")).pipe(Effect.orDie);
    const emailFrom = yield* Config.option(Config.String("EMAIL_FROM")).pipe(Effect.orDie);
    const live = [
      ...(Option.isSome(emailFrom) ? ["email"] : []),
      ...(Option.isSome(slackToken) ? ["slack"] : []),
    ];
    // Development-only routes refuse unless this is `alchemy dev` on a dev_ stage.
    const local = yield* localDevelopment;
    // Who you are in a local studio, where Access is off. Never read on a deployed stage.
    const devUser = local
      ? yield* Config.option(Config.String("DEV_USER_EMAIL")).pipe(Effect.orDie)
      : Option.none<string>();
    const localUser = devUser.pipe(
      Option.map((email) => email.trim()),
      Option.filter((email) => email !== ""),
    );
    if (Option.isSome(localUser) && !/^[^\s@]+@[^\s@]+$/.test(localUser.value)) {
      return yield* Effect.die(`DEV_USER_EMAIL must be an email address, not ${localUser.value}`);
    }
    const automations = automationsLayer(namespace);
    const subscribers = Layer.unwrap(
      Automations.use((service) =>
        Effect.succeed(
          EntitySubscribers.layer((id, change, key, event) =>
            service
              .get(id)
              .entityChanged(change.before, change.after, key, event, change.committedAt),
          ),
        ),
      ),
    ).pipe(Layer.provideMerge(Layer.merge(entities, automations)));
    const namer = Layer.effect(Namer, Effect.map(ai.raw, workersAiNamer));
    // Everything a request's handlers use, except who the request acts for.
    const shared = Layer.mergeAll(
      index,
      events,
      entities,
      automations,
      namer,
      changesLayer(changeNamespace),
      Layer.succeed(LiveConnections, live),
      Layer.succeed(LocalDevelopment, local),
    );
    const services = Layer.merge(shared, accessIdentity(localUser));
    // Consumer settings are plan-time only; Stage is not a service in the Worker runtime.
    const deadLetterQueue = globalThis.__ALCHEMY_RUNTIME__
      ? undefined
      : yield* Effect.gen(function* () {
          yield* FailedEventQueue;
          return yield* failedEventQueueName;
        });
    // A failed message retries; delivering one again starts nothing twice, since every recipient
    // keeps receipts keyed by the event or change it was given.
    const deliveries = {
      batchSize: 10,
      maxRetries: 10,
      retryDelay: "30 seconds",
      deadLetterQueue,
    } as const;
    const deliver = <E, R>(
      kind: string,
      message: { readonly id: string; readonly ack: () => void; readonly retry: () => void },
      delivery: Effect.Effect<void, E, R>,
    ) =>
      delivery.pipe(
        Effect.andThen(Effect.sync(() => message.ack())),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(`${kind} delivery failed`, cause).pipe(
              Effect.annotateLogs("queueMessageId", message.id),
            );
            yield* Effect.sync(() => message.retry());
          }),
        ),
      );
    yield* Cloudflare.Queues.consumeQueueMessages(yield* EventQueue, deliveries, (stream) =>
      Stream.runForEach(stream, (message) =>
        deliver(
          "Event",
          message,
          Effect.gen(function* () {
            const runtime = yield* Alchemy.RuntimeContext;
            yield* deliverEvent(message.body, (event) =>
              changeNamespace
                .getByName("studio")
                .applyEvent(event)
                .pipe(Effect.provideService(Alchemy.RuntimeContext, runtime)),
            ).pipe(Effect.provide(Layer.merge(index, automations)));
          }),
        ),
      ),
    );
    // entity-store's committed writes, whoever made them: lifecycle events and entity triggers.
    yield* Cloudflare.Queues.consumeQueueMessages(
      yield* EntityStoreChangesQueue(local),
      deliveries,
      (stream) =>
        Stream.runForEach(stream, (message) =>
          deliver(
            "Entity change",
            message,
            deliverEntityChange(message.body).pipe(
              Effect.provide(Layer.merge(subscribers, events)),
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
    return {
      // RuntimeContext and request headers exist only when this returned effect handles a request.
      fetch: handler.pipe(Effect.provide(services)),
      /**
       * The studio's MCP server over RPC, for other stacks that bind this Worker (the hub's
       * assistant). Holding the binding is the authorization: RPC methods aren't routed over
       * HTTP. The call acts for the person `cf-access-authenticated-user-email` names.
       */
      mcp: (body: unknown, headers: McpHeaders) =>
        handleMcp(body, headers ?? {}).pipe(Effect.provide(shared), Effect.withSpan("Api.mcp")),
    };
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
