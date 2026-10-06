/** Checks draft acceptance, planner retries, current instructions, and user-facing progress selection. */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { Catalog } from "../../workflow/catalog.ts";
import type { Workflow } from "../../workflow/model.ts";
import { planOf, type Plan } from "./plan.ts";
import {
  fixedProgress,
  pickProgress,
  planDraft,
  plannerInstructions,
  turnMessage,
  type ClassifyRequest,
} from "./planner.ts";
import type { Question } from "../../ai/ask-question/question.ts";
import { plannerTools } from "./tools.ts";
import { PiError, type AgentTool, type AgentToolError, type PromptOptions } from "../../ai/pi.ts";

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

const draft: Workflow = {
  name: "Onboarding",
  trigger: { kind: "entity", entity: "employee", fields: ["start_date"] },
  steps: [{ id: "wait", title: "Wait", kind: "wait", until: "employee.start_date" }],
};

/** The planner's tools over a working copy in memory. */
const workingCopy = (initial: Plan) => {
  let plan = initial;
  const asked: Array<{ readonly callId: string; readonly questions: ReadonlyArray<Question> }> = [];
  const tools = plannerTools(
    {
      read: Effect.sync(() => plan),
      write: (next) => Effect.sync(() => void (plan = next)),
      ask: (callId, questions) =>
        Effect.sync(() => {
          asked.push({ callId, questions });
          return {
            kind: "answers" as const,
            answers: questions.map((_, index) => (index === 0 ? "HR" : null)),
          };
        }),
    },
    Effect.succeed(catalog),
  );
  const call = (name: string, args: unknown = {}) =>
    Effect.suspend(() => {
      const tool = tools.find((candidate: AgentTool) => candidate.name === name);
      return tool === undefined
        ? Effect.die(`No tool ${name}`)
        : tool.execute(args, { id: "call-1" });
    });
  return { plan: Effect.sync(() => plan), asked, call };
};

type Copy = ReturnType<typeof workingCopy>;

/**
 * A stand-in for the planner's pi agent: each scripted turn makes tool calls on the working copy
 * and answers. It records each request and the system prompt instructions it was given.
 */
const scripted = (
  copy: Copy,
  turns: ReadonlyArray<(copy: Copy) => Effect.Effect<string, PiError | AgentToolError>>,
) => {
  const requests: Array<PromptOptions> = [];
  const instructions: Array<string> = [];
  const planner = {
    prompt: (options: PromptOptions) => {
      requests.push(options);
      const turn = turns[requests.length - 1];
      // pi shows a failed call to the model; in a script it's a mistake in the test.
      return turn === undefined
        ? Effect.die("No scripted turn left")
        : turn(copy).pipe(Effect.catchTag("AgentToolError", Effect.die));
    },
    instruct: (text: string) => Effect.sync(() => void instructions.push(text)),
  };
  return { planner, requests, instructions };
};

const waitUntil = (copy: Copy, until: string) =>
  copy.call("put_steps", { steps: [{ id: "wait", title: "Wait", kind: "wait", until }] });

const plan = (
  copy: Copy,
  script: ReturnType<typeof scripted>,
  current: { readonly draft?: Workflow } = { draft },
) => planDraft(script.planner, copy.plan, catalog, current.draft, "c1", "Wait for the start date");

describe("planDraft", () => {
  test("sends the catalog as the system prompt, and the draft in YAML before the message", async () => {
    const copy = workingCopy(planOf(draft));
    const script = scripted(copy, [
      (copy) => waitUntil(copy, "employee.start_date").pipe(Effect.as("Nothing to change")),
    ]);
    const result = await Effect.runPromise(plan(copy, script));
    expect(result).toEqual({ reply: "Nothing to change" });
    expect(script.requests.map((request) => request.requestId)).toEqual(["chat:c1"]);
    expect(script.instructions).toEqual([plannerInstructions(catalog)]);
    expect(script.instructions[0]).toContain("- employee (Employee; shown as its name)");
    expect(script.requests[0]?.text).toBe(turnMessage(draft, "Wait for the start date"));
    expect(script.requests[0]?.text).toContain("```yaml\nname: Onboarding\n");
    expect(script.requests[0]?.text).toEndWith("The person's message:\n\nWait for the start date");
  });

  test("assembles the edits into a draft that checks", async () => {
    const copy = workingCopy(planOf(undefined));
    const script = scripted(copy, [
      (copy) =>
        Effect.gen(function* () {
          yield* copy.call("set_workflow", {
            name: "Onboarding",
            trigger: { kind: "entity", entity: "employee" },
            steps: ["wait"],
          });
          yield* waitUntil(copy, "{{employee.start_date}}");
          return "  Waits for the start date  ";
        }),
    ]);
    const result = await Effect.runPromise(plan(copy, script, {}));
    expect(result.reply).toBe("Waits for the start date");
    expect(result.workflow?.steps[0]).toMatchObject({ until: "employee.start_date" });
    expect(script.requests[0]?.text).toStartWith("There is no workflow yet.");
  });

  test("retries once with the problems when the edits don't check against the catalog", async () => {
    const copy = workingCopy(planOf(draft));
    const script = scripted(copy, [
      (copy) => waitUntil(copy, "employee.starts_on").pipe(Effect.as("Done")),
      (copy) => waitUntil(copy, "employee.start_date").pipe(Effect.as("Fixed")),
    ]);
    const result = await Effect.runPromise(plan(copy, script));
    expect(result.reply).toBe("Fixed");
    expect(script.requests.map((request) => request.requestId)).toEqual([
      "chat:c1",
      "chat:c1:retry",
    ]);
    expect(script.requests[1]?.text).toContain("employee has no field starts_on");
  });

  test("retries a blank answer, and fails with the retry's problems", async () => {
    const copy = workingCopy(planOf(draft));
    const script = scripted(copy, [
      () => Effect.succeed(" "),
      (copy) =>
        copy.call("set_workflow", { steps: ["wait", "missing"] }).pipe(Effect.as("Added a step")),
    ]);
    const error = await Effect.runPromise(plan(copy, script).pipe(Effect.flip));
    expect(script.requests[1]?.text).toContain("Answer the person");
    expect(error._tag).toBe("InvalidWorkflow");
    expect(error.message).toContain("A list names step missing");
  });

  test("doesn't retry when pi fails", async () => {
    const copy = workingCopy(planOf(draft));
    const script = scripted(copy, [
      () => Effect.fail(new PiError({ message: "Agent did not answer" })),
    ]);
    const error = await Effect.runPromise(plan(copy, script).pipe(Effect.flip));
    expect(error._tag).toBe("PiError");
    expect(script.requests).toHaveLength(1);
  });
});

