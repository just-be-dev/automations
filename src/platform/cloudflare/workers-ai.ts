/** Selects production AI models and adapts an Ai binding for naming and classification, also used by evals. */
import * as Effect from "effect/Effect";
import { Namer, NamerError } from "../../agents/namer/namer.ts";
import { Classifier, ClassifierError, type ClassifierModel } from "../../ai/classifier.ts";

/**
 * The planner, the assistant, and agent steps, through pi: Claude Sonnet 5.5 through AI Gateway,
 * authenticated with the Anthropic key stored on the gateway (BYOK; see `AI_GATEWAY_ID` in `pi.ts`).
 */
export const PLANNER_MODEL = "anthropic/claude-sonnet-5-5";
/** How hard the planner model reasons. */
export const PLANNER_THINKING_LEVEL = "medium";
/** Progress phrases (clef-flash) and decide steps (the step's model). */
export const CLASSIFIER_MODELS = {
  clef: "@cf/cloudflare/clef",
  "clef-flash": "@cf/cloudflare/clef-flash",
} as const satisfies Record<ClassifierModel, string>;
export const NAMING_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Runs a model for its JSON answer, always asking the binding for the raw `Response`. The binding
 * keeps each call's options on the shared `env.AI` object until that call's response arrives, so a
 * call without `returnRawResponse` that starts while pi's call is waiting replaces pi's options,
 * and pi gets a bare stream instead of a `Response` (`model_error`, reading 'get'). With every
 * caller asking for the raw response, whichever options win return the same thing.
 */
const runJson = async (
  ai: Ai,
  model: string,
  inputs: Record<string, unknown>,
): Promise<unknown> => {
  const response = await ai.run(model, inputs, { returnRawResponse: true });
  if (!(response instanceof Response))
    throw new Error(`Workers AI returned ${typeof response} instead of a Response`);
  if (!response.ok)
    throw new Error(
      `Workers AI answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  // A body that isn't JSON rejects here, inside the caller's Effect.tryPromise.
  return response.json();
};

export const workersAiNamer = (ai: Ai) =>
  Namer.of({
    complete: (request) =>
      Effect.tryPromise({
        try: () => runJson(ai, NAMING_MODEL, { ...request, messages: [...request.messages] }),
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
        try: () => runJson(ai, CLASSIFIER_MODELS[request.model], { ...request }),
        catch: (cause) =>
          new ClassifierError({ message: `Classifier ${request.model}: ${String(cause)}` }),
      }),
  });
