import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ClassifyRequest } from "./design.ts";

export class ClassifierError extends Schema.TaggedError<ClassifierError>()("ClassifierError", {
  message: Schema.String,
}) {}

/** Selects the topic of the designer's reasoning; the domain validates its answer. */
export class ProgressClassifier extends Context.Service<
  ProgressClassifier,
  { readonly classify: (request: ClassifyRequest) => Effect.Effect<unknown, ClassifierError> }
>()("automations/ProgressClassifier") {}