describe("the planner's tools", () => {
  test("save the steps that decode and say why the others didn't", async () => {
    const copy = workingCopy(planOf(draft));
    const answer = await Effect.runPromise(
      copy.call("put_steps", {
        steps: [
          { id: "pause", title: "Pause", kind: "wait", duration: "3 days" },
          { id: "bad", title: "Bad", kind: "wait", duration: "soon" },
        ],
      }),
    );
    expect(answer).toStartWith("Saved pause.\nNot saved, fix and put again:\nStep bad:");
    expect(answer).toContain("Step pause isn't in any list");
    expect(Object.keys((await Effect.runPromise(copy.plan)).stepsById)).toEqual(["wait", "pause"]);
  });

  test("fail when nothing could be saved", async () => {
    const copy = workingCopy(planOf(draft));
    const error = await Effect.runPromise(
      copy.call("put_steps", { steps: [{ title: "No ID", kind: "stop" }] }).pipe(Effect.flip),
    );
    expect(error.message).toStartWith("Nothing was saved.\nStep 1:");
  });

  test("show the working copy in YAML and check it against the catalog", async () => {
    const copy = workingCopy(planOf(draft));
    await Effect.runPromise(waitUntil(copy, "employee.starts_on"));
    expect(await Effect.runPromise(copy.call("show_workflow"))).toContain(
      "until: employee.starts_on",
    );
    expect(await Effect.runPromise(copy.call("check_workflow"))).toContain(
      "employee has no field starts_on",
    );
    await Effect.runPromise(copy.call("remove_steps", { ids: ["wait", "nope"] }));
    expect(await Effect.runPromise(copy.call("check_workflow"))).toContain("1–20 steps");
  });

  test("ask questions through the working copy's store, and return the answers", async () => {
    const copy = workingCopy(planOf(draft));
    const before = await Effect.runPromise(copy.plan);
    const questions = [
      {
        question: "Who approves the email?",
        header: "Approver",
        options: [{ label: "Managers" }, { label: "HR" }],
      },
      {
        question: "Which time zones should it use?",
        header: "Time zones",
        multiSelect: true,
        options: [
          { label: "Europe/London", description: "The London office" },
          { label: "America/New_York" },
        ],
      },
    ];
    expect(await Effect.runPromise(copy.call("ask_question", { questions }))).toBe(
      "The person answered:\n- Who approves the email? HR\n- Which time zones should it use? (skipped)\nCarry on with their answers.",
    );
    expect(copy.asked).toEqual([{ callId: "call-1", questions }]);
    expect(await Effect.runPromise(copy.plan)).toEqual(before);
  });

  test("set permissions", async () => {
    const copy = workingCopy(planOf(draft));
    await Effect.runPromise(
      copy.call("set_permissions", { permissions: { "email.send": { ask: "ops" } } }),
    );
    expect((await Effect.runPromise(copy.plan)).permissions).toEqual({
      "email.send": { ask: "ops" },
    });
  });
});

test("the instructions offer every kind of trigger", () => {
  const instructions = plannerInstructions(catalog);
  for (const kind of ["manual", "entity", "schedule", "date"]) {
    expect(instructions).toContain(`{"kind":"${kind}"`);
  }
  expect(instructions).toContain(
    "Use a manual trigger when a person starts the process themselves",
  );
});

test("the instructions push automation around every human step", () => {
  const instructions = plannerInstructions(catalog);
  expect(instructions).toContain("Automate everything that can be automated");
  expect(instructions).toContain("- calendar.findTimes:");
});

describe("fixedProgress", () => {
  const answer = (fields: {
    thinking?: string;
    text?: string;
    requestId?: string;
    tools?: ReadonlyArray<string>;
  }) => ({ thinking: "", text: "", tools: [], ...fields });

  test("follows the answer from reading to reasoning to writing", () => {
    expect(fixedProgress(answer({}))).toBe("reading");
    expect(fixedProgress(answer({ thinking: "The user wants" }))).toBeUndefined();
    expect(fixedProgress(answer({ thinking: "Done.", text: '{"reply":"' }))).toBe("writing");
  });

  test("follows the tool the planner is running", () => {
    expect(fixedProgress(answer({ thinking: "Adding steps", tools: ["put_steps"] }))).toBe(
      "planning",
    );
    expect(fixedProgress(answer({ tools: ["set_permissions", "check_workflow"] }))).toBe("people");
    expect(fixedProgress(answer({ tools: ["check_workflow"] }))).toBe("checking");
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
