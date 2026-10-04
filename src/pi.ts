import { createModels } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  type Conversation,
  type ConversationId,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { openPiStorage } from "./pi-storage.ts";
import { createAI } from "agents/models/pi-ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * pi-durable hosted in an automation's Durable Object. pi keeps conversations, model turns, and
 * submissions in its own `pi_*` tables in the object's SQLite database, so an interrupted turn
 * resumes when the object reopens pi.
 */

export class PiError extends Schema.TaggedError<PiError>()("PiError", {
  message: Schema.String,
}) {}

export interface PromptOptions {
  /** Defaults to the root conversation. */
  readonly conversation?: number;
  readonly text: string;
  /** Idempotency key: resubmitting the same ID waits for the original submission. */
  readonly requestId?: string;
}

export interface PiAgent {
  /** Creates an ownerless conversation configured like the root and returns its ID. */
  readonly createConversation: Effect.Effect<number, PiError>;
  /** Submits user input and resolves with the assistant's final answer. */
  readonly prompt: (options: PromptOptions) => Effect.Effect<string, PiError>;
}

export interface PiAgentOptions {
  readonly storage: DurableObjectStorage;
  readonly ai: Ai;
  readonly model: string;
}

// pi takes a chord `Context` on every call without re-exporting chord. This is chord's
// `BACKGROUND_CONTEXT` written structurally: no values, never cancelled.
const context: Parameters<Harness["close"]>[0] = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "[Context automations background]",
});

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new PiError({
        message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

// NOTE: pi brands numeric IDs; storage hands back the plain number we persisted for this conversation.
const toConversationId = (id: number) => id as ConversationId;

const assistantText = (entry: { readonly model?: ReadonlyArray<unknown> } | undefined) => {
  const message = entry?.model?.[0];
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    message.role !== "assistant" ||
    !("content" in message) ||
    !Array.isArray(message.content)
  ) {
    return "";
  }
  return message.content
    .map((part: { readonly type?: string; readonly text?: string }) =>
      part.type === "text" ? (part.text ?? "") : "",
    )
    .join("");
};

export const openPiAgent = Effect.fn("PiAgent.open")(function* (options: PiAgentOptions) {
  const ai = createAI({ binding: options.ai });
  const model = ai(options.model);
  const agent = { model: { provider: model.provider, modelId: model.id } satisfies ModelRef };

  const harness = yield* attempt("Open pi", async () => {
    const models = createModels();
    models.setProvider(ai.provider);
    const storage = await openPiStorage(options.storage);
    const opened = await Harness.open(storage, { models, registry: createRegistry() }, context);
    await opened.root(context, { agent });
    opened.resume();
    return opened;
  });

  const conversation = (id: number | undefined) =>
    attempt("Find pi conversation", async (): Promise<Conversation | undefined> =>
      id === undefined
        ? harness.root(context, { agent })
        : harness.conversation(toConversationId(id), context),
    ).pipe(
      Effect.filterOrFail(
        (found): found is Conversation => found !== undefined,
        () => new PiError({ message: `Unknown pi conversation ${id}` }),
      ),
    );

  const createConversation = attempt("Create pi conversation", () =>
    harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context),
  ).pipe(
    Effect.map((created) => Number(created.id)),
    Effect.withSpan("PiAgent.createConversation"),
  );

  const prompt = Effect.fn("PiAgent.prompt")(function* (prompt: PromptOptions) {
    const target = yield* conversation(prompt.conversation);
    const settled = yield* attempt("Run pi prompt", async () => {
      const submission = await target.submit(
        {
          type: "input",
          content: prompt.text,
          whenBusy: "followUp",
          ...(prompt.requestId === undefined ? {} : { requestId: prompt.requestId }),
        },
        context,
      );
      return submission.wait(context);
    });
    if (settled.status === "unanswered") {
      return yield* new PiError({ message: `Agent did not answer: ${settled.reason}` });
    }
    if (settled.type !== "input") {
      return "";
    }
    const answer = settled.answer;
    const entry = yield* attempt("Read pi answer", () =>
      target.commit((tx) => tx.entry(AssistantEntry, answer), context),
    );
    return assistantText(entry);
  });

  return { createConversation, prompt } satisfies PiAgent;
});
