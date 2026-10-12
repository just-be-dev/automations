/** Hosts an isolated, resumable studio conversation with tools installed before pi resumes. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { QuestionsAnswer } from "../../ai/ask-question/question.ts";
import { AssistantError, type AssistantHost } from "../../assistant/host.ts";
import { PageContext } from "../../assistant/model.ts";
import { makeAssistantSession } from "../../assistant/session.ts";
import { Assistants } from "../../assistant/service.ts";
import Automation from "./automation.ts";
import { automationsLayer } from "./automations.ts";
import { AutomationIndexD1 } from "./automation-index-d1.ts";
import ChangeCoordinator, { changesLayer } from "./changes.ts";
import { EntityStoreD1 } from "./entity-store-d1.ts";
import { openPiAgent } from "./pi.ts";
import { openPiStorage } from "./pi-storage.ts";
import { PLANNER_MODEL } from "./workers-ai.ts";

const Identity = Schema.Struct({
  owner: Schema.NonEmptyString,
  sessionId: Schema.String.check(Schema.isUUID(4)),
});
const Reply = Schema.Struct({ turnId: Schema.String });

export default class StudioAssistant extends Cloudflare.DurableObject<StudioAssistant>()(
  "StudioAssistant",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const ai = yield* Cloudflare.Workers.AI();
    const namespace = yield* Automation;
    const coordinator = yield* ChangeCoordinator;
    const index = yield* AutomationIndexD1;
    const entities = yield* EntityStoreD1;
    const services = Layer.mergeAll(
      index,
      entities,
      automationsLayer(namespace),
      changesLayer(coordinator),
    );

    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      const remote = <A, E, R>(effect: Effect.Effect<A, E, R | Alchemy.RuntimeContext>) =>
        Effect.provideService(effect, Alchemy.RuntimeContext, runtime);
      const aiBinding = yield* ai.raw;
      const host: AssistantHost = {
        storage: {
          get: (key) => remote(state.storage.get(key)),
          put: (key, value) => remote(state.storage.put(key, value)),
          delete: (key) => remote(state.storage.delete(key)),
          list: (options) => remote(state.storage.list(options)),
          transaction: (effect) =>
            remote(state.storage.transaction(effect)).pipe(
              Effect.mapError((error) =>
                error instanceof Cloudflare.Workers.DurableObjectStorageError
                  ? new AssistantError({ message: error.message })
                  : error,
              ),
            ),
        },
        jobs: {
          reply: (turnId, after = 0) =>
            remote(reply.schedule(turnId, { after, payload: { turnId } })).pipe(Effect.orDie),
        },
      };
      const initialize = yield* Effect.cached(
        Effect.gen(function* () {
          const identity = yield* state.storage
            .get("identity")
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Identity)));
          const session = yield* makeAssistantSession({ ...identity, host });
          const pi = yield* openPiAgent({
            storage: () => openPiStorage(state.raw.storage),
            ai: aiBinding,
            model: PLANNER_MODEL,
            tools: session.tools,
          });
          return { session, pi };
        }).pipe(Effect.provide(services), Effect.provideService(Alchemy.RuntimeContext, runtime)),
      );
      const bind = Effect.fn("StudioAssistant.bind")(function* (owner: string, sessionId: string) {
        const identity = yield* Schema.decodeEffect(Identity)({ owner, sessionId });
        yield* host.storage.transaction(
          Effect.gen(function* () {
            const saved = yield* host.storage.get("identity");
            if (saved === undefined) {
              yield* host.storage.put("identity", identity);
            } else {
              const current = yield* Schema.decodeUnknownEffect(Identity)(saved);
              if (current.owner !== owner || current.sessionId !== sessionId) {
                return yield* new AssistantError({ message: "Session identity mismatch" });
              }
            }
          }),
        );
        return yield* initialize;
      });
      const reply = yield* Alchemy.makeCallback("assistantReply", (payload: unknown) =>
        Schema.decodeUnknownEffect(Reply)(payload).pipe(
          Effect.flatMap(({ turnId }) =>
            initialize.pipe(Effect.flatMap(({ session, pi }) => session.reply(pi, turnId))),
          ),
        ),
      );
      return {
        inspect: (owner: string, sessionId: string) =>
          bind(owner, sessionId).pipe(Effect.flatMap(({ session }) => session.inspect())),
        chat: (owner: string, sessionId: string, message: string, context: unknown) =>
          Schema.decodeUnknownEffect(PageContext)(context).pipe(
            Effect.flatMap((decoded) =>
              bind(owner, sessionId).pipe(
                Effect.flatMap(({ session }) => session.chat(message, decoded)),
              ),
            ),
          ),
        confirm: (owner: string, sessionId: string, proposalId: string, approved: boolean) =>
          bind(owner, sessionId).pipe(
            Effect.flatMap(({ session }) => session.confirm(proposalId, approved)),
          ),
        answer: (owner: string, sessionId: string, callId: string, answer: unknown) =>
          Schema.decodeUnknownEffect(QuestionsAnswer)(answer).pipe(
            Effect.flatMap((decoded) =>
              bind(owner, sessionId).pipe(
                Effect.flatMap(({ session }) => session.answer(callId, decoded)),
              ),
            ),
          ),
      };
    }).pipe(Effect.provide(services));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Workers.AIBinding,
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
) {}

export const assistantsLayer = (namespace: Effect.Success<typeof StudioAssistant>) =>
  Layer.effect(
    Assistants,
    Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      const remote = <A, E>(effect: Effect.Effect<A, E, Alchemy.RuntimeContext>) =>
        Effect.provideService(effect, Alchemy.RuntimeContext, runtime);
      return Assistants.of({
        get: (owner, sessionId) => {
          const stub = namespace.getByName(JSON.stringify([owner, sessionId]));
          return {
            inspect: () => remote(stub.inspect(owner, sessionId)),
            chat: (message, context) => remote(stub.chat(owner, sessionId, message, context)),
            confirm: (proposalId, approved) =>
              remote(stub.confirm(owner, sessionId, proposalId, approved)),
            answer: (callId, answer) => remote(stub.answer(owner, sessionId, callId, answer)),
          };
        },
      });
    }),
  );
