/** Implements PiAgent with resumable pi-durable conversations, root-only tools, and model calls through the AI binding. */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
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
  type Storage,
} from "@earendil-works/pi-durable";
import { assistantContent, readTrace } from "./pi-trace.ts";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
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
 * pi-durable hosted in a Durable Object: an automation's, for its planner and agent steps, or a
 * studio assistant session's. pi keeps conversations, model turns, and submissions in its own
 * `pi_*` tables in the object's SQLite database (`openPiStorage`), so an interrupted turn resumes
 * when the object reopens pi. The evals open it over memory instead.
 */

export interface PiAgentOptions {
  readonly storage: () => Promise<Storage>;
  readonly ai: Ai;
  /** A Workers AI id (`@cf/…`), or `anthropic/<id>` for an Anthropic model through AI Gateway. */
  readonly model: string;
  /** How hard the model reasons; absent, pi's default. */
  readonly thinkingLevel?: ModelThinkingLevel;
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
  const schemas = new Map(Object.entries(properties ?? {}));
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => {
      if (typeof value !== "string" || !objectType(schemas.get(name))) {
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
        // Aborting the conversation signals the call, which interrupts a tool parked on an answer.
        execute: async (args, api, callContext) => {
          const result = await Effect.runPromise(
            Effect.result(tool.execute(args, { id: String(api.taskId) })),
            { signal: callContext.abortSignal },
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

/**
 * The AI Gateway that vendor models go through. It holds the Anthropic key (BYOK) under the
 * `default` alias. Requests carry no provider key, so the gateway uses that stored key; only if
 * it were missing would the gateway fall back to Unified Billing. Binding requests consult only
 * the `default` alias, so the key must stay under it.
 */
export const AI_GATEWAY_ID = "default";

/** pi-ai's Cloudflare provider over the AI binding, sending vendor models to `AI_GATEWAY_ID`. */
export const cloudflareAI = (binding: Ai) => createAI({ binding, id: AI_GATEWAY_ID });

/**
 * An Anthropic model from pi-ai's catalog, claimed by the Cloudflare provider. The provider sends
 * any model that isn't Workers AI to AI Gateway (`AI_GATEWAY_ID`), which picks the vendor from its
 * `baseUrl` and authenticates with the gateway's stored key, so no Anthropic key lives in code.
 */
const anthropicModel = (id: string): Model<Api> | undefined => {
  const found = Object.values(ANTHROPIC_MODELS).find((model) => model.id === id);
  return found === undefined ? undefined : { ...found, provider: CLOUDFLARE_PROVIDER_ID };
};

/** The provider, also listing `model`, so pi resolves its conversations' model reference. */
const listing = (provider: Provider, model: Model<Api>): Provider =>
  Object.assign(Object.create(provider) as Provider, {
    getModels: () => [...provider.getModels(), model],
    getAllModels: () => [...(provider.getAllModels?.() ?? provider.getModels()), model],
  });

/**
 * The model `PiAgentOptions.model` names, with the provider pi resolves it through. Also used by
 * the evals' judge, which completes with it directly.
 */
export const piModel = (ai: ReturnType<typeof cloudflareAI>, id: string) => {
  if (!id.startsWith("anthropic/")) return { model: ai(id), provider: ai.provider };
  const model = anthropicModel(id.slice("anthropic/".length));
  if (model === undefined) throw new Error(`pi-ai knows no Anthropic model ${id}`);
  return { model, provider: listing(ai.provider, model) };
};

export const openPiAgent = Effect.fn("PiAgent.open")(function* (options: PiAgentOptions) {
  const ai = cloudflareAI(options.ai);
  const { model, provider } = yield* Effect.try({
    try: () => piModel(ai, options.model),
    catch: (cause) => new PiError({ message: `Open pi: ${String(cause)}` }),
  });
  const agent = {
    model: { provider: model.provider, modelId: model.id } satisfies ModelRef,
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
  };

  const { harness, rootId } = yield* attempt("Open pi", async () => {
    const models = createModels();
    models.setProvider(provider);
    const storage = await options.storage();
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
    // Before resuming, so an answer interrupted mid-run keeps its tools. pi stores the model
    // and thinking level with the conversation, so a changed one is applied here too.
    await root.configure({ ...agent, extensions: [tools] }, context);
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
      // pi puts the model's own error in `detail`; without it, every failure reads the same.
      const detail = typeof settled.detail === "string" ? ` (${settled.detail})` : "";
      return yield* new PiError({ message: `Agent did not answer: ${settled.reason}${detail}` });
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

  const instruct = Effect.fn("PiAgent.instruct")(function* (instructions: string) {
    const root = yield* conversation(undefined);
    return yield* attempt("Set pi instructions", () => root.configure({ instructions }, context));
  });

  const abort = attempt("Abort pi", async () => {
    const root = await harness.root(context, { agent });
    await root.abort(context);
  }).pipe(Effect.withSpan("PiAgent.abort"));

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

  const transcript = Effect.fn("PiAgent.transcript")(function* (id?: number) {
    const target = yield* conversation(id);
    return yield* attempt("Read pi transcript", () => readTrace(target, context));
  });

  return PiAgent.of({ createConversation, prompt, instruct, abort, liveAnswer, transcript });
});
