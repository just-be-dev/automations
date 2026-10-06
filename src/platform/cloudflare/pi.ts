import { createModels } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
  type Conversation,
  type ConversationId,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { openPiStorage } from "./pi-storage.ts";
import { createAI } from "agents/models/pi-ai";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  PiAgent,
  PiError,
  type AgentTool,
  type LiveAnswer,
  type PromptOptions,
} from "../../ai/pi.ts";

/**
 * pi-durable hosted in an automation's Durable Object. pi keeps conversations, model turns, and
 * submissions in its own `pi_*` tables in the object's SQLite database, so an interrupted turn
 * resumes when the object reopens pi.
 */

export interface PiAgentOptions {
  readonly storage: DurableObjectStorage;
  readonly ai: Ai;
  readonly model: string;
  /** Offered to the root conversation only. */
  readonly tools: ReadonlyArray<AgentTool>;
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

/** Joins an assistant message's `text` or `thinking` parts. */
const assistantContent = (message: unknown, type: "text" | "thinking") => {
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
    .map((part: { readonly type?: string; readonly text?: string; readonly thinking?: string }) =>
      part.type === type ? (part[type] ?? "") : "",
    )
    .join("");
};

const objectType = (schema: unknown) =>
  typeof schema === "object" &&
  schema !== null &&
  "type" in schema &&
  (schema.type === "object" || schema.type === "array");

/** Models sometimes send a nested argument as a JSON string; this parses it back. */
const parseStringArguments = (parameters: AgentTool["parameters"], args: unknown) => {
  const properties = parameters["properties"];
  if (typeof args !== "object" || args === null || typeof properties !== "object") {
    return args;
  }
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => {
      if (typeof value !== "string" || !objectType(Reflect.get(properties ?? {}, name))) {
        return [name, value];
      }
      try {
        return [name, JSON.parse(value) as unknown];
      } catch {
        return [name, value];
      }
    }),
  );
};

/**
 * Every tool runs alone, so edits never interleave, and may run again after a restart, which the
 * tools allow by being idempotent. A tool's failure reaches the model as an error result.
 */
const toolExtension = (tools: ReadonlyArray<AgentTool>) =>
  defineExtension({
    name: "automation",
    tools: tools.map((tool) =>
      defineTool({
        name: tool.name,
        description: tool.description,
        // TypeBox 1 validates plain JSON Schema.
        parameters: tool.parameters,
        replay: "safe",
        executionMode: "sequential",
        // pi validates what this returns against `parameters`.
        prepareArguments: (args) => parseStringArguments(tool.parameters, args),
        execute: async (args, api) => {
          const result = await Effect.runPromise(
            Effect.result(tool.execute(args, { id: String(api.taskId) })),
          );
          if (Result.isFailure(result)) {
            throw new Error(result.failure.message);
          }
          return { content: [{ type: "text", text: result.success }] };
        },
      }),
    ),
  });

const assistantText = (entry: { readonly model?: ReadonlyArray<unknown> } | undefined) =>
  assistantContent(entry?.model?.[0], "text");

export const openPiAgent = Effect.fn("PiAgent.open")(function* (options: PiAgentOptions) {
  const ai = createAI({ binding: options.ai });
  const model = ai(options.model);
  const agent = { model: { provider: model.provider, modelId: model.id } satisfies ModelRef };

  const { harness, rootId } = yield* attempt("Open pi", async () => {
    const models = createModels();
    models.setProvider(ai.provider);
    const storage = await openPiStorage(options.storage);
    const registry = createRegistry();
    const tools = toolExtension(options.tools);
    registry.install(tools);
    // Conversations select no extension unless they ask, so agent steps never see the tools.
    const opened = await Harness.open(
      storage,
      { models, registry, settings: { extensions: [] } },
      context,
    );
    const root = await opened.root(context, { agent });
    // Before resuming, so an answer interrupted mid-run keeps its tools.
    await root.configure({ extensions: [tools] }, context);
    opened.resume();
    return { harness: opened, rootId: root.id };
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

  const instruct = (instructions: string) =>
    conversation(undefined).pipe(
      Effect.flatMap((root) =>
        attempt("Set pi instructions", () => root.configure({ instructions }, context)),
      ),
      Effect.withSpan("PiAgent.instruct"),
    );

  // pi commits the in-flight response at most every 100 ms, so this trails the model slightly.
  const liveAnswer = attempt("Read pi live answer", async (): Promise<LiveAnswer | undefined> => {
    const live = await harness.snapshot(LiveDoc, rootId, context);
    const run = live?.run;
    if (run === undefined) {
      return undefined;
    }
    const { submissions } = await harness.inspect(context);
    const requestId = submissions.find((submission) =>
      run.inputs.includes(submission.id),
    )?.requestId;
    const message = live?.generation?.message;
    return {
      ...(requestId === undefined ? {} : { requestId }),
      thinking: assistantContent(message, "thinking"),
      text: assistantContent(message, "text"),
      tools: (live?.tools ?? []).flatMap((slot) => (slot.status === "done" ? [] : [slot.name])),
    };
  }).pipe(Effect.withSpan("PiAgent.liveAnswer"));

  return PiAgent.of({ createConversation, prompt, instruct, liveAnswer });
});
