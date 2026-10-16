import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import { AssistantState, AssistantThread } from "../../assistant/model.ts";
import { Questionnaire } from "../domain/index.ts";
import * as Dictation from "../dictation/index.ts";

export const Request = defineTaggedUnion({
  Ready: {},
  Sending: {},
  Failed: { error: Schema.String },
});

/** The person's threads as the history view last loaded them. */
export const ThreadList = defineTaggedUnion({
  Loading: {},
  Ready: { threads: Schema.Array(AssistantThread) },
  Failed: { error: Schema.String },
});
export type ThreadList = typeof ThreadList.Type;

/** What the panel shows: the open thread's chat, or the list of threads to switch to. */
export const Panel = defineTaggedUnion({
  Chat: {},
  History: { threads: ThreadList, showArchived: Schema.Boolean },
});
export type Panel = typeof Panel.Type;

/** Whether the person is being asked to confirm clearing the open thread. */
export const Clearing = defineTaggedUnion({
  Idle: {},
  Confirming: {},
});

export const Model = Schema.Struct({
  dictation: Dictation.Model,
  sessionId: Schema.String,
  collapsed: Schema.Boolean,
  follow: Schema.Boolean,
  input: Schema.String,
  sequence: Schema.Int,
  request: Request,
  maybeState: Schema.Option(AssistantState),
  maybeQuestionnaire: Schema.Option(Questionnaire.Questionnaire),
  seenActivities: Schema.Array(Schema.String),
  panel: Panel,
  clearing: Clearing,
});
export type Model = typeof Model.Type;
export const initial = Model.make({
  dictation: Dictation.initial,
  sessionId: "",
  collapsed: false,
  follow: false,
  input: "",
  sequence: 0,
  request: Request.Ready(),
  maybeState: Option.none(),
  maybeQuestionnaire: Option.none(),
  seenActivities: [],
  panel: Panel.Chat(),
  clearing: Clearing.Idle(),
});

/** Whether the open thread's turn is still going: working, or waiting on the person. */
export const turnInProgress = (model: Model) =>
  Option.exists(model.maybeState, (state) => state.status !== "idle" && state.status !== "failed");
