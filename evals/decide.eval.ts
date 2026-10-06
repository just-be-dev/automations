import { expect } from "bun:test";
import { decide } from "./calls/decide.ts";
import { defineEval } from "./framework/eval.ts";
import { ada, values } from "./fixtures.ts";

/** Decide steps pick the option that routes a run. */

const welcomes = {
  engineer: "Software engineers and other people who write code",
  sales: "Account executives and other sales roles",
  general: "Everyone else",
};

export default defineEval({
  call: decide,
  minimum: 0.9,
  every: {
    "answers with a decision": (output) => expect(output.problem).toBeUndefined(),
    "picks one of the options": (output, input) =>
      expect(output.choice).toBeOneOf(Object.keys(input.options)),
    "confidence between 0 and 1": (output) => {
      expect(output.confidence).toBeGreaterThanOrEqual(0);
      expect(output.confidence).toBeLessThanOrEqual(1);
    },
  },
  cases: {
    "role-engineer": {
      input: { question: "Which welcome fits this hire?", options: welcomes, state: values(ada) },
      checks: { "picks engineer": (output) => expect(output.choice).toBe("engineer") },
    },
    "role-sales": {
      input: {
        question: "Which welcome fits this hire?",
        options: welcomes,
        state: values({ ...ada, data: { ...ada.data, role: "Sales Development Representative" } }),
      },
      checks: { "picks sales": (output) => expect(output.choice).toBe("sales") },
    },
    ticket: {
      input: {
        question: "Which team should handle this ticket?",
        options: {
          billing: "Charges, invoices, refunds",
          technical: "Bugs, outages, and how-to questions",
          other: "Anything else",
        },
        state: values({
          type: "ticket",
          id: "t-12",
          data: { text: "Hello, my card was charged twice for October. Can you fix this?" },
        }),
      },
      checks: { "picks billing": (output) => expect(output.choice).toBe("billing") },
    },
    "earlier-step": {
      input: {
        question: "What did the manager decide about the promotion?",
        options: {
          proceed: "Go ahead with the promotion now",
          postpone: "Do it later",
          cancel: "Don't promote",
        },
        state: values(ada, {
          review: {
            approved: true,
            values: { comments: "Fine by me, but let's hold off until after the quarter closes." },
            timedOut: false,
          },
        }),
      },
      checks: { "picks postpone": (output) => expect(output.choice).toBe("postpone") },
    },
    threshold: {
      input: {
        question: "How carefully should legal review this renewal?",
        options: {
          light: "Contracts worth under $50,000 a year",
          full: "Contracts worth $50,000 a year or more",
        },
        state: values({
          type: "contract",
          id: "c-7",
          data: { title: "Acme hosting", owner: "ada", ends_on: "2026-12-31", value: 250000 },
        }),
      },
      checks: { "picks full": (output) => expect(output.choice).toBe("full") },
    },
  },
});
