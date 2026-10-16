import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeAnswerHub } from "../ai/ask-question/answer-hub.ts";
import { ChangeAction } from "../changes/model.ts";
import { memoryAssistantHost } from "./fixtures.ts";
import { activityOf, makeLedger, type Receipt } from "./ledger.ts";

const owner = "person@example.com";
const sessionId = "11111111-1111-1111-1111-111111111111";

const open = Effect.gen(function* () {
  const { host } = memoryAssistantHost();
  const hub = yield* makeAnswerHub;
  const ledger = makeLedger({ owner, sessionId, storage: host.storage, hub });
  return { host, ledger };
});

const working = (ledger: ReturnType<typeof makeLedger>, turnId: string) =>
  ledger.update((s) => ({ ...s, turnId, state: { ...s.state, status: "working" } }));

const proposalFor = (action: unknown) => ({
  id: "proposal",
  action: Schema.decodeUnknownSync(ChangeAction)(action),
  title: "Review",
  details: [],
  consequences: [],
  confirmLabel: "Apply",
});

describe("activityOf", () => {
  const receipt: Receipt = { id: "call", turnId: "turn", kind: "change" };
  const href = (r: Receipt) => activityOf(r, "completed").href;

  test("links each call to what it touched", () => {
    expect(href({ ...receipt, kind: "draft", automationId: "a b" })).toBe("/?automation=a%20b");
    expect(
      href({
        ...receipt,
        proposal: proposalFor({
          kind: "putEntity",
          type: "employee",
          id: "ada",
          data: { name: "Ada" },
        }),
      }),
    ).toBe("/entities?type=employee");
    expect(
      href({
        ...receipt,
        proposal: proposalFor({ kind: "deleteEntity", type: "employee", id: "ada" }),
      }),
    ).toBe("/entities?type=employee");
    expect(
      href({ ...receipt, proposal: proposalFor({ kind: "deleteType", name: "employee" }) }),
    ).toBe("/entities");
    expect(
      href({ ...receipt, proposal: proposalFor({ kind: "deleteTemplate", name: "welcome" }) }),
    ).toBe("/templates");
    expect(href({ ...receipt, kind: "question" })).toBeUndefined();
  });

  test("labels a call by its proposal, then its draft's name", () => {
    expect(activityOf({ ...receipt, kind: "question" }, "working").label).toBe("Question");
    expect(activityOf({ ...receipt, kind: "draft", name: "Onboard" }, "working").label).toBe(
      "Onboard",
    );
    expect(
      activityOf(
        { ...receipt, proposal: proposalFor({ kind: "deleteType", name: "employee" }) },
        "working",
      ).label,
    ).toBe("Review");
  });
});

describe("makeLedger", () => {
  test("refuses to open a receipt without a working turn", async () => {
    const error = await Effect.runPromise(
      open.pipe(Effect.flatMap(({ ledger }) => Effect.flip(ledger.start("call", "question")))),
    );
    expect(error.message).toBe("No working turn");
  });

  test("returns the same receipt when a call is replayed", async () => {
    const [first, again, stored] = await Effect.runPromise(
      Effect.gen(function* () {
        const { ledger } = yield* open;
        yield* working(ledger, "turn");
        const first = yield* ledger.start("call", "change");
        yield* ledger.put({ ...first, approved: true });
        const again = yield* ledger.start("call", "change");
        return [first, again, yield* ledger.receipts] as const;
      }),
    );
    expect(first).toEqual({ id: "call", turnId: "turn", kind: "change" });
    expect(again).toEqual({ ...first, approved: true });
    expect(stored).toHaveLength(1);
  });

  test("lets a turn wait on one call at a time", async () => {
    const [refused, afterAnswer] = await Effect.runPromise(
      Effect.gen(function* () {
        const { ledger } = yield* open;
        yield* working(ledger, "turn");
        const first = yield* ledger.start("first", "question");
        const refused = yield* Effect.flip(ledger.start("second", "change"));
        yield* ledger.put({ ...first, answer: { kind: "answers", answers: [] } });
        return [refused, yield* ledger.start("second", "change")] as const;
      }),
    );
    expect(refused.message).toBe("Wait for the pending tool before starting another");
    expect(afterAnswer.id).toBe("second");
  });

  test("fails only the turn's unfinished calls, and shows each outcome", async () => {
    const [receipts, state] = await Effect.runPromise(
      Effect.gen(function* () {
        const { host, ledger } = yield* open;
        yield* working(ledger, "turn");
        const done = yield* ledger.start("done", "question");
        yield* host.storage.transaction(ledger.finish(done, "ok", "completed"));
        const open_ = yield* ledger.start("open", "draft");
        yield* ledger.put({ ...open_, name: "Onboard" });
        yield* ledger.put({ id: "other", turnId: "earlier", kind: "question" });
        yield* host.storage.transaction(ledger.failUnfinished("turn", new Error("boom")));
        return [yield* ledger.receipts, (yield* ledger.session).state] as const;
      }),
    );
    const byId = new Map(receipts.map((r) => [r.id, r]));
    expect(byId.get("done")?.result).toBe("ok");
    expect(JSON.parse(byId.get("open")?.result ?? "null")).toEqual({
      status: "failed",
      error: "boom",
    });
    expect(byId.get("other")?.result).toBeUndefined();
    expect(state.activities).toEqual([
      { id: "done", label: "Question", status: "completed" },
      { id: "open", label: "Onboard", status: "failed" },
    ]);
  });

  test("parks only until a result is stored", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { ledger } = yield* open;
        yield* working(ledger, "turn");
        const r = yield* ledger.start("call", "question");
        yield* ledger.put({ ...r, result: "stored" });
        return yield* ledger.park(r);
      }),
    );
    expect(result).toBe("stored");
  });

  test("refuses another owner's session", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const { host, ledger } = yield* open;
        yield* working(ledger, "turn");
        const hub = yield* makeAnswerHub;
        const other = makeLedger({
          owner: "else@example.com",
          sessionId,
          storage: host.storage,
          hub,
        });
        return yield* Effect.flip(other.session);
      }),
    );
    expect(error.message).toBe("Session identity mismatch");
  });
});
