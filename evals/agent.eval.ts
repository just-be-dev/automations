/** Agent steps do one piece of work in a run, and record text or the fields they're asked for. */

import { expect } from "bun:test";
import { agent } from "./calls/agent.ts";
import { defineEval, judged } from "./framework/eval.ts";
import { ada, values } from "./fixtures.ts";

export default defineEval({
  call: agent,
  minimum: 0.8,
  every: {
    "answers in the shape the step asks for": (output) => expect(output.problem).toBeUndefined(),
  },
  cases: {
    "event-payload": {
      input: {
        title: "Read the upgrade event",
        instruction:
          "Extract the requested plan and seat count from the triggering event's payload.",
        fields: { plan: "text", seats: "number" },
        state: {
          ...values(null),
          event: {
            id: "upgrade-81",
            name: "subscription.upgrade",
            data: { message: "Move us to Team and add 17 seats." },
            depth: 0,
          },
        },
      },
      checks: {
        "reads the event without a subject": (output) =>
          expect(output.result).toEqual({ plan: expect.stringMatching(/team/i), seats: 17 }),
      },
    },
    "date-arithmetic": {
      input: {
        title: "Work out the check-in date",
        instruction:
          "Work out the date of Ada Lovelace's first-week check-in: the fifth working day (Monday to Friday) after her start date.",
        fields: { checkin_date: "date" },
        // She starts on Monday 2026-10-05.
        state: values(ada),
      },
      checks: {
        "counts five working days": (output) =>
          expect(output.result).toEqual({ checkin_date: "2026-10-12" }),
      },
    },
    "earlier-step-records": {
      input: {
        title: "Choose a morning slot",
        instruction:
          "From the open times find_times found, pick the earliest one that starts before noon UTC.",
        fields: { time: "datetime" },
        state: values(ada, {
          find_times: {
            times: ["2026-10-06T13:00:00Z", "2026-10-07T09:30:00Z", "2026-10-07T15:00:00Z"],
          },
        }),
      },
      checks: {
        "picks 2026-10-07 09:30 UTC": (output) =>
          expect(output.result).toEqual({
            time: expect.stringMatching(/^2026-10-07T09:30(:00)?(\.0+)?(Z|\+00:00)$/),
          }),
      },
    },
    extraction: {
      input: {
        title: "Read the upgrade request",
        instruction:
          "Read the customer's message and pull out the plan they want, the date it should start, and how many seats they're adding.",
        fields: { plan: "text", starts_on: "date", seats: "number" },
        state: values({
          type: "ticket",
          id: "t-81",
          data: {
            from: "jo@acme.example",
            text: "Hi! We'd like to move to the Team plan from March 3rd next year (2027), and add 12 seats while we're at it. Thanks, Jo",
          },
        }),
      },
      checks: {
        "reads the plan, date, and seats": (output) =>
          expect(output.result).toEqual({
            plan: expect.stringMatching(/team/i),
            starts_on: "2027-03-03",
            seats: 12,
          }),
      },
    },
    "yes-or-no": {
      input: {
        title: "Check whether she needs a dev laptop",
        instruction: "Does Ada Lovelace's role involve writing code?",
        fields: { writes_code: "boolean" },
        state: values(ada),
      },
      checks: {
        "says yes": (output) => expect(output.result).toEqual({ writes_code: true }),
      },
    },
    writing: {
      input: {
        title: "Write a welcome note",
        instruction:
          "Write a two-sentence welcome note for Ada Lovelace, who joins the Payments team on 2026-10-05 and reports to Grace Hopper.",
        state: values(ada),
      },
      checks: {
        "mentions her manager": (output) => expect(output.result).toContain("Grace"),
        "is the note itself": judged(
          "The answer is the welcome note itself, ready to send, about two sentences long. It isn't a description of a note, a set of options, or a claim that it was sent.",
          (output) => output.answer,
        ),
      },
    },
  },
});
