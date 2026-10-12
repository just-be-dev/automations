/** Defines the classifier service: a clef model answers choice questions about a state. */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** `clef-flash` is quick, for simple routing; `clef` is slower and makes more nuanced calls. */
export const ClassifierModel = Schema.Literals(["clef", "clef-flash"]);
export type ClassifierModel = typeof ClassifierModel.Type;

/** Asks the classifier to pick one of `criteria`'s keys, each described by its value. */
export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** A classifier request: the state to read and the questions to answer, keyed by ID. */
export interface ClassifyRequest {
  readonly model: ClassifierModel;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, ChoiceQuestion>>;
}

/** The classifier's answer to one choice question. */
export const ChoiceAnswer = Schema.Struct({
  choice: Schema.String,
  confidence: Schema.Finite,
  probabilities: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
});

export class ClassifierError extends Schema.TaggedError<ClassifierError>()("ClassifierError", {
  message: Schema.String,
}) {}

/** Sends a request and resolves with the classifier's raw response; callers decode it. */
export class Classifier extends Context.Service<
  Classifier,
  { readonly classify: (request: ClassifyRequest) => Effect.Effect<unknown, ClassifierError> }
>()("automations/Classifier") {}
