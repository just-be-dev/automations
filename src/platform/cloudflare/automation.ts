/** Hosts one automation in a Durable Object, wiring storage, jobs, AI, and replay-compatible callbacks. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PiAgent } from "../../ai/pi.ts";
import { Classifier } from "../../ai/classifier.ts";
import { AnswerHub, makeAnswerHub } from "../../ai/ask-question/answer-hub.ts";
import { makeAutomation } from "../../automation/application.ts";
import { EmailSender } from "../../connections/email.ts";
import { makeSlackWebSender, SlackSender } from "../../connections/slack.ts";
import { AutomationHost, AutomationStorageError } from "../../automation/host.ts";
import { ConfiguredStudioOrigin, studioOrigin } from "../../automation/studio-link.ts";
import { LocalDevelopment } from "../../automation/local-development.ts";
import { makePlanning } from "../../automation/planning.ts";
import { ExecutionId } from "../../workflow/execution.ts";
import { AutomationIndexD1 } from "./automation-index-d1.ts";
import { EntityStoreLive } from "./entity-store.ts";
import { makeCloudflareEmailSender } from "./email.ts";
import { EventsQueue } from "./events.ts";
import { localDevelopment } from "./local-development.ts";
import { openPiAgent } from "./pi.ts";
import { openPiStorage } from "./pi-storage.ts";
import { PLANNER_MODEL, PLANNER_THINKING_LEVEL, workersAiClassifier } from "./workers-ai.ts";

// Callback names, payloads, and schedule keys are persisted contracts.
const PlanReply = Schema.Struct({ automationId: Schema.String, chatId: Schema.String });
const Advance = Schema.Struct({ executionId: ExecutionId });
const ClockFired = Schema.Struct({ executionId: ExecutionId, deferredName: Schema.String });
const Tick = Schema.Struct({ at: Schema.Finite });
/** The saved schedule has one pending occurrence at a time, under this job ID. */
const TICK_JOB = "schedule";

/** Why an erased automation resets its instance. The RPC client recognizes the reset by it. */
export const ERASED = "Automation erased";

