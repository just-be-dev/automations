import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { Catalog } from "./catalog.ts";
import {
  designDraft,
  designInstructions,
  fixedProgress,
  pickProgress,
  type ClassifyRequest,
} from "./design.ts";
import { PiError, type PromptOptions } from "./pi.ts";

const catalog: Catalog = {
  types: [
    {
      name: "employee",
      label: "Employee",
      title: "name",
      fields: [
        { name: "name", label: "Name", type: "text" },
        { name: "start_date", label: "Start date", type: "date" },
      ],
    },
  ],
  templates: [],
  roles: [],
};

const draft = (until: string) =>
  JSON.stringify({
    reply: "Waits for the start date",
    workflow: {
      name: "Onboarding",
      trigger: { kind: "entity", entity: "employee", fields: ["start_date"] },
      steps: [{ id: "wait", title: "Wait", kind: "wait", until }],
    },
  });

/**
 * A stand-in for the designer's pi agent that answers from a script and records each request and
 * the system prompt instructions it was given.
 */
const scriptedPrompt = (answers: ReadonlyArray<Effect.Effect<string, PiError>>) => {
  const requests: Array<PromptOptions> = [];
  const instructions: Array<string> = [];
  const designer = {
    prompt: (options: PromptOptions) => {
      requests.push(options);
      return answers[requests.length - 1] ?? Effect.die("No scripted answer left");
    },
    instruct: (text: string) => Effect.sync(() => void instructions.push(text)),
  };
  return { designer, requests, instructions };
};

const design = (designer: ReturnType<typeof scriptedPrompt>["designer"]) =>
  designDraft(designer, catalog, { "email.send": "auto" }, "c1", "Wait for the start date");

describe("designDraft", () => {
  test("sends the catalog and uses a reply that checks without retrying", async () => {
    const { designer, requests, instructions } = scriptedPrompt([
      Effect.succeed(draft("employee.start_date")),
    ]);
    const result = await Effect.runPromise(design(designer));
    expect(result.workflow.name).toBe("Onboarding");
    expect(requests.map((request) => request.requestId)).toEqual(["chat:c1"]);
    // The instructions, catalog included, are the system prompt, so the message goes as written.
    expect(instructions).toEqual([designInstructions(catalog, { "email.send": "auto" })]);
    expect(instructions[0]).toContain(
      'Current permissions, which the person may have changed: "email.send":"auto".',
    );
    expect(instructions[0]).toContain("- employee (Employee; shown as its name)");
    expect(requests[0]?.text).toBe("Wait for the start date");
  });

  test("retries once with the problems when a reply doesn't check against the catalog", async () => {
    const { designer, requests } = scriptedPrompt([
      Effect.succeed(draft("employee.starts_on")),
      Effect.succeed(draft("employee.start_date")),
    ]);
    const result = await Effect.runPromise(design(designer));
    expect(result.workflow.steps[0]).toMatchObject({ until: "employee.start_date" });
    expect(requests.map((request) => request.requestId)).toEqual(["chat:c1", "chat:c1:retry"]);
    expect(requests[1]?.text).toContain("employee has no field starts_on");
  });

  test("fails with the retry's error when the retry doesn't decode either", async () => {
    const { designer, requests } = scriptedPrompt([
      Effect.succeed("Sure! Here you go."),
      Effect.succeed(draft("Start Date")),
    ]);
    const error = await Effect.runPromise(design(designer).pipe(Effect.flip));
    expect(error._tag).toBe("InvalidWorkflow");
    expect(error.message).toContain("dotted paths");
    expect(requests).toHaveLength(2);
  });

  test("doesn't retry when pi fails", async () => {
    const { designer, requests } = scriptedPrompt([
      Effect.fail(new PiError({ message: "Agent did not answer" })),
    ]);
    const error = await Effect.runPromise(design(designer).pipe(Effect.flip));
    expect(error._tag).toBe("PiError");
    expect(requests).toHaveLength(1);
  });
});

test("the instructions push automation around every human step", () => {
  const instructions = designInstructions(catalog, {});
  expect(instructions).toContain("Automate everything that can be automated");
  expect(instructions).toContain("- calendar.findTimes:");
});

describe("fixedProgress", () => {
  const answer = (fields: { thinking?: string; text?: string; requestId?: string }) => ({
    thinking: "",
    text: "",
    ...fields,
  });

  test("follows the answer from reading to reasoning to writing", () => {
    expect(fixedProgress(answer({}))).toBe("reading");
    expect(fixedProgress(answer({ thinking: "The user wants" }))).toBeUndefined();
    expect(fixedProgress(answer({ thinking: "Done.", text: '{"reply":"' }))).toBe("writing");
  });

  test("reads the retry after a rejected reply as a final check", () => {
    expect(
      fixedProgress(answer({ requestId: "chat:c1:retry", thinking: "That was rejected." })),
    ).toBe("checking");
    expect(fixedProgress(answer({ requestId: "chat:c1:retry", text: '{"reply":"' }))).toBe(
      "checking",
    );
  });
});

describe("pickProgress", () => {
  const responding = (response: unknown) => {
    const requests: Array<ClassifyRequest> = [];
    const classify = (request: ClassifyRequest) => {
      requests.push(request);
      return Effect.succeed(response);
    };
    return { classify, requests };
  };
  const choosing = (choice: string, confidence = 0.9) =>
    responding({
      model: "clef-flash",
      answers: { progress: { type: "choice", choice, confidence, probabilities: {} } },
    });

  test("asks one choice question about the latest reasoning", async () => {
    const { classify, requests } = choosing("timing");
    const phrase = await Effect.runPromise(
      pickProgress(classify, `${"x".repeat(5_000)}A wait step until the start date.`),
    );
    expect(phrase).toBe("timing");
    const state = requests[0]?.state as { reasoning: string };
    expect(state.reasoning).toHaveLength(2_000);
    expect(state.reasoning).toEndWith("A wait step until the start date.");
    expect(Object.keys(requests[0]?.questions.progress?.criteria ?? {})).not.toContain("writing");
  });

  test("fails when the classifier isn't sure", async () => {
    const { classify } = choosing("people", 0.2);
    const error = await Effect.runPromise(pickProgress(classify, "Steps.").pipe(Effect.flip));
    expect(error._tag).toBe("UnsurePick");
  });

  test("rejects a choice outside the list", async () => {
    const { classify } = choosing("writing");
    const result = await Effect.runPromise(pickProgress(classify, "Steps.").pipe(Effect.result));
    expect(result._tag).toBe("Failure");
  });

  test("rejects a response without an answer", async () => {
    const { classify } = responding({ model: "clef-flash", answers: {} });
    const result = await Effect.runPromise(pickProgress(classify, "Steps.").pipe(Effect.result));
    expect(result._tag).toBe("Failure");
  });
});
