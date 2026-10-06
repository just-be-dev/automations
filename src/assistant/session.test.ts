import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { PiAgent, PiError, type AgentTool } from "../ai/pi.ts";
import { assistantFixture, fixtureValue } from "./fixtures.ts";

const template = {
  kind: "putTemplate",
  template: {
    name: "onboarding_email",
    label: "Onboarding email",
    description: "Welcome new employees",
    slots: [],
    content: { subject: "Welcome", body: "Glad you're here" },
  },
};
const questions = [
  {
    question: "Which channel?",
    header: "Channel",
    options: [{ label: "Email" }, { label: "Slack" }],
  },
];
const script = (
  tools: ReadonlyArray<AgentTool>,
  run: (
    call: (name: string, args: unknown, id: string) => Effect.Effect<string, PiError>,
  ) => Effect.Effect<string, PiError>,
) =>
  PiAgent.of({
    instruct: () => Effect.void,
    liveAnswer: Effect.succeed(undefined),
    createConversation: Effect.succeed(0),
    transcript: () => Effect.succeed({ events: [], truncated: false }),
    prompt: () =>
      run((name, args, id) =>
        fixtureValue(tools.find((t) => t.name === name))
          .execute(args, { id })
          .pipe(Effect.mapError((e) => new PiError({ message: e.message }))),
      ),
  });

