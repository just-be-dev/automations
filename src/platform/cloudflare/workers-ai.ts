/** Selects production AI models and adapts an Ai binding for naming and classification, also used by evals. */
import * as Effect from "effect/Effect";
import { AutomationNamer, NamerError } from "../../agents/namer/namer.ts";
import { Classifier, ClassifierError, type ClassifierModel } from "../../ai/classifier.ts";

/** The planner, the assistant, and agent steps, through pi. */
export const PLANNER_MODEL = "@cf/moonshotai/kimi-k2.7-code";
/** Progress phrases (clef-flash) and decide steps (the step's model). */
export const CLASSIFIER_MODELS = {
  clef: "@cf/cloudflare/clef",
  "clef-flash": "@cf/cloudflare/clef-flash",
} as const satisfies Record<ClassifierModel, string>;
export const NAMING_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const workersAiNamer = (ai: Ai) =>
  AutomationNamer.of({
    complete: (request) =>
      Effect.tryPromise({
        try: () => ai.run(NAMING_MODEL, { ...request, messages: [...request.messages] }),
        catch: (cause) => new NamerError({ message: `Namer: ${messageOf(cause)}` }),
      }).pipe(
        Effect.map((output) =>
          typeof output === "object" && output !== null && "response" in output
            ? String(output.response ?? "")
            : "",
        ),
      ),
  });

export const workersAiClassifier = (ai: Ai) =>
  Classifier.of({
    classify: (request) =>
      Effect.tryPromise({
        try: () => ai.run(CLASSIFIER_MODELS[request.model], { ...request }),
        catch: (cause) =>
          new ClassifierError({ message: `Classifier ${request.model}: ${String(cause)}` }),
      }),
  });
