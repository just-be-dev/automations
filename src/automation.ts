import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { openPiAgent } from "./pi.ts";
import {
  decodeDraft,
  graph,
  Run,
  Workflow,
  type AgentStep,
  type Step,
  type WebhookStep,
} from "./workflow.ts";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";

const designInstructions = `You design executable automations. Always respond with ONLY JSON: {"reply":"brief helpful explanation or question","workflow":{"name":"...","event":null or event identifier,"steps":[{"id":"stable-unique-id","title":"...","kind":"agent","instruction":"..."} or {"id":"...","title":"...","kind":"webhook","url":"https://..."}]}}. Include the COMPLETE revised workflow on every turn. Only agent and HTTPS webhook steps are executable. Steps run sequentially. Event is an identifier for an externally POSTed event, not a scheduled timer. Never invent webhook URLs; ask for missing URLs and use an agent step until provided. No secrets in the workflow.`;

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

const runKey = (id: string) => `run:${id}`;

const failureMessage = (error: { readonly message: string }) => error.message;

/** One automation: its draft and saved workflow, its runs, and the pi agent that designs and runs it. */
export default class Automation extends Cloudflare.DurableObject<Automation>()(
  "AutomationAgent",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const ai = yield* Cloudflare.Workers.AI();

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

      const inspectWorkflow = Effect.fn("Automation.inspectWorkflow")(function* () {
        const draft = yield* readWorkflow("draft");
        const saved = yield* readWorkflow("saved");
        return { draft, saved, graph: draft === undefined ? null : graph(draft) };
      });

      const chat = Effect.fn("Automation.chat")(function* (message: string) {
        if (!message.trim() || message.length > 4000) {
          return yield* new AutomationError({ message: "Message must be 1–4000 characters" });
        }
        const text = yield* pi.prompt({ text: `${designInstructions}\n\nUser: ${message}` });
        const draft = yield* decodeDraft(text);
        yield* state.storage.put("draft", draft.workflow);
        return { ...draft, graph: graph(draft.workflow) };
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
  }).pipe(Effect.provide(Cloudflare.Workers.AIBinding)),
) {}
