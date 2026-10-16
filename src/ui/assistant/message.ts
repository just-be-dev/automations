import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { AssistantState, AssistantThread } from "../../assistant/model.ts";
import * as Dictation from "../dictation/index.ts";

export const Message = defineMessageUnion({
  GotDictationMessage: { message: Dictation.Message },
  CompletedRestoreAssistant: { sessionId: Schema.String, collapsed: Schema.Boolean },
  FailedRestoreAssistant: { error: Schema.String },
  ClickedCollapse: {},
  CompletedPersistCollapsed: {},
  ClickedNewThread: {},
  CompletedCreateThread: { sessionId: Schema.String, input: Schema.String },
  FailedCreateThread: { error: Schema.String },
  CompletedFocusInput: {},
  ClickedHistory: {},
  SucceededLoadThreads: { threads: Schema.Array(AssistantThread) },
  FailedLoadThreads: { error: Schema.String },
  ClickedShowArchived: {},
  ClickedThread: { sessionId: Schema.String },
  CompletedPersistSession: {},
  ClickedArchiveThread: { sessionId: Schema.String, archived: Schema.Boolean },
  SucceededArchiveThread: {
    sessionId: Schema.String,
    archived: Schema.Boolean,
    threads: Schema.Array(AssistantThread),
  },
  FailedArchiveThread: { error: Schema.String },
  ClickedClearThread: {},
  ClickedCancelClear: {},
  ClickedConfirmClear: {},
  ClickedStop: {},
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
