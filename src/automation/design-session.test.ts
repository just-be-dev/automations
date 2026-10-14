/** Stable delegated request IDs do not resubmit chats, including after completion and questions. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { Classifier } from "../ai/classifier.ts";
import { answerHubLayer } from "../ai/ask-question/answer-hub.ts";
import { PiAgent } from "../ai/pi.ts";
import { assistantFixture } from "../assistant/fixtures.ts";
import { EntityStore } from "../entities/store.ts";
import { makeDesignSession } from "./design-session.ts";
import { AutomationHost } from "./host.ts";
import { AutomationIndex } from "./index.ts";
import { makePlanning } from "./planning.ts";

test("stable chat IDs survive completion and never answer an unrelated planner question", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* assistantFixture;
      const scheduled: Array<string> = [];
      const host = AutomationHost.of({
        storage: { ...f.host.storage, transaction: (effect) => effect },
        jobs: {
          planReply: (_automationId, chatId) => Effect.sync(() => void scheduled.push(chatId)),
          advance: () => Effect.void,
          clock: () => Effect.void,
          tick: () => Effect.void,
          cancelTick: Effect.void,
        },
        erase: Effect.void,
      });
      const layer = Layer.mergeAll(
        answerHubLayer,
        Layer.succeed(AutomationHost, host),
        Layer.succeed(EntityStore, f.entities),
        Layer.succeed(AutomationIndex, {
          list: Effect.succeed([]),
          create: () => Effect.succeed(true),
          record: () => Effect.void,
          recordIfMissing: () => Effect.void,
          remove: () => Effect.void,
        }),
        Layer.succeed(Classifier, { classify: () => Effect.die("No reasoning") }),
        Layer.succeed(PiAgent, {
          instruct: () => Effect.void,
          prompt: () => Effect.succeed("Done"),
          liveAnswer: Effect.succeed(undefined),
          createConversation: Effect.succeed(0),
          transcript: () => Effect.succeed({ events: [], truncated: false }),
        }),
      );
      yield* Effect.gen(function* () {
        const session = yield* makeDesignSession({
          read: () => Effect.succeed(undefined),
          catalog: Effect.succeed({ types: [], templates: [], roles: [] }),
          save: () => Effect.die("Never save"),
          studioLink: Effect.succeed(undefined),
        });
        const first = yield* session.chat("a1", "Design welcome", "stable");
        const duplicate = yield* session.chat("a1", "Design welcome", "stable");
        expect(duplicate.pendingChat.id).toBe(first.pendingChat.id);
        expect(scheduled).toEqual(["stable"]);
        yield* session.planReply({ automationId: "a1", chatId: "stable" });
        yield* session.chat("a1", "Design welcome", "stable");
        expect(scheduled).toEqual(["stable"]);
        expect((yield* session.inspect()).conversation.length).toBe(1);
        const next = yield* session.chat("a1", "Another request");
        const planning = yield* makePlanning();
        yield* planning.start(next.pendingChat.id, undefined);
        const questions = [
          {
            header: "Channel",
            question: "Which channel?",
            options: [{ label: "Email" }, { label: "Slack" }],
          },
        ];
        // Persist a parked planner round, exactly as its replay-safe tool does.
        const stored = yield* host.storage.get("plan");
        if (typeof stored !== "object" || stored === null) return yield* Effect.die("Missing plan");
        yield* host.storage.put("plan", { ...stored, asked: [{ callId: "question", questions }] });
        expect(
          Result.isFailure(
            yield* session.chat("a1", "New delegated edit", "fresh").pipe(Effect.result),
          ),
        ).toBe(true);
        expect((yield* session.inspect()).pendingChat?.status).toBe("asking");
        yield* session.chat("a1", "Email please"); // Existing callers still answer questions as messages.
        const answered = (yield* session.inspect()).pendingChat;
        expect(
          answered !== undefined && answered.status !== "failed"
            ? answered.asked?.[0]?.answer
            : undefined,
        ).toEqual({ kind: "message", text: "Email please" });
      }).pipe(Effect.provide(layer));
    }),
  ));
