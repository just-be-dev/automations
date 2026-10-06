/** Defines chat state and automation directory, overview, and template-usage records shared with callers. */
import * as Schema from "effect/Schema";
import { AskedQuestions, Question } from "../ai/ask-question/question.ts";
import { Trigger } from "../workflow/model.ts";
import { RunSummary } from "../workflow/run.ts";

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String,
}) {}

/**
 * One chat turn, stored so the studio can show the conversation again after a reload: the
 * person's message, the questions the planner asked on the way and how they were answered, and
 * the planner's reply in Markdown.
 */
export const Exchange = Schema.Struct({
  prompt: Schema.String,
  asked: Schema.optionalKey(Schema.Array(AskedQuestions)),
  reply: Schema.String,
});
export interface Exchange extends Schema.Schema.Type<typeof Exchange> {}

const WorkingChat = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  status: Schema.Literal("working"),
});
const FailedChat = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  status: Schema.Literal("failed"),
  error: Schema.String,
});

/** A design message waiting for a reply, or the last one the planner couldn't answer, as stored. */
export const StoredPendingChat = Schema.Union([WorkingChat, FailedChat]);
export type StoredPendingChat = typeof StoredPendingChat.Type;

/**
 * A design message as callers see it, derived from the working copy rather than stored: `asked`
 * holds the questions the planner's turn has asked and the person has answered so far, and the
 * status is `asking` while it waits for answers to `questions`.
 */
export const PendingChat = Schema.Union([
  Schema.Struct({
    ...WorkingChat.fields,
    asked: Schema.optionalKey(Schema.Array(AskedQuestions)),
  }),
  Schema.Struct({
    id: Schema.String,
    prompt: Schema.String,
    status: Schema.Literal("asking"),
    asked: Schema.optionalKey(Schema.Array(AskedQuestions)),
    questions: Schema.Array(Question),
  }),
  FailedChat,
]);
export type PendingChat = typeof PendingChat.Type;

/** An automation's entry in the index that backs `GET /api/automations`. */
export const AutomationSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  updatedAt: Schema.Finite,
});
export interface AutomationSummary extends Schema.Schema.Type<typeof AutomationSummary> {}

/** The overview lists failed reads alongside automations whose Durable Objects answered. */
export const AutomationOverview = Schema.Struct({
  ...AutomationSummary.fields,
  saved: Schema.optionalKey(
    Schema.Struct({
      trigger: Trigger,
      /** When a schedule trigger next starts runs, in epoch milliseconds. */
      nextRunAt: Schema.optionalKey(Schema.Finite),
    }),
  ),
  /** Runs still running or waiting, however old, newest first. */
  activeRuns: Schema.Array(RunSummary),
  lastRun: Schema.optionalKey(RunSummary),
  error: Schema.optionalKey(Schema.String),
});
export interface AutomationOverview extends Schema.Schema.Type<typeof AutomationOverview> {}

/** A listed automation whose saved workflow, draft, or both use a template. */
export const TemplateUser = Schema.Struct({
  ...AutomationSummary.fields,
  saved: Schema.Boolean,
  draft: Schema.Boolean,
});
export interface TemplateUser extends Schema.Schema.Type<typeof TemplateUser> {}

/** Who uses a template. Automations that couldn't answer are listed apart with their error. */
export const TemplateUsage = Schema.Struct({
  automations: Schema.Array(TemplateUser),
  unchecked: Schema.Array(Schema.Struct({ ...AutomationSummary.fields, error: Schema.String })),
});
export interface TemplateUsage extends Schema.Schema.Type<typeof TemplateUsage> {}
