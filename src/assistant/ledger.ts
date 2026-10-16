/**
 * The assistant session's durable record: the session itself under `assistant`, and one receipt per
 * tool call under `tool:<callId>`. Both keys are persisted contracts. A receipt is written before
 * its call reaches another service, so a call pi replays after a restart finds what it already did.
 *
 * This sits beside pi-durable's own tool tasks on purpose: a decision or answer written here commits
 * with the reply job that wakes pi, which pi's separate transaction can't. See `docs/assistant.md`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AnswerHub } from "../ai/ask-question/answer-hub.ts";
import { Question, QuestionsAnswer } from "../ai/ask-question/question.ts";
import { ChangeProposal } from "../changes/model.ts";
import { messageOf } from "../error.ts";
import { AssistantError, type AssistantHost } from "./host.ts";
import { type AssistantActivity, AssistantState, PageContext } from "./model.ts";

export const Receipt = Schema.Struct({
  id: Schema.String,
  turnId: Schema.String,
  kind: Schema.Literals(["change", "question", "draft"]),
  result: Schema.optionalKey(Schema.String),
  proposal: Schema.optionalKey(ChangeProposal),
  approved: Schema.optionalKey(Schema.Boolean),
  questions: Schema.optionalKey(Schema.Array(Question)),
  answer: Schema.optionalKey(QuestionsAnswer),
  automationId: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  submitted: Schema.optionalKey(Schema.Boolean),
  plannerCall: Schema.optionalKey(Schema.String),
  plannerSignature: Schema.optionalKey(Schema.String),
});
export type Receipt = typeof Receipt.Type;

export const StoredSession = Schema.Struct({
  state: AssistantState,
  owner: Schema.String,
  turnId: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(PageContext),
});
export type StoredSession = typeof StoredSession.Type;

export type ActivityStatus = AssistantActivity["status"];

/** Where the studio shows what a tool call touched: its automation, template or entity type. */
const activityHref = (r: Receipt): string | undefined => {
  if (r.automationId !== undefined) return `/?automation=${encodeURIComponent(r.automationId)}`;
  const action = r.proposal?.action;
  if (action === undefined) return undefined;
  switch (action.kind) {
    case "putTemplate":
      return `/templates?template=${encodeURIComponent(action.template.name)}`;
    case "deleteTemplate":
      return "/templates";
    case "deleteType":
      return "/entities";
    case "putType":
      return `/entities?type=${encodeURIComponent(action.type.name)}`;
    case "putEntity":
    case "deleteEntity":
      return `/entities?type=${encodeURIComponent(action.type)}`;
  }
};

export const activityOf = (r: Receipt, status: ActivityStatus): AssistantActivity => {
  const href = activityHref(r);
  return {
    id: r.id,
    label: r.proposal?.title ?? r.name ?? "Question",
    status,
    ...(href !== undefined ? { href } : {}),
  };
};

