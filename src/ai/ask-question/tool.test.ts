import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { AgentToolError } from "../pi.ts";
import { answerResult, type Question, type QuestionsAnswer } from "./question.ts";
import { askQuestionTool } from "./tool.ts";

const question = (index: number, labels: ReadonlyArray<string> = ["Yes", "No"]) => ({
  question: `Question ${index}?`,
  header: `Header ${index}`,
  options: labels.map((label) => ({ label })),
});

/** The tool over a host that answers at once, recording what it was asked. */
const asking = (answer: QuestionsAnswer) => {
  const asked: Array<{ readonly callId: string; readonly questions: ReadonlyArray<Question> }> = [];
  const tool = askQuestionTool((callId, questions) =>
    Effect.sync(() => {
      asked.push({ callId, questions });
      return answer;
    }),
  );
  const call = (args: unknown) => tool.execute(args, { id: "call-1" });
  return { asked, call };
};

describe("ask_question", () => {
  test("asks the host under the call's ID and returns the answer for the model", async () => {
    const { asked, call } = asking({ kind: "answers", answers: ["HR", null] });
    const questions = [question(1, ["Managers", "HR"]), { ...question(2), multiSelect: true }];
    expect(await Effect.runPromise(call({ questions }))).toBe(
      "The person answered:\n- Question 1? HR\n- Question 2? (skipped)\nCarry on with their answers.",
    );
    expect(asked).toEqual([{ callId: "call-1", questions }]);
  });

  test("tells the model everything wrong with its questions, and shows none of them", async () => {
    const { asked, call } = asking({ kind: "answers", answers: [] });
    const problemsWith = (questions: ReadonlyArray<unknown>) =>
      Effect.runPromise(call({ questions }).pipe(Effect.flip)).then(
        (error: AgentToolError) => error.message,
      );

    expect(await problemsWith([])).toContain("Ask at least 1 question.");
    expect(await problemsWith([1, 2, 3, 4, 5].map((index) => question(index)))).toContain(
      "You asked 5 questions; ask at most 4 at a time.",
    );
    const problems = await problemsWith([
      { ...question(1, ["Managers"]), header: "Who approves the email" },
      { ...question(1, ["HR", "hr", "Other", "A", "B"]), header: "" },
      question(3, ["Yes", "x".repeat(61)]),
    ]);
    expect(problems).toStartWith("Nothing was shown. Fix these and ask again:\n- ");
    expect(problems).toContain('The question "Question 1?" is asked more than once.');
    expect(problems).toContain(
      'Question 1\'s header "Who approves the email" is longer than 16 characters.',
    );
    expect(problems).toContain("Question 1 has 1 option; give it at least 2");
    expect(problems).toContain("Question 2 has no header");
    expect(problems).toContain("Question 2 has 5 options; give it at most 4");
    expect(problems).toContain('Question 2 has more than one option labelled "HR".');
    expect(problems).toContain(
      "Question 2's option \"Other\" isn't needed: the studio already lets the person write their own answer.",
    );
    expect(problems).toContain("is longer than 60 characters");
    expect(await problemsWith([{ question: "Which role?" }])).toContain("header");
    expect(asked).toEqual([]);
  });

  test("tells the model when the person skipped its questions or wrote instead", () => {
    const questions = [question(1, ["Formal", "Casual"])];
    expect(answerResult(questions, { kind: "answers", answers: [" "] })).toStartWith(
      "The person skipped your questions.",
    );
    expect(answerResult(questions, { kind: "message", text: " Warm but brief \n" })).toBe(
      "Instead of picking answers, the person wrote:\n\nWarm but brief\n\nTreat this as their answer, and carry on.",
    );
  });
});
