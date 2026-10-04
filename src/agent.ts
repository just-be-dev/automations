import { Agent } from "agents";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { graph, parseDraft, type Workflow } from "./workflow.ts";

interface Env {
  AI: Ai;
}
interface Run {
  id: string;
  workflow: Workflow;
  input: unknown;
  index: number;
  results: { step: string; output: string }[];
  status: "running" | "completed" | "failed";
  error?: string;
  session?: string;
}

const designInstructions = `You design executable automations. Always respond with ONLY JSON: {"reply":"brief helpful explanation or question","workflow":{"name":"...","event":null or event identifier,"steps":[{"id":"stable-unique-id","title":"...","kind":"agent","instruction":"..."} or {"id":"...","title":"...","kind":"webhook","url":"https://..."}]}}. Include the COMPLETE revised workflow on every turn. Only agent and HTTPS webhook steps are executable. Steps run sequentially. Event is an identifier for an externally POSTed event, not a scheduled timer. Never invent webhook URLs; ask for missing URLs and use an agent step until provided. No secrets in the workflow.`;

export class AutomationAgent extends Agent<Env> {
  ai = createAI({ binding: this.env.AI });
  registry = createRegistry();
  harness = new PiHarness({
    harness: ({ storage, context }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(storage, { models, registry: this.registry }, context);
    },
    defaults: { model: this.ai("@cf/moonshotai/kimi-k2.7-code") },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
  }

  async inspectWorkflow() {
    const draft = await this.ctx.storage.get<Workflow>("draft");
    const saved = await this.ctx.storage.get<Workflow>("saved");
    return { draft, saved, graph: draft ? graph(draft) : null };
  }

  async chat(message: string) {
    if (!message.trim() || message.length > 4000)
      throw new Error("Message must be 1–4000 characters");
    const response = await this.harness.prompt(`${designInstructions}\n\nUser: ${message}`);
    if (response.status !== "done" || !response.text)
      throw new Error("Agent did not complete the draft");
    const draft = parseDraft(response.text);
    await this.ctx.storage.put("draft", draft.workflow);
    return { ...draft, graph: graph(draft.workflow) };
  }

  async save() {
    const draft = await this.ctx.storage.get<Workflow>("draft");
    if (!draft) throw new Error("No draft to save");
    await this.ctx.storage.put("saved", draft);
    return { saved: draft, graph: graph(draft) };
  }

  async start(input: unknown, event?: string) {
    const saved = await this.ctx.storage.get<Workflow>("saved");
    if (!saved) throw new Error("Save the workflow before starting it");
    if (event !== undefined && saved.event !== event)
      throw new Error("Event does not match the saved trigger");
    const run: Run = {
      id: crypto.randomUUID(),
      workflow: saved,
      input,
      index: 0,
      results: [],
      status: "running",
    };
    await this.ctx.storage.put(`run:${run.id}`, run);
    await this.schedule(0, "execute", run.id);
    return { id: run.id, status: run.status };
  }

  async run(id: string) {
    return this.ctx.storage.get<Run>(`run:${id}`);
  }

  async execute(id: string) {
    const key = `run:${id}`;
    const run = await this.ctx.storage.get<Run>(key);
    if (!run || run.status !== "running") return;
    try {
      const step = run.workflow.steps[run.index];
      if (!step) {
        run.status = "completed";
        await this.ctx.storage.put(key, run);
        return;
      }
      let output: string;
      if (step.kind === "agent") {
        if (!run.session) {
          run.session = (await this.harness.sessions.create()).id;
          await this.ctx.storage.put(key, run);
        }
        const response = await this.harness.prompt(
          `Execute this workflow step: ${step.instruction}\nInput: ${JSON.stringify(run.input)}\nPrior results: ${JSON.stringify(run.results)}`,
          { session: run.session, operationId: `${run.id}:${step.id}` },
        );
        if (response.status !== "done") throw new Error("Agent step did not complete");
        output = response.text ?? "";
      } else {
        const response = await fetch(step.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: run.input, results: run.results }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
        output = (await response.text()).slice(0, 4000);
      }
      run.results.push({ step: step.id, output });
      run.index++;
      run.session = undefined;
      if (run.index === run.workflow.steps.length) run.status = "completed";
      await this.ctx.storage.put(key, run);
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      await this.ctx.storage.put(key, run);
    }
    if (run.status === "running") await this.schedule(0, "execute", id);
  }
}
