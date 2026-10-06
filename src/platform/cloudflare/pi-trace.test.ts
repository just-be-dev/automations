/** Checks trace conversion against real pi conversation records produced by a scripted model. */
import { expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { readTrace } from "./pi-trace.ts";

// chord's `BACKGROUND_CONTEXT`, written structurally as `pi.ts` does.
const context: Parameters<Harness["close"]>[0] = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "[Context test]",
});

test("a trace reads instructions, the prompt, reasoning, tool calls and results in order", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const tools = defineExtension({
    name: "test",
    tools: [
      defineTool({
        name: "check_workflow",
        description: "Checks the draft",
        parameters: { type: "object", properties: { strict: { type: "boolean" } } },
        execute: async () => {
          throw new Error("Step welcome needs a title");
        },
      }),
    ],
  });
  const registry = createRegistry();
  registry.install(tools);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const model = faux.getModel();
    const root = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    await root.configure({ extensions: [tools], instructions: "You design automations." }, context);
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking("Check it first."),
          fauxToolCall("check_workflow", { strict: true }, { id: "c1" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("The welcome step needs a title.")]),
    ]);
    const submission = await root.submit({ type: "input", content: "Welcome new hires" }, context);
    await submission.wait(context);

    const trace = await readTrace(root, context);
    expect(trace.truncated).toBe(false);
    expect(trace.events.map((event) => event._tag)).toEqual([
      "Prompt",
      "Instructions",
      "Answer",
      "ToolResult",
      "Answer",
    ]);
    const [prompt, instructions, call, result, answer] = trace.events;
    expect(prompt).toMatchObject({ text: "Welcome new hires" });
    expect(instructions).toMatchObject({ toolsAdded: ["check_workflow"], toolsRemoved: [] });
    expect(instructions?._tag === "Instructions" && instructions.text).toContain(
      "You design automations.",
    );
    expect(call).toMatchObject({
      model: model.id,
      thinking: "Check it first.",
      text: "",
      toolCalls: [{ id: "c1", name: "check_workflow", arguments: '{\n  "strict": true\n}' }],
      stopReason: "toolUse",
    });
    expect(result).toMatchObject({ toolCallId: "c1", toolName: "check_workflow", isError: true });
    expect(result?._tag === "ToolResult" && result.text).toContain("Step welcome needs a title");
    expect(answer).toMatchObject({ text: "The welcome step needs a title.", stopReason: "stop" });
    expect(new Set(trace.events.map((event) => event.id)).size).toBe(trace.events.length);
  } finally {
    await harness.close(context);
  }
});
