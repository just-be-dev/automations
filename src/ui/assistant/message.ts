import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { AssistantState } from "../../assistant/model.ts";

export const Message = defineMessageUnion({
  CompletedRestoreAssistant: { sessionId: Schema.String, collapsed: Schema.Boolean },
  FailedRestoreAssistant: { error: Schema.String },
  ClickedCollapse: {},
  CompletedPersistCollapsed: {},
  ClickedFollow: {},
  ClickedRetry: {},
  UpdatedInput: { value: Schema.String },
  SubmittedChat: {},
  ClickedConfirmation: { approved: Schema.Boolean },
  ClickedOption: { question: Schema.Int, label: Schema.String },
  UpdatedAnswer: { question: Schema.Int, value: Schema.String },
  ClickedAnswers: { skipped: Schema.Boolean },
  SucceededRequest: {
    sessionId: Schema.String,
    sequence: Schema.Int,
    state: AssistantState,
    sentInput: Schema.String,
  },
  FailedRequest: { sessionId: Schema.String, sequence: Schema.Int, error: Schema.String },
});
export type Message = typeof Message.Type;
