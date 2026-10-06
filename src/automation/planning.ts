import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { planOf, Plan } from "../agents/planner/plan.ts";
import {
  type AskedQuestions,
  answerProblem,
  Question,
  QuestionsAnswer,
} from "../agents/planner/question.ts";
import { plannerTools, type PlanStore } from "../agents/planner/tools.ts";
import { AgentToolError } from "../ai/pi.ts";
import { EntityStore } from "../entities/store.ts";
import type { Workflow } from "../workflow/model.ts";
import { AnswerHub } from "./answer-hub.ts";
import { AutomationHost, decodeOrDrop } from "./host.ts";
import { AutomationError } from "./model.ts";
import { catalogOf } from "./workflow-store.ts";

/** Questions one `ask_question` call asked, by pi's ID for the call, and the answer once given. */
const Asking = Schema.Struct({
  callId: Schema.String,
  questions: Schema.Array(Question),
  answer: Schema.optionalKey(QuestionsAnswer),
});
export interface Asking extends Schema.Schema.Type<typeof Asking> {}

/**
 * The working copy the planner edits while it answers one message, and the questions it asks on
 * the way, kept under `plan` so they survive a restart mid-answer. The draft changes only once the
 * answer is accepted. A question without an answer means the planner's turn is parked on it.
 */
const StoredPlan = Schema.Struct({
  chatId: Schema.String,
  plan: Plan,
  asked: Schema.optionalKey(Schema.Array(Asking)),
});

const noDesign = new AgentToolError({ message: "There is no message being answered" });

export const makePlanning = Effect.fn("Automation.makePlanning")(function* () {
  const { storage } = yield* AutomationHost;
  const entities = yield* EntityStore;
  const hub = yield* AnswerHub;

  const stored = storage.get("plan").pipe(Effect.flatMap(decodeOrDrop(StoredPlan)));

  /** Starts the working copy for `chatId` from the draft, unless a delivery already did. */
  const start = (chatId: string, draft: Workflow | undefined) =>
    stored.pipe(
      Effect.flatMap((current) =>
        current?.chatId === chatId
          ? Effect.void
          : storage.put("plan", { chatId, plan: planOf(draft) }),
      ),
    );

  const answering = stored.pipe(Effect.filterOrFail(Predicate.isNotUndefined, () => noDesign));

  // The slot opens before storage is read, so an answer that arrives in between still wakes it.
  const ask = (callId: string, questions: ReadonlyArray<Question>) =>
    Effect.gen(function* () {
      const waiting = yield* hub.answerSlot(callId);
      const recorded = yield* storage
        .transaction(
          Effect.gen(function* () {
            const saved = yield* answering;
            const asked = saved.asked ?? [];
            const existing = asked.find((asking) => asking.callId === callId);
            if (existing === undefined) {
              yield* storage.put("plan", { ...saved, asked: [...asked, { callId, questions }] });
            }
            return { chatId: saved.chatId, answer: existing?.answer };
          }),
        )
        .pipe(
          Effect.catchTag("AutomationStorageError", (error) =>
            Effect.fail(new AgentToolError({ message: error.message })),
          ),
        );
      if (recorded.answer !== undefined) {
        return recorded.answer;
      }
      yield* hub.parked(recorded.chatId);
      return yield* waiting;
    });

  const store: PlanStore = {
    read: answering.pipe(Effect.map(({ plan }) => plan)),
    write: (plan) =>
      answering.pipe(Effect.flatMap((saved) => storage.put("plan", { ...saved, plan }))),
    ask,
  };

  const tools = plannerTools(
    store,
    catalogOf(entities).pipe(
      Effect.mapError((error) => new AgentToolError({ message: error.message })),
    ),
  );

  /** The questions the turn answering `chatId` is parked on, if it is. */
  const openQuestions = (chatId: string) =>
    stored.pipe(
      Effect.map((current) =>
        current?.chatId === chatId
          ? current.asked?.find((asking) => asking.answer === undefined)
          : undefined,
      ),
    );

  /**
   * Records the person's answer to the questions the turn answering `chatId` is parked on, and
   * resolves with the call it answers. Run it in the transaction that resumes the turn.
   */
  const recordAnswer = (chatId: string, answer: QuestionsAnswer) =>
    Effect.gen(function* () {
      const current = yield* stored;
      const open = current?.chatId === chatId ? current.asked?.find((a) => !a.answer) : undefined;
      if (current === undefined || open === undefined) {
        return yield* new AutomationError({ message: "The agent isn't waiting for answers" });
      }
      const problem = answerProblem(open.questions, answer);
      if (problem !== undefined) {
        return yield* new AutomationError({ message: problem });
      }
      yield* storage.put("plan", {
        ...current,
        asked: (current.asked ?? []).map((asking) =>
          asking.callId === open.callId ? { ...asking, answer } : asking,
        ),
      });
      return open.callId;
    });

  /** The questions the turn answering `chatId` asked, with their answers. */
  const asked = (chatId: string) =>
    stored.pipe(
      Effect.map((current): ReadonlyArray<AskedQuestions> =>
        current?.chatId === chatId
          ? (current.asked ?? []).flatMap(({ questions, answer }) =>
              answer === undefined ? [] : [{ questions, answer }],
            )
          : [],
      ),
    );

  return {
    start,
    plan: store.read.pipe(Effect.orDie),
    openQuestions,
    recordAnswer,
    asked,
    /** Wakes the turn waiting for `callId`'s answer, if it's still waiting in memory. */
    deliver: hub.deliver,
    /** Resolves with the wait for the turn answering `chatId` to park on a question. */
    watchParked: hub.watchParked,
    tools,
  };
});
