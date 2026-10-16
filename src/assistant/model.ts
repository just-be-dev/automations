/** Wire models for a persistent, page-aware studio assistant conversation. */
import * as Schema from "effect/Schema";
import { Question } from "../ai/ask-question/question.ts";
import { ChangeProposal } from "../changes/model.ts";

export const PageContext = Schema.Struct({
  pathname: Schema.String,
  template: Schema.optionalKey(Schema.String),
  entityType: Schema.optionalKey(Schema.String),
  entityId: Schema.optionalKey(Schema.String),
  automationId: Schema.optionalKey(Schema.String),
  runId: Schema.optionalKey(Schema.String),
});
export type PageContext = typeof PageContext.Type;

export const AssistantExchange = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  reply: Schema.optionalKey(Schema.String),
  /** The person stopped the turn before it answered. */
  stopped: Schema.optionalKey(Schema.Boolean),
});
export const AssistantActivity = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  status: Schema.Literals(["working", "completed", "failed", "cancelled"]),
  href: Schema.optionalKey(Schema.String),
});
export type AssistantActivity = typeof AssistantActivity.Type;

export const AssistantState = Schema.Struct({
  sessionId: Schema.String,
  /** Named from the first message once the first turn starts; the thread directory mirrors it. */
  title: Schema.optionalKey(Schema.String),
  conversation: Schema.Array(AssistantExchange),
  status: Schema.Literals(["idle", "working", "confirming", "asking", "failed"]),
  activities: Schema.Array(AssistantActivity),
  confirmation: Schema.optionalKey(ChangeProposal),
  questions: Schema.optionalKey(
    Schema.Struct({ callId: Schema.String, questions: Schema.Array(Question) }),
  ),
  error: Schema.optionalKey(Schema.String),
});
export type AssistantState = typeof AssistantState.Type;

/** One of a person's studio agent threads, as the history view lists it. */
export const AssistantThread = Schema.Struct({
  id: Schema.String,
  /** Missing until the first reply names the thread, and again once it's cleared. */
  title: Schema.optionalKey(Schema.String),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  archived: Schema.Boolean,
});
export type AssistantThread = typeof AssistantThread.Type;
