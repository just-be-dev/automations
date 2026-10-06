import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  fixedProgress,
  pickProgress,
  planDraft,
  progressPhrases,
  type ProgressPhrase,
} from "../agents/planner/planner.ts";
import { ProgressClassifier } from "../agents/planner/progress-classifier.ts";
import { PiAgent } from "../ai/pi.ts";
import { findOperation } from "../connections/registry.ts";
import { EntityStore } from "../entities/store.ts";
import type { Permissions, Workflow } from "../workflow/model.ts";
import { AutomationHost } from "./host.ts";
import { AutomationIndex } from "./index.ts";
import { AutomationError, Exchange, PendingChat } from "./model.ts";
import { makePlanning } from "./planning.ts";
import type { WorkflowStore } from "./workflow-store.ts";

// How much more reasoning the planner writes before the classifier looks again.
const PICK_EVERY_CHARS = 300;

// Storage holds only values this automation wrote, so a decoding failure is a defect.
const decodeStoredExchangeCount = Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.Int));
const decodeStoredPendingChat = Schema.decodeUnknownEffect(Schema.UndefinedOr(PendingChat));
const decodeStoredExchanges = Schema.decodeUnknownEffect(Schema.Array(Exchange));

// Each exchange gets its own key because a single storage value is capped at 128 KiB. The padding
// keeps `list` returning them in order.
const exchangePrefix = "exchange:";
const exchangeKey = (index: number) => `${exchangePrefix}${String(index).padStart(6, "0")}`;

/** Payload of the `planReply` callback: a persisted contract, so keep it compatible. */
interface PlanReply {
  readonly automationId: string;
  readonly chatId: string;
}

