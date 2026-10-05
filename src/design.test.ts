import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { designDraft } from "./design.ts";
import { PiError, type PromptOptions } from "./pi.ts";

const draft = (until: string) =>
  JSON.stringify({
    reply: "Waits for the start date",
    workflow: {
      name: "Onboarding",
      event: null,
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

describe("designDraft", () => {
  test("uses a reply that decodes without retrying", async () => {
    const { prompt, requests } = scriptedPrompt([Effect.succeed(draft("input.start_date"))]);
    const result = await Effect.runPromise(designDraft(prompt, "c1", "Wait for the start date"));
    expect(result.workflow.name).toBe("Onboarding");
    expect(requests.map((request) => request.requestId)).toEqual(["chat:c1"]);
  });

  test("retries once with the decoding error when a reply doesn't decode", async () => {
    const { prompt, requests } = scriptedPrompt([
      Effect.succeed(draft("start.date")),
      Effect.succeed(draft("input.start_date")),
    ]);
    const result = await Effect.runPromise(designDraft(prompt, "c1", "Wait for the start date"));
    expect(result.workflow.steps[0]).toMatchObject({ until: "input.start_date" });
    expect(requests.map((request) => request.requestId)).toEqual(["chat:c1", "chat:c1:retry"]);
    expect(requests[1]?.text).toContain("References start with input.");
  });

  test("fails with the retry's error when the retry doesn't decode either", async () => {
    const { prompt, requests } = scriptedPrompt([
      Effect.succeed("Sure! Here you go."),
      Effect.succeed(draft("start.date")),
    ]);
    const error = await Effect.runPromise(
      designDraft(prompt, "c1", "Wait for the start date").pipe(Effect.flip),
    );
    expect(error._tag).toBe("InvalidWorkflow");
    expect(error.message).toContain("References start with input.");
    expect(requests).toHaveLength(2);
  });

  test("doesn't retry when pi fails", async () => {
    const { prompt, requests } = scriptedPrompt([
      Effect.fail(new PiError({ message: "Agent did not answer" })),
    ]);
    const error = await Effect.runPromise(
      designDraft(prompt, "c1", "Wait for the start date").pipe(Effect.flip),
    );
    expect(error._tag).toBe("PiError");
    expect(requests).toHaveLength(1);
  });
});
