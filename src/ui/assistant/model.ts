import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import { AssistantState } from "../../assistant/model.ts";
import { Questionnaire } from "../domain/index.ts";

export const Request = defineTaggedUnion({
  Ready: {},
  Sending: {},
  Failed: { error: Schema.String },
});
export const Model = Schema.Struct({
  sessionId: Schema.String,
  collapsed: Schema.Boolean,
  follow: Schema.Boolean,
  input: Schema.String,
  sequence: Schema.Int,
  request: Request,
  maybeState: Schema.Option(AssistantState),
  maybeQuestionnaire: Schema.Option(Questionnaire.Questionnaire),
  seenActivities: Schema.Array(Schema.String),
});
export type Model = typeof Model.Type;
export const initial = Model.make({
  sessionId: "",
  collapsed: false,
  follow: false,
  input: "",
  sequence: 0,
  request: Request.Ready(),
  maybeState: Option.none(),
  maybeQuestionnaire: Option.none(),
  seenActivities: [],
});
