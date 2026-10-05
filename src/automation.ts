import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { openAutomationIndex } from "./automation-index.ts";
import { designDraft } from "./design.ts";
import { openPiAgent } from "./pi.ts";
import {
  Exchange,
  flattenSteps,
  graph,
  PendingChat,
  Run,
  Workflow,
  type AgentStep,
  type Step,
  type WebhookStep,
} from "./workflow.ts";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String,
}) {}

// Storage holds only values this object wrote, so a decoding failure is a defect.
const StoredWorkflow = Schema.UndefinedOr(Workflow);
const decodeStoredWorkflow = (value: unknown) =>
  Schema.decodeUnknownEffect(StoredWorkflow)(value).pipe(Effect.orDie);
const StoredRun = Schema.UndefinedOr(Run);
const decodeStoredRun = (value: unknown) =>
  Schema.decodeUnknownEffect(StoredRun)(value).pipe(Effect.orDie);

const StoredExchangeCount = Schema.UndefinedOr(Schema.Int);
const decodeStoredExchangeCount = (value: unknown) =>
  Schema.decodeUnknownEffect(StoredExchangeCount)(value).pipe(Effect.orDie);
const StoredPendingChat = Schema.UndefinedOr(PendingChat);
const decodeStoredPendingChat = (value: unknown) =>
  Schema.decodeUnknownEffect(StoredPendingChat)(value).pipe(Effect.orDie);
const decodeStoredExchanges = (values: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(Exchange))(values).pipe(Effect.orDie);

const runKey = (id: string) => `run:${id}`;
// Each exchange gets its own key because a single storage value is capped at 128 KiB. The padding
// keeps `list` returning them in order.
const exchangePrefix = "exchange:";
const exchangeKey = (index: number) => `${exchangePrefix}${String(index).padStart(6, "0")}`;

const failureMessage = (error: { readonly message: string }) => error.message;

/** Payload of the `designReply` callback: a persisted contract, so keep it compatible. */
interface DesignReply {
  readonly automationId: string;
  readonly chatId: string;
}

// NOTE: until `RunAutomation` (src/interpreter.ts) replaces this runner, runs only execute flat
// agent and webhook steps.
const isFlatStep = (step: Step): step is AgentStep | WebhookStep =>
  step.kind === "agent" || step.kind === "webhook";

const unsupportedStepKinds = (workflow: Workflow) => [
  ...new Set(flattenSteps(workflow.steps).flatMap((step) => (isFlatStep(step) ? [] : [step.kind]))),
];

