/** Addresses durable assistant sessions independently of their platform host. */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { QuestionsAnswer } from "../ai/ask-question/question.ts";
import type { AssistantState, PageContext } from "./model.ts";

export interface AssistantClient {
  readonly inspect: () => Effect.Effect<AssistantState, unknown>;
  readonly chat: (message: string, context: PageContext) => Effect.Effect<AssistantState, unknown>;
  readonly confirm: (
    proposalId: string,
    approved: boolean,
  ) => Effect.Effect<AssistantState, unknown>;
  readonly answer: (
    callId: string,
    answer: QuestionsAnswer,
  ) => Effect.Effect<AssistantState, unknown>;
}

export class Assistants extends Context.Service<
  Assistants,
  {
    readonly get: (owner: string, sessionId: string) => AssistantClient;
  }
>()("automations/Assistants") {}
