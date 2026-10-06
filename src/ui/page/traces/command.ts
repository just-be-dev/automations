import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Http } from "foldkit";
import { Trace } from "../../../ai/trace.ts";
import { RunSummary } from "../../../workflow.ts";
import { errorText, requestJson } from "../../api.ts";
import { Message } from "./message.ts";
import { ListedAutomation } from "./model.ts";

export const LoadAutomations = Command.define("LoadAutomations", {
  messages: [Message.SucceededLoadAutomations, Message.FailedLoadAutomations],
  execute: requestJson("/api/automations", Schema.Array(ListedAutomation)).pipe(
    Effect.map((automations) => Message.SucceededLoadAutomations({ automations })),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedLoadAutomations({ error: errorText(error) })),
    ),
    Effect.provide(Http.layer),
  ),
});

const AutomationRuns = Schema.Struct({ runs: Schema.Array(RunSummary) });

export const LoadRuns = Command.define("LoadRuns", {
  args: { automationId: Schema.String },
  messages: [Message.SucceededLoadRuns, Message.FailedLoadRuns],
  execute: ({ automationId }) =>
    requestJson(`/api/automations/${encodeURIComponent(automationId)}`, AutomationRuns).pipe(
      Effect.map(({ runs }) => Message.SucceededLoadRuns({ automationId, runs })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedLoadRuns({ automationId, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});

const traceUrl = (automationId: string, maybeRunId: Option.Option<string>) => {
  const automation = `/api/automations/${encodeURIComponent(automationId)}`;
  return Option.match(maybeRunId, {
    onNone: () => `${automation}/trace`,
    onSome: (runId) => `${automation}/runs/${encodeURIComponent(runId)}/trace`,
  });
};

export const LoadTrace = Command.define("LoadTrace", {
  args: {
    load: Schema.Int,
    automationId: Schema.String,
    maybeRunId: Schema.Option(Schema.String),
  },
  messages: [Message.SucceededLoadTrace, Message.FailedLoadTrace],
  execute: ({ load, automationId, maybeRunId }) =>
    requestJson(traceUrl(automationId, maybeRunId), Trace).pipe(
      Effect.map((trace) => Message.SucceededLoadTrace({ load, trace })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedLoadTrace({ load, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});
