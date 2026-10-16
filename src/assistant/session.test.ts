import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PiAgent, PiError, type AgentTool } from "../ai/pi.ts";
import { assistantFixture, fixtureValue } from "./fixtures.ts";
import { Receipt } from "./ledger.ts";

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
    abort: Effect.void,
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

  for (const outcome of ["success", "failed", "questions", "replied"] as const)
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
          else if (outcome === "replied") {
            // The planner wrote its questions in its reply and drafted nothing.
            f.pending.delete(submission.id);
            f.conversations.set(submission.id, [
              { prompt: submission.description, reply: "Who should get the check-in?" },
            ]);
          } else {
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
          if (outcome === "replied")
            expect(fixtureValue(final.conversation[0]).reply).toContain(
              "Who should get the check-in?",
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

  test("the first reply names the thread and lists it for its owner", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* assistantFixture;
        const s = yield* f.open();
        const state = yield* s.chat("Help me draft an onboarding flow", { pathname: "/" });
        expect(yield* f.threads.list("person@example.com")).toMatchObject([
          { id: f.sessionId, archived: false },
        ]);
        const turn = fixtureValue(state.conversation[0]).id;
        yield* s.reply(
          script(s.tools, () => Effect.succeed("Sure")),
          turn,
        );
        expect((yield* s.inspect()).title).toBe("Fixture thread");
        expect(f.titles).toEqual(["<message>\nHelp me draft an onboarding flow\n</message>"]);
        expect(fixtureValue((yield* f.threads.list("person@example.com"))[0]).title).toBe(
          "Fixture thread",
        );
        // Later turns keep the title.
        const next = yield* s.chat("And another thing", { pathname: "/" });
        yield* s.reply(
          script(s.tools, () => Effect.succeed("Done")),
          fixtureValue(next.conversation[1]).id,
        );
        expect(f.titles.length).toBe(1);
        expect(yield* f.threads.list("another@example.com")).toEqual([]);
      }),
    ));

  test("stopping a turn cancels its proposal and leaves the thread ready for the next message", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* assistantFixture;
        const s = yield* f.open();
        const state = yield* s.chat("Create template", { pathname: "/templates" });
        const turn = fixtureValue(state.conversation[0]).id;
        const run = (tools: ReadonlyArray<AgentTool>) =>
          script(tools, (call) => call("propose_change", template, "change-1"));
        yield* s.reply(run(s.tools), turn);
        expect((yield* s.inspect()).status).toBe("confirming");
        let aborted = 0;
        const stopped = yield* s.stop(
          PiAgent.of({ ...run(s.tools), abort: Effect.sync(() => void (aborted += 1)) }),
        );
        expect(stopped.status).toBe("idle");
        expect(stopped.confirmation).toBeUndefined();
        expect(fixtureValue(stopped.conversation[0]).stopped).toBe(true);
        expect(fixtureValue(stopped.activities[0]).status).toBe("cancelled");
        expect(aborted).toBe(1);
        expect(f.mutations).toEqual([]);
        // A late callback for the stopped turn writes nothing, and stopping again does nothing.
        yield* s.reply(run(s.tools), turn);
        expect((yield* s.stop(run(s.tools))).status).toBe("idle");
        expect(aborted).toBe(1);
        const next = yield* s.chat("Try something else", { pathname: "/" });
        expect(next.status).toBe("working");
      }),
    ));

  test("stopping a delegated draft stops the planner too", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* assistantFixture;
        const s = yield* f.open();
        const state = yield* s.chat("Draft a welcome", { pathname: "/" });
        const turn = fixtureValue(state.conversation[0]).id;
        const run = (tools: ReadonlyArray<AgentTool>) =>
          script(tools, (call) =>
            call(
              "draft_automation",
              { name: "Welcome employees", description: "Send a welcome" },
              "draft",
            ),
          );
        yield* s.reply(run(s.tools), turn);
        const submission = fixtureValue(f.submissions[0]);
        expect(submission.id).toMatch(/^welcome-employees-[0-9a-f]{8}$/);
        yield* s.stop(run(s.tools));
        expect(f.stoppedChats).toEqual([`${f.sessionId}:draft`]);
        expect(f.pending.get(submission.id)?.status).toBe("failed");
        const after = yield* s.inspect();
        expect(after.status).toBe("idle");
        expect(fixtureValue(after.activities.find((a) => a.id === "draft")).status).toBe(
          "cancelled",
        );
        // The planner finishing later doesn't reopen the stopped call.
        yield* s.reply(run(s.tools), turn);
        const receipt = yield* Schema.decodeUnknownEffect(Receipt)(
          yield* f.host.storage.get("tool:draft"),
        );
        expect(receipt.result).toContain("Stopped");
      }),
    ));

  test("clearing erases the thread in place and untitles it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* assistantFixture;
        let s = yield* f.open();
        const state = yield* s.chat("Hello", { pathname: "/" });
        yield* s.reply(
          script(s.tools, () => Effect.succeed("Hi")),
          fixtureValue(state.conversation[0]).id,
        );
        const cleared = yield* s.clear(script(s.tools, () => Effect.succeed("")));
        expect(cleared).toEqual({
          sessionId: f.sessionId,
          conversation: [],
          activities: [],
          status: "idle",
        });
        expect(f.erasures()).toBe(1);
        const listed = fixtureValue((yield* f.threads.list("person@example.com"))[0]);
        expect(listed.id).toBe(f.sessionId);
        expect(listed.title).toBeUndefined();
        s = yield* f.open();
        expect((yield* s.inspect()).conversation).toEqual([]);
      }),
    ));

  test("stopping while a draft's message is on its way stops the planner it started", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* assistantFixture;
        const s = yield* f.open();
        yield* s.chat("Draft a welcome", { pathname: "/" });
        const idle = script(s.tools, () => Effect.succeed(""));
        // The person presses Stop while the planner receives the message.
        yield* f.beforeChat(s.stop(idle));
        const result = yield* fixtureValue(s.tools.find((t) => t.name === "draft_automation"))
          .execute({ name: "Welcome employees", description: "Send a welcome" }, { id: "draft" })
          .pipe(Effect.orDie);
        expect(result).toContain("Stopped");
        expect(f.stoppedChats).toEqual([`${f.sessionId}:draft`]);
        const submission = fixtureValue(f.submissions[0]);
        expect(f.pending.get(submission.id)?.status).toBe("failed");
        const state = yield* s.inspect();
        expect(state.status).toBe("idle");
        expect(fixtureValue(state.activities.find((a) => a.id === "draft")).status).toBe(
          "cancelled",
        );
        const receipt = yield* Schema.decodeUnknownEffect(Receipt)(
          yield* f.host.storage.get("tool:draft"),
        );
        expect(receipt.submitted).toBeUndefined();
      }),
    ));

  test("a proposal prepared after the turn stopped doesn't reopen the call", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* assistantFixture;
        const s = yield* f.open();
        const state = yield* s.chat("Create template", { pathname: "/templates" });
        const turn = fixtureValue(state.conversation[0]).id;
        // Open the receipt as the tool does, then stop before the proposal is stored.
        yield* s.reply(
          script(s.tools, (call) => call("propose_change", template, "change-1")),
          turn,
        );
        yield* f.host.storage.put("tool:change-1", {
          id: "change-1",
          turnId: turn,
          kind: "change",
        });
        yield* s.stop(script(s.tools, () => Effect.succeed("")));
        const late = yield* fixtureValue(s.tools.find((t) => t.name === "propose_change"))
          .execute(template, { id: "change-1" })
          .pipe(Effect.orDie);
        expect(late).toContain("Stopped");
        const after = yield* s.inspect();
        expect(after.status).toBe("idle");
        expect(after.confirmation).toBeUndefined();
        expect(fixtureValue(after.activities.find((a) => a.id === "change-1")).status).toBe(
          "cancelled",
        );
      }),
    ));
});
