import * as Option from "effect/Option";
import type { Trace } from "../../../ai/trace.ts";
import type { RunSummary } from "../../../workflow.ts";
import { Message, init, update, type Model } from "./index.ts";

export const plannerTrace: Trace = {
  truncated: false,
  events: [
    {
      _tag: "Instructions",
      id: "1",
      at: 0,
      text: "You design automations.",
      toolsAdded: ["set_workflow", "put_steps"],
      toolsRemoved: [],
    },
    { _tag: "Prompt", id: "2", at: 1000, text: "Welcome new hires" },
    {
      _tag: "Answer",
      id: "3",
      at: 2000,
      model: "kimi",
      thinking: "A hire needs an email.",
      text: "",
      toolCalls: [{ id: "call-1", name: "put_steps", arguments: '{\n  "steps": []\n}' }],
      stopReason: "toolUse",
      usage: { input: 1200, output: 80, cacheRead: 1000, cacheWrite: 0, cost: 0 },
    },
    {
      _tag: "ToolResult",
      id: "4",
      at: 3000,
      toolCallId: "call-1",
      toolName: "put_steps",
      text: "Step welcome needs a title",
      isError: true,
    },
    {
      _tag: "Answer",
      id: "5",
      at: 4000,
      model: "kimi",
      thinking: "",
      text: "I drafted the welcome email.",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 1300, output: 20, cacheRead: 1200, cacheWrite: 0, cost: 0 },
    },
  ],
};

export const run: RunSummary = {
  id: "run-1",
  status: "completed",
  startedAt: 0,
  subject: "Ada Lovelace",
  openTasks: 0,
};

const applied = (start: Model, messages: ReadonlyArray<Message>) =>
  messages.reduce((current, next) => update(current, next).model, start);

export const plannerOpen = applied(
  init(Option.some({ automationId: "welcome", maybeRunId: Option.none() })).model,
  [
    Message.SucceededLoadAutomations({ automations: [{ id: "welcome", name: "Welcome hires" }] }),
    Message.SucceededLoadRuns({ automationId: "welcome", runs: [run] }),
    Message.SucceededLoadTrace({ load: 0, trace: plannerTrace }),
  ],
);