/** The planner's conversation, pending reply, progress, and edits to one automation's draft. */
export const makeDesignSession = Effect.fn("Automation.makeDesignSession")(function* (
  workflows: WorkflowStore,
) {
  const host = yield* AutomationHost;
  const storage = host.storage;
  const entities = yield* EntityStore;
  const index = yield* AutomationIndex;
  const pi = yield* PiAgent;
  const { classify } = yield* ProgressClassifier;
  const planning = yield* makePlanning();
  const { read: readWorkflow, catalog } = workflows;

  const readConversation = storage.list({ prefix: exchangePrefix }).pipe(
    Effect.flatMap((entries) => decodeStoredExchanges([...entries.values()])),
    Effect.orDie,
  );
  const readPendingChat = storage
    .get("pendingChat")
    .pipe(Effect.flatMap(decodeStoredPendingChat), Effect.orDie);

  // Progress is a hint that only matters while this instance answers, so it stays in memory.
  const progress = yield* Ref.make<
    { readonly chatId: string; readonly phrase: ProgressPhrase } | undefined
  >(undefined);

  // Polls the planner's answer while it works. The classifier only runs once the reasoning has
  // grown, and one call at a time, however many tabs are watching. Between attempts, and when the
  // classifier fails or isn't sure, the last phrase stays.
  const trackProgress = Effect.fn("Automation.trackProgress")(function* (chatId: string) {
    const pickedAt = yield* Ref.make(0);
    const update = Effect.gen(function* () {
      const answer = yield* pi.liveAnswer;
      if (answer === undefined) {
        return;
      }
      const fixed = fixedProgress(answer);
      // Each tool round starts a new model request, which mustn't read as starting over.
      if (fixed === "reading" && (yield* Ref.get(progress))?.chatId === chatId) {
        return;
      }
      if (fixed !== undefined) {
        return yield* Ref.set(progress, { chatId, phrase: fixed });
      }
      if (answer.thinking.length - (yield* Ref.get(pickedAt)) < PICK_EVERY_CHARS) {
        return;
      }
      yield* Ref.set(pickedAt, answer.thinking.length);
      const phrase = yield* pickProgress(classify, answer.thinking);
      yield* Ref.set(progress, { chatId, phrase });
    }).pipe(Effect.ignore({ log: "Debug", message: "Progress update failed" }));
    yield* update.pipe(Effect.repeat(Schedule.spaced("2 seconds")));
    return yield* Effect.never;
  });

  const readProgress = (chatId: string) =>
    Ref.get(progress).pipe(
      Effect.map(
        (current) => progressPhrases[current?.chatId === chatId ? current.phrase : "reading"],
      ),
    );

  const inspect = Effect.fn("Automation.inspectDesign")(function* () {
    const draft = yield* readWorkflow("draft");
    const saved = yield* readWorkflow("saved");
    const conversation = yield* readConversation;
    const pendingChat = yield* readPendingChat;
    const progress =
      pendingChat?.status === "working" ? yield* readProgress(pendingChat.id) : undefined;
    return { draft, saved, conversation, pendingChat, progress };
  });

  const isWorking = (pending: PendingChat | undefined, chatId: string) =>
    pending?.id === chatId && pending.status === "working";

  // Delivery is at least once. A redelivered reply keeps the working copy the first delivery
  // started and reuses the pi request IDs, so the agent answers each message (and its one retry)
  // once, and only the delivery that still finds the message pending writes it.
  const planReply = Effect.fn("Automation.planReply")(function* ({
    automationId,
    chatId,
  }: PlanReply) {
    const pending = yield* readPendingChat;
    if (pending === undefined || !isWorking(pending, chatId)) {
      return;
    }
    const draft = yield* readWorkflow("draft");
    yield* planning.start(chatId, draft);
    const reply = yield* catalog.pipe(
      Effect.flatMap((current) =>
        planDraft(pi, planning.plan, current, draft, chatId, pending.prompt),
      ),
      Effect.result,
      Effect.raceFirst(trackProgress(chatId)),
    );
    const wrote = yield* storage
      .transaction(
        Effect.gen(function* () {
          if (!isWorking(yield* readPendingChat, chatId)) {
            return false;
          }
          if (Result.isFailure(reply)) {
            const failed: PendingChat = {
              id: chatId,
              prompt: pending.prompt,
              status: "failed",
              error: reply.failure.message,
            };
            yield* storage.put("pendingChat", failed);
            return false;
          }
          const { workflow } = reply.success;
          if (workflow !== undefined) {
            // The working copy started from the draft, so its permissions win; this only adds the
            // ones the person set for other operations while the planner worked.
            const previous = yield* readWorkflow("draft");
            const designed: Workflow = {
              ...workflow,
              permissions: { ...previous?.permissions, ...workflow.permissions },
            };
            yield* storage.put("draft", designed);
          }
          const exchangeCount =
            (yield* storage
              .get("exchangeCount")
              .pipe(Effect.flatMap(decodeStoredExchangeCount), Effect.orDie)) ?? 0;
          yield* storage.put(exchangeKey(exchangeCount), {
            prompt: pending.prompt,
            reply: reply.success.reply,
          });
          yield* storage.put("exchangeCount", exchangeCount + 1);
          yield* storage.delete("pendingChat");
          yield* storage.delete("plan");
          return true;
        }),
      )
      .pipe(Effect.orDie);
    const designed = Result.isSuccess(reply) ? reply.success.workflow : undefined;
    if (wrote && designed !== undefined) {
      // The index only feeds the studio's list, so a failure to update it must not fail the reply.
      yield* index.record(automationId, designed.name).pipe(Effect.ignore);
    }
  });

  const chat = Effect.fn("Automation.chat")(function* (automationId: string, message: string) {
    if (!message.trim() || message.length > 10_000) {
      return yield* new AutomationError({ message: "Message must be 1–10,000 characters" });
    }
    const pending: PendingChat = {
      id: crypto.randomUUID(),
      prompt: message,
      status: "working",
    };
    const accepted = yield* storage
      .transaction(
        Effect.gen(function* () {
          if ((yield* readPendingChat)?.status === "working") {
            return false;
          }
          yield* storage.put("pendingChat", pending);
          yield* host.jobs.planReply(automationId, pending.id);
          return true;
        }),
      )
      .pipe(Effect.orDie);
    if (!accepted) {
      return yield* new AutomationError({
        message: "The agent is still answering the previous message",
      });
    }
    return { pendingChat: pending };
  });

  /** Sets permissions over the planner's suggestions. Saving applies them. */
  const setPermissions = Effect.fn("Automation.setPermissions")(function* (
    permissions: Permissions,
  ) {
    const unknown = Object.keys(permissions).filter((id) => findOperation(id) === undefined);
    if (unknown.length > 0) {
      return yield* new AutomationError({
        message: `Unknown operations: ${unknown.join(", ")}`,
      });
    }
    const roles = yield* entities.listRoles;
    const unknownRoles = Object.values(permissions).flatMap((permission) =>
      permission === "auto" || roles.some((role) => role.name === permission.ask)
        ? []
        : [permission.ask],
    );
    if (unknownRoles.length > 0) {
      return yield* new AutomationError({ message: `No role ${unknownRoles.join(", ")}` });
    }
    return yield* storage
      .transaction(
        Effect.gen(function* () {
          const current = yield* readWorkflow("draft");
          if (current === undefined) {
            return yield* new AutomationError({ message: "No draft to set permissions on" });
          }
          const draft: Workflow = {
            ...current,
            permissions: { ...current.permissions, ...permissions },
          };
          yield* storage.put("draft", draft);
          return { draft };
        }),
      )
      .pipe(Effect.catchTag("AutomationStorageError", Effect.die));
  });

  return { inspect, chat, setPermissions, planReply };
});
