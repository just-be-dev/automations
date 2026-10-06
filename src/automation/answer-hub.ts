import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { QuestionsAnswer } from "../agents/planner/question.ts";

/**
 * Wakes a planner turn parked on its questions, within one automation instance. Answers are kept
 * in storage, so a turn pi resumes after a restart finds them there; this only spares a turn still
 * in memory from waiting for a restart, and tells the reply in progress that its turn has parked.
 */
export class AnswerHub extends Context.Service<
  AnswerHub,
  {
    /**
     * Opens the slot one question call's answer arrives in, and resolves with the wait for it. Open
     * the slot before reading storage, so an answer delivered in between isn't missed.
     */
    readonly answerSlot: (callId: string) => Effect.Effect<Effect.Effect<QuestionsAnswer>>;
    readonly deliver: (callId: string, answer: QuestionsAnswer) => Effect.Effect<void>;
    /** Resolves with the wait for the turn answering `chatId` to park on a question. */
    readonly watchParked: (chatId: string) => Effect.Effect<Effect.Effect<void>>;
    readonly parked: (chatId: string) => Effect.Effect<void>;
  }
>()("automations/AnswerHub") {}

export const makeAnswerHub = Effect.sync(() => {
  const answers = new Map<string, Deferred.Deferred<QuestionsAnswer>>();
  const parkings = new Map<string, Deferred.Deferred<void>>();

  const slot = (callId: string) =>
    Effect.gen(function* () {
      const existing = answers.get(callId);
      if (existing !== undefined) {
        return existing;
      }
      const created = yield* Deferred.make<QuestionsAnswer>();
      answers.set(callId, created);
      return created;
    });

  return AnswerHub.of({
    answerSlot: (callId) =>
      slot(callId).pipe(
        Effect.map((deferred) =>
          Deferred.await(deferred).pipe(Effect.ensuring(Effect.sync(() => answers.delete(callId)))),
        ),
      ),
    deliver: (callId, answer) =>
      slot(callId).pipe(Effect.flatMap((deferred) => Deferred.succeed(deferred, answer))),
    watchParked: (chatId) =>
      Deferred.make<void>().pipe(
        Effect.tap((deferred) => Effect.sync(() => parkings.set(chatId, deferred))),
        Effect.map(Deferred.await),
      ),
    parked: (chatId) =>
      Effect.suspend(() => {
        const deferred = parkings.get(chatId);
        parkings.delete(chatId);
        return deferred === undefined ? Effect.void : Deferred.succeed(deferred, undefined);
      }),
  });
});

export const answerHubLayer = Layer.effect(AnswerHub, makeAnswerHub);