/** Every read checks the stored owner and session ID, so one session never reads another's. */
export const makeLedger = (options: {
  readonly owner: string;
  readonly sessionId: string;
  readonly storage: AssistantHost["storage"];
  readonly hub: typeof AnswerHub.Service;
}) => {
  const { owner, sessionId, storage, hub } = options;
  // optionalKey distinguishes absence from an explicit undefined, so store JSON wire values: the
  // round trip drops undefined keys (structuredClone would keep them). Stored values are Schema
  // types, so one that can't round-trip is a defect.
  const write = (key: string, value: StoredSession | Receipt) =>
    Effect.suspend(() => {
      try {
        return storage.put(key, JSON.parse(JSON.stringify(value)) as unknown);
      } catch (error) {
        return Effect.die(error);
      }
    });

  const session = Effect.gen(function* () {
    const value = yield* storage.get("assistant");
    if (value === undefined)
      return {
        owner,
        state: { sessionId, conversation: [], activities: [], status: "idle" },
      } satisfies StoredSession;
    const stored = yield* Schema.decodeUnknownEffect(StoredSession)(value);
    if (stored.owner !== owner || stored.state.sessionId !== sessionId)
      return yield* new AssistantError({ message: "Session identity mismatch" });
    return stored;
  });
  const update = (f: (s: StoredSession) => StoredSession) =>
    session.pipe(Effect.flatMap((s) => write("assistant", f(s))));
  /**
   * Updates the session only while `turnId` is the turn in progress, so work that finishes after
   * the person stopped the turn, or after another began, leaves it alone.
   */
  const updateTurn = (turnId: string, f: (s: StoredSession) => StoredSession) =>
    update((s) =>
      s.turnId !== turnId || s.state.status === "idle" || s.state.status === "failed" ? s : f(s),
    );

  const receipts = storage
    .list({ prefix: "tool:" })
    .pipe(
      Effect.flatMap((values) =>
        Schema.decodeUnknownEffect(Schema.Array(Receipt))([...values.values()]),
      ),
    );
  /** The turn's receipts that have no result yet. */
  const unfinished = (turnId: string | undefined) =>
    receipts.pipe(
      Effect.map((all) => all.filter((r) => r.turnId === turnId && r.result === undefined)),
    );
  const receipt = (id: string) =>
    storage
      .get(`tool:${id}`)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.UndefinedOr(Receipt))));
  /** A receipt with a result is never reopened: a later write keeps the stored result. */
  const put = (r: Receipt) =>
    receipt(r.id).pipe(
      Effect.flatMap((current) =>
        write(`tool:${r.id}`, current?.result === undefined ? r : { ...r, result: current.result }),
      ),
    );

  const activity = (r: Receipt, status: ActivityStatus) =>
    update((s) => ({
      ...s,
      state: {
        ...s.state,
        activities: [...s.state.activities.filter((a) => a.id !== r.id), activityOf(r, status)],
      },
    }));

  /**
   * Returns the call's receipt, opening one for the working turn the first time. Refuses while
   * another call of the turn is unanswered, so the turn waits on at most one thing.
   */
  const start = (id: string, kind: Receipt["kind"]) =>
    storage.transaction(
      Effect.gen(function* () {
        const previous = yield* receipt(id);
        if (previous !== undefined) return previous;
        const s = yield* session;
        if (s.turnId === undefined || s.state.status === "failed" || s.state.status === "idle")
          return yield* new AssistantError({ message: "No working turn" });
        if ((yield* unfinished(s.turnId)).some((r) => r.answer === undefined))
          return yield* new AssistantError({
            message: "Wait for the pending tool before starting another",
          });
        const r: Receipt = { id, kind, turnId: s.turnId };
        yield* put(r);
        return r;
      }),
    );

  /**
   * Records the call's result for pi and its outcome for the person, unless it already has one,
   * such as when the person stopped the turn. Run inside a transaction.
   */
  const finish = (r: Receipt, result: string, status: Exclude<ActivityStatus, "working">) =>
    receipt(r.id).pipe(
      Effect.flatMap((current) =>
        current?.result !== undefined
          ? Effect.void
          : put({ ...r, result }).pipe(Effect.andThen(activity(r, status))),
      ),
    );

  /** Fails every unfinished call of the turn. Run inside a transaction. */
  const failUnfinished = (turnId: string, error: unknown) =>
    unfinished(turnId).pipe(
      Effect.flatMap((open) =>
        Effect.forEach(
          open,
          (r) => finish(r, JSON.stringify({ status: "failed", error: messageOf(error) }), "failed"),
          { discard: true },
        ),
      ),
    );

  /**
   * Waits for the call's result, telling the reply in progress that its turn has parked. Resolves at
   * once if the result is already stored.
   */
  const park = Effect.fn("Assistant.park")(function* (r: Receipt) {
    const wait = yield* hub.answerSlot(r.id);
    const latest = yield* receipt(r.id);
    if (latest?.result !== undefined) return latest.result;
    yield* hub.parked(r.turnId);
    yield* wait;
    const done = yield* receipt(r.id);
    if (done?.result !== undefined) return done.result;
    if (done?.answer !== undefined) return JSON.stringify(done.answer);
    return yield* new AssistantError({ message: "Tool is still pending" });
  });

  return {
    session,
    update,
    updateTurn,
    receipts,
    unfinished,
    receipt,
    put,
    activity,
    start,
    finish,
    failUnfinished,
    park,
  };
};

export type Ledger = ReturnType<typeof makeLedger>;