/** One automation: its draft and saved workflow, its runs, and the pi agent that designs and runs it. */
export default class Automation extends Cloudflare.DurableObject<Automation>()(
  "AutomationAgent",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const ai = yield* Cloudflare.Workers.AI();
    const index = yield* openAutomationIndex;

    // The outer Effect constructs the class; the returned inner Effect constructs each instance.
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const pi = yield* openPiAgent({
        storage: state.raw.storage,
        ai: yield* ai.raw,
        model: MODEL,
      }).pipe(Effect.orDie);

      const readWorkflow = (key: "draft" | "saved") =>
        state.storage.get(key).pipe(Effect.flatMap(decodeStoredWorkflow));
      const readRun = (id: string) =>
        state.storage.get(runKey(id)).pipe(Effect.flatMap(decodeStoredRun));
      const writeRun = (run: Run) => state.storage.put(runKey(run.id), run);

      const runAgentStep = Effect.fn("Automation.runAgentStep")(function* (
        run: Run,
        step: AgentStep,
      ) {
        const conversation = run.conversation ?? (yield* pi.createConversation);
        if (run.conversation === undefined) {
          yield* writeRun({ ...run, conversation });
        }
        return yield* pi.prompt({
          conversation,
          requestId: `${run.id}:${step.id}`,
          text: `Execute this workflow step: ${step.instruction}\nInput: ${JSON.stringify(run.input)}\nPrior results: ${JSON.stringify(run.results)}`,
        });
      });

      const runWebhookStep = Effect.fn("Automation.runWebhookStep")(
        function* (run: Run, step: WebhookStep) {
          const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
          const response = yield* client.execute(
            HttpClientRequest.post(step.url).pipe(
              HttpClientRequest.bodyJsonUnsafe({ input: run.input, results: run.results }),
            ),
          );
          const text = yield* response.text;
          return text.slice(0, 4000);
        },
        Effect.timeout("30 seconds"),
        // Webhook receivers are third parties: don't forward trace headers to them.
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provide(FetchHttpClient.layer),
      );

      const runStep = Effect.fn("Automation.runStep")(function* (run: Run, step: Step) {
        if (!isFlatStep(step)) {
          return yield* new AutomationError({
            message: `Runs can't execute ${step.kind} steps yet`,
          });
        }
        return step.kind === "agent"
          ? yield* runAgentStep(run, step)
          : yield* runWebhookStep(run, step);
      });

      // Delivery is at least once: a step interrupted by eviction runs again. Agent steps resubmit
      // with the same pi request ID; webhook receivers must be idempotent.
      const advance: Alchemy.Callback<{ readonly runId: string }> = yield* Alchemy.makeCallback(
        "advance",
        Effect.fn("Automation.advance")(function* ({ runId }: { readonly runId: string }) {
          const run = yield* readRun(runId);
          if (run === undefined || run.status !== "running") {
            return;
          }
          const step = run.workflow.steps[run.index];
          if (step === undefined) {
            return yield* writeRun({ ...run, status: "completed" });
          }
          const output = yield* runStep(run, step).pipe(Effect.result);
          if (Result.isFailure(output)) {
            return yield* writeRun({
              ...run,
              status: "failed",
              error: failureMessage(output.failure),
            });
          }
          const { conversation: _finished, ...rest } = run;
          const index = run.index + 1;
          const next: Run = {
            ...rest,
            index,
            results: [...run.results, { step: step.id, output: output.success }],
            status: index === run.workflow.steps.length ? "completed" : "running",
          };
          yield* state.storage
            .transaction(
              Effect.gen(function* () {
                yield* writeRun(next);
                if (next.status === "running") {
                  yield* advance.schedule(runId, { after: 0, payload: { runId } });
                }
              }),
            )
            .pipe(Effect.orDie);
        }),
      );

      const readConversation = state.storage
        .list({ prefix: exchangePrefix })
        .pipe(Effect.flatMap((entries) => decodeStoredExchanges([...entries.values()])));

      const readPendingChat = state.storage
        .get("pendingChat")
        .pipe(Effect.flatMap(decodeStoredPendingChat));

      const inspectWorkflow = Effect.fn("Automation.inspectWorkflow")(function* () {
        const draft = yield* readWorkflow("draft");
        const saved = yield* readWorkflow("saved");
        const conversation = yield* readConversation;
        const pendingChat = yield* readPendingChat;
        return {
          draft,
          saved,
          graph: draft === undefined ? null : graph(draft),
          conversation,
          pendingChat,
        };
      });

      const isWorking = (pending: PendingChat | undefined, chatId: string) =>
        pending?.id === chatId && pending.status === "working";

      // Delivery is at least once. A redelivered reply reuses the pi request IDs, so the agent answers
      // each message (and its one retry) once, and only the delivery that still finds the message
      // pending writes it.
      const designReply: Alchemy.Callback<DesignReply> = yield* Alchemy.makeCallback(
        "designReply",
        Effect.fn("Automation.designReply")(function* ({ automationId, chatId }: DesignReply) {
          const pending = yield* readPendingChat;
          if (pending === undefined || !isWorking(pending, chatId)) {
            return;
          }
          const reply = yield* designDraft(pi.prompt, chatId, pending.prompt).pipe(Effect.result);
          const wrote = yield* state.storage
            .transaction(
              Effect.gen(function* () {
                if (!isWorking(yield* readPendingChat, chatId)) {
                  return false;
                }
                if (Result.isFailure(reply)) {
                  const failed: PendingChat = {
                    id: chatId,
                    prompt: pending.prompt,
                    status: "failed",
                    error: failureMessage(reply.failure),
                  };
                  yield* state.storage.put("pendingChat", failed);
                  return false;
                }
                const exchangeCount =
                  (yield* state.storage
                    .get("exchangeCount")
                    .pipe(Effect.flatMap(decodeStoredExchangeCount))) ?? 0;
                yield* state.storage.put("draft", reply.success.workflow);
                yield* state.storage.put(exchangeKey(exchangeCount), {
                  prompt: pending.prompt,
                  reply: reply.success.reply,
                });
                yield* state.storage.put("exchangeCount", exchangeCount + 1);
                yield* state.storage.delete("pendingChat");
                return true;
              }),
            )
            .pipe(Effect.orDie);
          if (wrote && Result.isSuccess(reply)) {
            // The index only feeds the studio's list, so a failure to update it must not fail the reply.
            yield* index.record(automationId, reply.success.workflow.name).pipe(Effect.ignore);
          }
        }),
      );

      const chat = Effect.fn("Automation.chat")(function* (automationId: string, message: string) {
        if (!message.trim() || message.length > 10_000) {
          return yield* new AutomationError({ message: "Message must be 1–10,000 characters" });
        }
        const pending: PendingChat = {
          id: crypto.randomUUID(),
          prompt: message,
          status: "working",
        };
        const accepted = yield* state.storage
          .transaction(
            Effect.gen(function* () {
              if ((yield* readPendingChat)?.status === "working") {
                return false;
              }
              yield* state.storage.put("pendingChat", pending);
              yield* designReply.schedule(pending.id, {
                after: 0,
                payload: { automationId, chatId: pending.id },
              });
              return true;
            }),
          )
          .pipe(Effect.orDie);
        if (!accepted) {
          return yield* new AutomationError({
            message: "The agent is still answering the previous message",
          });
        }
        return { pendingChat: pending };
      });

      const save = Effect.fn("Automation.save")(function* () {
        const draft = yield* readWorkflow("draft");
        if (draft === undefined) {
          return yield* new AutomationError({ message: "No draft to save" });
        }
        yield* state.storage.put("saved", draft);
        return { saved: draft, graph: graph(draft) };
      });

      const start = Effect.fn("Automation.start")(function* (input: unknown, event?: string) {
        const saved = yield* readWorkflow("saved");
        if (saved === undefined) {
          return yield* new AutomationError({ message: "Save the workflow before starting it" });
        }
        if (event !== undefined && saved.event !== event) {
          return yield* new AutomationError({ message: "Event does not match the saved trigger" });
        }
        const unsupported = unsupportedStepKinds(saved);
        if (unsupported.length > 0) {
          return yield* new AutomationError({
            message: `Runs can't execute ${unsupported.join(", ")} steps yet`,
          });
        }
        const run: Run = {
          id: crypto.randomUUID(),
          workflow: saved,
          input,
          index: 0,
          results: [],
          status: "running",
        };
        yield* state.storage
          .transaction(
            Effect.gen(function* () {
              yield* writeRun(run);
              yield* advance.schedule(run.id, { after: 0, payload: { runId: run.id } });
            }),
          )
          .pipe(Effect.orDie);
        return { id: run.id, status: run.status };
      });

      const run = Effect.fn("Automation.run")(function* (id: string) {
        return yield* readRun(id);
      });

      return { inspectWorkflow, chat, save, start, run };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.Workers.AIBinding, Cloudflare.D1.QueryDatabaseBinding),
    ),
  ),
) {}