describe("durable assistant", () => {
  for (const approved of [true, false])
    test(`parks, restarts and ${approved ? "applies" : "cancels"} only inline`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const f = yield* assistantFixture;
          let s = yield* f.open();
          const state = yield* s.chat("Create template", { pathname: "/templates" });
          const turn = fixtureValue(state.conversation[0]).id;
          const run = (tools: ReadonlyArray<AgentTool>) =>
            script(tools, (call) => call("propose_change", template, "change-1"));
          yield* s.reply(run(s.tools), turn);
          expect((yield* s.inspect()).status).toBe("confirming");
          expect(f.mutations).toEqual([]);
          expect(yield* f.entities.listTemplates).toEqual([]);
          expect(
            Result.isFailure(yield* s.chat("yes", { pathname: "/" }).pipe(Effect.result)),
          ).toBe(true);
          expect(Result.isFailure(yield* s.confirm("stale", true).pipe(Effect.result))).toBe(true);
          s = yield* f.open();
          yield* s.confirm(fixtureValue((yield* s.inspect()).confirmation).id, approved);
          yield* s.reply(run(s.tools), turn);
          yield* s.reply(run(s.tools), turn);
          expect((yield* s.inspect()).status).toBe("idle");
          expect(fixtureValue((yield* s.inspect()).activities[0]).status).toBe(
            approved ? "completed" : "cancelled",
          );
          expect(f.mutations.length).toBe(approved ? 1 : 0);
          expect(f.proposals.size).toBe(1);
          expect(Result.isFailure(yield* s.confirm("change-1", approved).pipe(Effect.result))).toBe(
            true,
          );
        }),
      ));

  test("question validation, durable answers and stale call guards", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* assistantFixture;
        let s = yield* f.open();
        const state = yield* s.chat("Help", { pathname: "/entities" });
        const turn = fixtureValue(state.conversation[0]).id;
        const run = (tools: ReadonlyArray<AgentTool>) =>
          script(tools, (call) => call("ask_question", { questions }, "q1"));
        yield* s.reply(run(s.tools), turn);
        expect((yield* s.inspect()).questions?.callId).toBe("q1");
        expect(
          Result.isFailure(
            yield* s.answer("old", { kind: "answers", answers: ["Email"] }).pipe(Effect.result),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* s.answer("q1", { kind: "answers", answers: [] }).pipe(Effect.result),
          ),
        ).toBe(true);
        s = yield* f.open();
        yield* s.answer("q1", { kind: "answers", answers: ["Email"] });
        yield* s.reply(run(s.tools), turn);
        expect(fixtureValue((yield* s.inspect()).conversation[0]).reply).toContain("Email");
        expect((yield* s.inspect()).questions).toBeUndefined();
        expect(
          Result.isFailure(
            yield* fixtureValue(s.tools.find((t) => t.name === "ask_question"))
              .execute(
                { questions: [{ ...questions[0], options: [{ label: "Other" }] }] },
                { id: "invalid" },
              )
              .pipe(Effect.result),
          ),
        ).toBe(true);
      }),
    ));

  for (const outcome of ["success", "failed", "questions"] as const)
    test(`template → durable planner ${outcome}`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const f = yield* assistantFixture;
          let s = yield* f.open();
          const state = yield* s.chat("Create onboarding_email then draft using it", {
            pathname: "/",
          });
          const turn = fixtureValue(state.conversation[0]).id;
          const run = (tools: ReadonlyArray<AgentTool>) =>
            script(tools, (call) =>
              Effect.gen(function* () {
                yield* call("propose_change", template, "template");
                return yield* call(
                  "draft_automation",
                  {
                    name: "Welcome employees",
                    description: "Send onboarding_email to each employee",
                  },
                  "draft",
                );
              }),
            );
          yield* s.reply(run(s.tools), turn);
          yield* s.confirm(fixtureValue((yield* s.inspect()).confirmation).id, true);
          yield* s.reply(run(s.tools), turn);
          expect(f.submissions.length).toBe(1);
          const submission = fixtureValue(f.submissions[0]);
          expect(submission.description).toBe("Send onboarding_email to each employee");
          expect(f.directory.size).toBe(1);
          expect(fixtureValue((yield* s.inspect()).conversation[0]).reply).toBeUndefined();
          // Crash after remote chat accepted, before the local submission receipt committed.
          const intent = yield* f.host.storage.get("tool:draft");
          if (typeof intent !== "object" || intent === null)
            return yield* Effect.die("Missing intent");
          yield* f.host.storage.put("tool:draft", { ...intent, submitted: false });
          s = yield* f.open();
          yield* s.reply(run(s.tools), turn); // Replay submits the SAME durable request ID.
          expect(f.submissions.length).toBe(1);
          yield* s.reply(run(s.tools), turn); // Durable poll while working; no submission.
          expect(f.jobs.at(-1)?.after).toBe(1000);
          if (outcome === "questions") {
            f.pending.set(submission.id, {
              id: submission.requestId,
              prompt: submission.description,
              status: "asking",
              questions,
            });
            yield* s.reply(run(s.tools), turn);
            const callId = fixtureValue((yield* s.inspect()).questions).callId;
            s = yield* f.open();
            yield* s.answer(callId, { kind: "answers", answers: ["Email"] });
            yield* s.reply(run(s.tools), turn);
            expect(f.pending.get(submission.id)?.status).toBe("working");
            expect(
              Result.isFailure(
                yield* s
                  .answer(callId, { kind: "answers", answers: ["Slack"] })
                  .pipe(Effect.result),
              ),
            ).toBe(true);
          }
          if (outcome === "failed")
            f.pending.set(submission.id, {
              id: submission.requestId,
              prompt: submission.description,
              status: "failed",
              error: "Design rejected",
            });
          else {
            f.pending.delete(submission.id);
            f.drafts.set(submission.id, {
              name: "Welcome employees",
              trigger: { kind: "manual" },
              steps: [],
            });
          }
          yield* s.reply(run(s.tools), turn);
          const final = yield* s.inspect();
          expect(final.status).toBe("idle");
          expect(fixtureValue(final.activities.find((a) => a.id === "draft")).status).toBe(
            outcome === "failed" ? "failed" : "completed",
          );
          expect(fixtureValue(final.activities.find((a) => a.id === "draft")).href).toContain(
            submission.id,
          );
          expect(fixtureValue(final.conversation[0]).reply).toContain(
            outcome === "failed" ? "failed" : "completed",
          );
          expect(f.submissions.length).toBe(1);
        }),
      ));

  test("owner binding and recovering failed turns preserve conversation", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* assistantFixture;
        const s = yield* f.open();
        const initial = yield* s.chat("Help", { pathname: "/" });
        yield* s.reply(
          script(s.tools, () => Effect.fail(new PiError({ message: "Offline" }))),
          fixtureValue(initial.conversation[0]).id,
        );
        expect((yield* s.inspect()).status).toBe("failed");
        yield* s.chat("Try again", { pathname: "/templates" });
        expect((yield* s.inspect()).conversation.length).toBe(2);
        expect(Result.isFailure(yield* f.open("another@example.com").pipe(Effect.result))).toBe(
          true,
        );
      }),
    ));
});