/** Cloudflare hosts the application; business operations don't know about bindings or callbacks. */
export default class Automation extends Cloudflare.DurableObject<Automation>()(
  "AutomationAgent",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const ai = yield* Cloudflare.Workers.AI();
    const index = yield* AutomationIndexD1;
    const entities = yield* EntityStoreLive;
    const events = yield* EventsQueue;
    // Read during Init, so a deploy with the token binds it as a secret. Without it, Slack is simulated.
    const slackToken = yield* Config.option(Config.Redacted("SLACK_BOT_TOKEN")).pipe(Effect.orDie);
    // Where Slack task messages link to. Optional: without it, saves record the studio's origin.
    const configuredStudio = yield* Config.option(Config.String("STUDIO_URL")).pipe(Effect.orDie);
    const studio = Option.getOrUndefined(configuredStudio);
    const configuredOrigin = studio === undefined ? null : studioOrigin(studio);
    if (studio !== undefined && configuredOrigin === undefined) {
      return yield* Effect.die(`STUDIO_URL must be an http or https URL, not ${studio}`);
    }
    // With EMAIL_FROM, email sends through Cloudflare Email Service from that address, and only
    // from it; without it, email is simulated. Remote, so `alchemy dev` sends real email too.
    const emailFrom = yield* Config.option(Config.String("EMAIL_FROM")).pipe(Effect.orDie);
    const emailFromName = yield* Config.option(Config.String("EMAIL_FROM_NAME")).pipe(Effect.orDie);
    const emailBinding = Option.isSome(emailFrom)
      ? yield* Cloudflare.Email.Send(
          yield* Cloudflare.Email.SendEmail("Email", {
            allowedSenderAddresses: [emailFrom.value],
          }).pipe(Alchemy.remote()),
        )
      : undefined;
    // Development-only operations refuse unless this is `alchemy dev` on a dev_ stage.
    const local = yield* localDevelopment;

    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      const withRuntime = <A, E, R>(effect: Effect.Effect<A, E, R | Alchemy.RuntimeContext>) =>
        Effect.provideService(effect, Alchemy.RuntimeContext, runtime);
      const aiBinding = yield* ai.raw;

      const host = AutomationHost.of({
        storage: {
          get: (key) => withRuntime(state.storage.get(key)),
          put: (key, value) => withRuntime(state.storage.put(key, value)),
          delete: (key) => withRuntime(state.storage.delete(key)),
          list: (options) => withRuntime(state.storage.list(options)),
          transaction: (effect) =>
            withRuntime(state.storage.transaction(effect)).pipe(
              Effect.mapError((error) =>
                error instanceof Cloudflare.Workers.DurableObjectStorageError
                  ? new AutomationStorageError({ message: error.message })
                  : error,
              ),
            ),
        },
        // Closures are invoked after callback registration. Scheduling stays inside the same
        // native storage transaction as the application's writes, including the alarm tables.
        jobs: {
          planReply: (automationId, chatId) =>
            withRuntime(
              planReply.schedule(chatId, { after: 0, payload: { automationId, chatId } }),
            ).pipe(Effect.orDie),
          advance: (executionId) =>
            withRuntime(advance.schedule(executionId, { after: 0, payload: { executionId } })).pipe(
              Effect.orDie,
            ),
          clock: (executionId, deferredName, at) =>
            withRuntime(
              clock.schedule(`${executionId}/${deferredName}`, {
                at,
                payload: { executionId, deferredName },
              }),
            ).pipe(Effect.orDie),
          tick: (at) =>
            withRuntime(tick.schedule(TICK_JOB, { at, payload: { at } })).pipe(Effect.orDie),
          cancelTick: withRuntime(Effect.suspend(() => tick.cancel(TICK_JOB))).pipe(Effect.orDie),
        },
        // deleteAll drops pi's tables and the scheduler's job tables with the keys. pi keeps
        // handles to its tables open, so the instance resets once the deletion is durable, and
        // the next call opens everything fresh. Resetting fails the call that erased.
        erase: withRuntime(
          Effect.gen(function* () {
            yield* state.storage.deleteAll();
            yield* state.storage.deleteAlarm();
            yield* state.storage.sync();
            yield* state.abort(ERASED);
          }),
        ),
      });
      // One hub per instance, shared by the planner's tools and the operations that answer them.
      const answers = yield* makeAnswerHub;
      // The planner's tools edit its working copy through the host, so pi opens with them.
      const { tools } = yield* makePlanning().pipe(
        Effect.provideService(AutomationHost, host),
        Effect.provideService(AnswerHub, answers),
      );
      const pi = yield* openPiAgent({
        storage: () => openPiStorage(state.raw.storage),
        ai: aiBinding,
        model: PLANNER_MODEL,
        thinkingLevel: PLANNER_THINKING_LEVEL,
        tools,
      }).pipe(Effect.orDie);
      const classifier = workersAiClassifier(aiBinding);
      const { callbacks, ...operations } = yield* makeAutomation().pipe(
        Effect.provideService(AutomationHost, host),
        Effect.provideService(AnswerHub, answers),
        Effect.provideService(PiAgent, pi),
        Effect.provideService(Classifier, classifier),
        Effect.provideService(LocalDevelopment, local),
        Effect.provideService(
          SlackSender,
          Option.isSome(slackToken) ? makeSlackWebSender(slackToken.value) : null,
        ),
        Effect.provideService(ConfiguredStudioOrigin, configuredOrigin ?? null),
        Effect.provideService(
          EmailSender,
          emailBinding === undefined || Option.isNone(emailFrom)
            ? null
            : makeCloudflareEmailSender(
                yield* emailBinding.raw.pipe(
                  Effect.provideService(Alchemy.RuntimeContext, runtime),
                ),
                { email: emailFrom.value, name: Option.getOrUndefined(emailFromName) },
              ),
        ),
      );
      const planReply = yield* Alchemy.makeCallback("planReply", (payload: unknown) =>
        Schema.decodeUnknownEffect(PlanReply)(payload).pipe(
          Effect.orDie,
          Effect.flatMap(callbacks.planReply),
        ),
      );
      const advance = yield* Alchemy.makeCallback("advance", (payload: unknown) =>
        Schema.decodeUnknownEffect(Advance)(payload).pipe(
          Effect.orDie,
          Effect.flatMap(callbacks.advance),
        ),
      );
      const clock = yield* Alchemy.makeCallback("clock", (payload: unknown) =>
        Schema.decodeUnknownEffect(ClockFired)(payload).pipe(
          Effect.orDie,
          Effect.flatMap(callbacks.clock),
        ),
      );
      const tick = yield* Alchemy.makeCallback("tick", (payload: unknown) =>
        Schema.decodeUnknownEffect(Tick)(payload).pipe(
          Effect.orDie,
          Effect.flatMap(callbacks.tick),
        ),
      );
      return operations;
    }).pipe(Effect.provide(Layer.mergeAll(entities, index, events)));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Workers.AIBinding,
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Email.SendBinding,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
) {}
