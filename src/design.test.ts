import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { Catalog } from "./catalog.ts";
import { designDraft, designInstructions } from "./design.ts";
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

/** A stand-in for `PiAgent.prompt` that answers from a script and records each request. */
const scriptedPrompt = (answers: ReadonlyArray<Effect.Effect<string, PiError>>) => {
  const requests: Array<PromptOptions> = [];
  const prompt = (options: PromptOptions) => {
    requests.push(options);
    return answers[requests.length - 1] ?? Effect.die("No scripted answer left");
  };
  return { prompt, requests };
};

const design = (prompt: ReturnType<typeof scriptedPrompt>["prompt"]) =>
  designDraft(prompt, catalog, "c1", "Wait for the start date");

describe("designDraft", () => {
  test("sends the catalog and uses a reply that checks without retrying", async () => {
    const { prompt, requests } = scriptedPrompt([Effect.succeed(draft("employee.start_date"))]);
    const result = await Effect.runPromise(design(prompt));
    expect(result.workflow.name).toBe("Onboarding");
    expect(requests.map((request) => request.requestId)).toEqual(["chat:c1"]);
    expect(requests[0]?.text).toContain("- employee (Employee; shown as its name)");
  });

  test("retries once with the problems when a reply doesn't check against the catalog", async () => {
    const { prompt, requests } = scriptedPrompt([
      Effect.succeed(draft("employee.starts_on")),
      Effect.succeed(draft("employee.start_date")),
    ]);
    const result = await Effect.runPromise(design(prompt));
    expect(result.workflow.steps[0]).toMatchObject({ until: "employee.start_date" });
    expect(requests.map((request) => request.requestId)).toEqual(["chat:c1", "chat:c1:retry"]);
    expect(requests[1]?.text).toContain("employee has no field starts_on");
  });

  test("fails with the retry's error when the retry doesn't decode either", async () => {
    const { prompt, requests } = scriptedPrompt([
      Effect.succeed("Sure! Here you go."),
      Effect.succeed(draft("Start Date")),
    ]);
    const error = await Effect.runPromise(design(prompt).pipe(Effect.flip));
    expect(error._tag).toBe("InvalidWorkflow");
    expect(error.message).toContain("dotted paths");
    expect(requests).toHaveLength(2);
  });

  test("doesn't retry when pi fails", async () => {
    const { prompt, requests } = scriptedPrompt([
      Effect.fail(new PiError({ message: "Agent did not answer" })),
    ]);
    const error = await Effect.runPromise(design(prompt).pipe(Effect.flip));
    expect(error._tag).toBe("PiError");
    expect(requests).toHaveLength(1);
  });
});

test("the instructions push automation around every human step", () => {
  const instructions = designInstructions(catalog);
  expect(instructions).toContain("Automate everything that can be automated");
  expect(instructions).toContain("- calendar.findTimes:");
});
