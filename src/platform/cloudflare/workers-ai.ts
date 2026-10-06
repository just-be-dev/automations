import * as Effect from "effect/Effect";
import { AutomationNamer, NamerError } from "../../agents/namer/namer.ts";
import { ClassifierError, ProgressClassifier } from "../../agents/planner/progress-classifier.ts";

/**
 * The Workers AI models each agent uses, and the services that call them over an `Ai` binding.
 * Nothing here imports Alchemy, so the evals in `evals/` run these same adapters from Bun over
 * Workers AI's REST API.
 */

/** The planner, and agent and decide steps, through pi. */
export const PLANNER_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const PROGRESS_MODEL = "@cf/cloudflare/clef-flash";
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
  ProgressClassifier.of({
    classify: (request) =>
      Effect.tryPromise({
        try: () => ai.run(PROGRESS_MODEL, { model: "clef-flash", ...request }),
        catch: (cause) => new ClassifierError({ message: `Progress classifier: ${String(cause)}` }),
      }),
  });
