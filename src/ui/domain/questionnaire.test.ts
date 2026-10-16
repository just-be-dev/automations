/** Guards how clicking the agent's question options toggles the person's choices. */
import { expect, test } from "bun:test";
import { Questionnaire } from "./index.ts";

const single = { header: "Timing", question: "When?", options: [{ label: "A" }, { label: "B" }] };
const multi = { ...single, multiSelect: true };

const answers = (questionnaire: Questionnaire.Questionnaire) =>
  Questionnaire.answerOf(questionnaire);
const sent = (...values: ReadonlyArray<string | null>) => ({
  kind: "answers" as const,
  answers: values,
});

test("a single-choice option replaces the choice, and clicking it again clears it", () => {
  const a = Questionnaire.choose(Questionnaire.start("ask", [single]), single, 0, "A");
  expect(answers(a)).toEqual(sent("A"));
  const b = Questionnaire.choose(a, single, 0, "B");
  expect(answers(b)).toEqual(sent("B"));
  const cleared = Questionnaire.choose(b, single, 0, "B");
  expect(answers(cleared)).toEqual(sent(null));
  expect(Questionnaire.isAnswered(Questionnaire.answerAt(cleared, 0))).toBe(false);
});

test("a multiple-choice option adds or removes itself, and removing the last clears the answer", () => {
  const start = Questionnaire.start("ask", [multi]);
  const both = Questionnaire.choose(Questionnaire.choose(start, multi, 0, "A"), multi, 0, "B");
  expect(answers(both)).toEqual(sent("A, B"));
  const onlyB = Questionnaire.choose(both, multi, 0, "A");
  expect(answers(onlyB)).toEqual(sent("B"));
  expect(answers(Questionnaire.choose(onlyB, multi, 0, "B"))).toEqual(sent(null));
});

test("choosing an option after writing replaces the written answer", () => {
  const written = Questionnaire.write(Questionnaire.start("ask", [single]), 0, "Monday");
  expect(answers(Questionnaire.choose(written, single, 0, "A"))).toEqual(sent("A"));
});
