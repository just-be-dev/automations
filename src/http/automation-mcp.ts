/**
 * MCP tools over automations: listing them, reading one's draft, conversation and runs, and
 * designing drafts by handing messages to its planner (`Automations.chat`). Nothing here saves,
 * starts, or answers a run's tasks; the person does that in the studio.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import { stringify } from "yaml";
import { Namer } from "../agents/namer/namer.ts";
import { Question } from "../ai/ask-question/question.ts";
import { createAutomation } from "../automation/creation.ts";
import { AutomationIndex } from "../automation/index.ts";
import { AutomationOverview } from "../automation/model.ts";
import { listOverview } from "../automation/overview.ts";
import { type AutomationClient, Automations } from "../automation/service.ts";
import { messageOf } from "../error.ts";
import { sameJson } from "../workflow/changes.ts";
import type { Workflow } from "../workflow/model.ts";
import { RunId, RunSummary } from "../workflow/run.ts";
import { McpCaller, NoPerson } from "./mcp-caller.ts";

export class AutomationToolError extends Schema.TaggedError<AutomationToolError>()(
  "AutomationToolError",
  { message: Schema.String },
) {}

const Failure = Schema.Union([AutomationToolError, NoPerson]);

/**
 * How long a design tool waits for the planner's reply before it answers "working", and how often
 * it looks. A reply usually takes well under a minute; the caller reads the rest with
 * get_automation.
 */
export const PlannerWait = Context.Reference<{
  readonly totalMillis: number;
  readonly pollMillis: number;
}>("automations/PlannerWait", { defaultValue: () => ({ totalMillis: 25_000, pollMillis: 1_000 }) });

const AutomationIdParam = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/)).annotate({
  description:
    "The automation's ID, from list_automations, or the `automation` parameter of a studio URL.",
});

/** Where the planner is with the automation's design conversation. */
const Planner = Schema.Struct({
  status: Schema.Literals(["idle", "working", "asking", "failed"]).annotate({
    description:
      "idle: it replied; working: still answering; asking: waiting for the person's answers to `questions`; failed: it couldn't answer, see `error`.",
  }),
  message: Schema.optionalKey(
    Schema.String.annotate({ description: "The message it is answering." }),
  ),
  progress: Schema.optionalKey(Schema.String),
  questions: Schema.optionalKey(Schema.Array(Question)),
  error: Schema.optionalKey(Schema.String),
  reply: Schema.optionalKey(Schema.String.annotate({ description: "Its latest reply, Markdown." })),
});
type Planner = typeof Planner.Type;

const Exchange = Schema.Struct({ message: Schema.String, reply: Schema.String });

const AutomationView = Schema.Struct({
  automationId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  /** The studio page, relative to the studio's origin. */
  studioPath: Schema.String,
  draft: Schema.optionalKey(
    Schema.String.annotate({ description: "The draft workflow, as YAML." }),
  ),
  saved: Schema.optionalKey(
    Schema.String.annotate({
      description: "The saved workflow that runs, as YAML, when it differs from the draft.",
    }),
  ),
  status: Schema.Literals(["new", "unsaved", "saved", "saved with unsaved changes"]),
  planner: Planner,
  conversation: Schema.Array(Exchange).annotate({
    description: "The latest exchanges, oldest first.",
  }),
  runs: Schema.Array(RunSummary).annotate({ description: "The latest runs, newest first." }),
});

const DesignOutcome = Schema.Struct({
  automationId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  studioPath: Schema.String,
  planner: Planner,
  draft: Schema.optionalKey(
    Schema.String.annotate({ description: "The draft workflow, as YAML." }),
  ),
});

const RunView = Schema.Struct({
  automationId: Schema.String,
  id: Schema.String,
  status: Schema.String,
  workflow: Schema.String.annotate({ description: "The name of the workflow version it runs." }),
  subject: Schema.NullOr(Schema.Json),
  subjectTitle: Schema.NullOr(Schema.String),
  startedAt: Schema.Finite,
  error: Schema.optionalKey(Schema.String),
  stopReason: Schema.optionalKey(Schema.String),
  steps: Schema.Json.annotate({ description: "Each step's status and record, by step ID." }),
  tasks: Schema.Json.annotate({
    description: "Its human tasks and approvals: what each asks, whether open, and the decision.",
  }),
  resumesAt: Schema.Json,
  studioPath: Schema.String,
});

const ListAutomations = Tool.make("list_automations", {
  description:
    "Lists every automation: its ID and name, its saved trigger and when a schedule next runs, its runs still in flight, and its latest run.",
  success: Schema.Struct({ automations: Schema.Array(AutomationOverview) }),
  failure: Failure,
})
  .annotate(Tool.Title, "List automations")
  .annotate(Tool.Readonly, true);

const GetAutomation = Tool.make("get_automation", {
  description:
    "Reads one automation: its draft and saved workflows as YAML, whether the draft has unsaved changes, where its planner is (including questions waiting for the person), its latest conversation, and its latest runs.",
  parameters: Schema.Struct({ automationId: AutomationIdParam }),
  success: AutomationView,
  failure: Failure,
})
  .annotate(Tool.Title, "Get automation")
  .annotate(Tool.Readonly, true);

const GetRun = Tool.make("get_run", {
  description:
    "Reads one run of an automation: its status, each step's status and record, and its human tasks and approvals.",
  parameters: Schema.Struct({ automationId: AutomationIdParam, runId: RunId }),
  success: RunView,
  failure: Failure,
})
  .annotate(Tool.Title, "Get run")
  .annotate(Tool.Readonly, true);

const designNote =
  "The planner, a workflow design specialist, writes the draft; it never saves or runs it, and neither does this tool. The person reviews and saves the draft on the automation's studio page. Waits up to about 25 seconds for the planner's reply; if it is still working, read it later with get_automation. When it asks questions, put them to the person and send their answer with draft_automation.";

const CreateAutomation = Tool.make("create_automation", {
  description: `Creates a new automation from a description of what it should do, in the person's words, and has the planner draft it. ${designNote}`,
  parameters: Schema.Struct({
    description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
  }),
  success: DesignOutcome,
  failure: Failure,
})
  .annotate(Tool.Title, "Create automation")
  .annotate(Tool.Destructive, false);

const DraftAutomation = Tool.make("draft_automation", {
  description: `Sends a message to an existing automation's planner: a change to make to its draft, or the person's answer to the planner's questions. ${designNote}`,
  parameters: Schema.Struct({
    automationId: AutomationIdParam,
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
    requestId: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
        description:
          "Optional. A unique ID for this message, such as a UUID. Repeating the call with the same requestId doesn't send it twice.",
      }),
    ),
  }),
  success: DesignOutcome,
  failure: Failure,
})
  .annotate(Tool.Title, "Change automation draft")
  .annotate(Tool.Destructive, false);

const StopDraft = Tool.make("stop_draft", {
  description:
    "Stops the planner's reply in progress for an automation, while it is working or waiting on questions, so its draft stays as it was before that message. Does nothing when the planner isn't answering anything; a reply it already finished stays. Returns where the planner is.",
  parameters: Schema.Struct({ automationId: AutomationIdParam }),
  success: DesignOutcome,
  failure: Failure,
})
  .annotate(Tool.Title, "Stop the planner")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AutomationTools = Toolkit.make(
  ListAutomations,
  GetAutomation,
  GetRun,
  CreateAutomation,
  DraftAutomation,
  StopDraft,
);

type Inspection = Effect.Success<ReturnType<AutomationClient["inspectWorkflow"]>>;

const yaml = (workflow: Workflow) =>
  stringify(workflow, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();

const studioPath = (automationId: string, runId?: string) => {
  const params = new URLSearchParams({ automation: automationId });
  if (runId !== undefined) params.set("run", runId);
  return `/?${params.toString()}`;
};

const plannerOf = (state: Inspection): Planner => {
  const pending = state.pendingChat;
  const reply = state.conversation.at(-1)?.reply;
  if (pending === undefined) return { status: "idle", ...(reply === undefined ? {} : { reply }) };
  switch (pending.status) {
    case "working":
      return {
        status: "working",
        message: pending.prompt,
        ...(state.progress === undefined ? {} : { progress: state.progress }),
      };
    case "asking":
      return { status: "asking", message: pending.prompt, questions: pending.questions };
    case "failed":
      return { status: "failed", message: pending.prompt, error: pending.error };
  }
};

const isEmpty = (state: Inspection) =>
  state.draft === undefined &&
  state.saved === undefined &&
  state.conversation.length === 0 &&
  state.pendingChat === undefined;

const failure = (error: unknown) =>
  error instanceof NoPerson || error instanceof AutomationToolError
    ? error
    : new AutomationToolError({ message: messageOf(error) });

/** The tools' handlers, over the request's automations, directory, namer and caller. */
export const automationToolHandlers = Effect.gen(function* () {
  const automations = yield* Automations;
  const index = yield* AutomationIndex;
  const namer = yield* Namer;
  const caller = yield* McpCaller;

  const nameOf = (automationId: string) =>
    index.list.pipe(
      Effect.map((listed) => listed.find((item) => item.id === automationId)?.name),
      Effect.orElseSucceed(() => undefined),
    );

  /** The automation's state once its planner stops working, or when the wait runs out. */
  const settled = Effect.fn("AutomationMcp.settled")(function* (client: AutomationClient) {
    const wait = yield* PlannerWait;
    const deadline = (yield* Clock.currentTimeMillis) + wait.totalMillis;
    let state = yield* client.inspectWorkflow();
    while (state.pendingChat?.status === "working" && (yield* Clock.currentTimeMillis) < deadline) {
      yield* Effect.sleep(wait.pollMillis);
      state = yield* client.inspectWorkflow();
    }
    return state;
  });

  const outcome = (automationId: string, name: string | undefined, state: Inspection) => ({
    automationId,
    ...(name === undefined ? {} : { name }),
    studioPath: studioPath(automationId),
    planner: plannerOf(state),
    ...(state.draft === undefined ? {} : { draft: yaml(state.draft) }),
  });

  /** Reads an automation that exists, from its object or the directory. */
  const existing = Effect.fn("AutomationMcp.existing")(function* (automationId: string) {
    const client = automations.get(automationId);
    const state = yield* client.inspectWorkflow();
    const name = state.draft?.name ?? state.saved?.name ?? (yield* nameOf(automationId));
    if (isEmpty(state) && name === undefined)
      return yield* new AutomationToolError({
        message: `No automation with ID ${automationId}. Create one with create_automation.`,
      });
    return { client, state, name };
  });

  return AutomationTools.of({
    list_automations: () =>
      listOverview().pipe(
        Effect.map((listed) => ({ automations: listed })),
        Effect.provideService(AutomationIndex, index),
        Effect.provideService(Automations, automations),
        Effect.mapError(failure),
      ),
    get_automation: ({ automationId }) =>
      Effect.gen(function* () {
        const { state, name } = yield* existing(automationId);
        const same =
          state.draft !== undefined &&
          state.saved !== undefined &&
          sameJson(state.draft, state.saved);
        return {
          automationId,
          ...(name === undefined ? {} : { name }),
          studioPath: studioPath(automationId),
          ...(state.draft === undefined ? {} : { draft: yaml(state.draft) }),
          ...(state.saved === undefined || same ? {} : { saved: yaml(state.saved) }),
          status:
            state.saved === undefined
              ? state.draft === undefined
                ? ("new" as const)
                : ("unsaved" as const)
              : same || state.draft === undefined
                ? ("saved" as const)
                : ("saved with unsaved changes" as const),
          planner: plannerOf(state),
          conversation: state.conversation
            .slice(-3)
            .map((exchange) => ({ message: exchange.prompt, reply: exchange.reply })),
          runs: state.runs.slice(0, 10),
        };
      }).pipe(Effect.mapError(failure)),
    get_run: ({ automationId, runId }) =>
      Effect.gen(function* () {
        const run = yield* automations.get(automationId).run(runId);
        if (run === undefined)
          return yield* new AutomationToolError({
            message: `${automationId} has no run ${runId}`,
          });
        return {
          automationId,
          id: run.id,
          status: run.status,
          workflow: run.workflow.name,
          subject: run.subject,
          subjectTitle: run.subjectTitle,
          startedAt: run.startedAt,
          ...(run.error === undefined ? {} : { error: run.error }),
          ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
          steps: run.steps,
          // A task's token answers it; this server never does.
          tasks: run.tasks.map(({ token: _token, ...task }) => task),
          resumesAt: run.resumesAt,
          studioPath: studioPath(automationId, run.id),
        };
      }).pipe(Effect.mapError(failure)),
    create_automation: ({ description }) =>
      Effect.gen(function* () {
        yield* caller.person;
        const created = yield* createAutomation(description).pipe(
          Effect.provideService(Namer, namer),
          Effect.provideService(AutomationIndex, index),
          Effect.provideService(Automations, automations),
        );
        if (created.pendingChat === undefined)
          return yield* new AutomationToolError({
            message: `Created ${created.id}, but couldn't send its description to the planner. Send it again with draft_automation.`,
          });
        const state = yield* settled(automations.get(created.id));
        return outcome(created.id, created.name, state);
      }).pipe(Effect.mapError(failure)),
    // `stopChat` stops only the chat it names, and only while it's unanswered, so a reply that
    // finished meanwhile, or a later message, is never touched.
    stop_draft: ({ automationId }) =>
      Effect.gen(function* () {
        yield* caller.person;
        const { client, state, name } = yield* existing(automationId);
        const pending = state.pendingChat;
        if (pending !== undefined && pending.status !== "failed")
          yield* client.stopChat(pending.id);
        return outcome(automationId, name, yield* client.inspectWorkflow());
      }).pipe(Effect.mapError(failure)),
    draft_automation: ({ automationId, message, requestId }) =>
      Effect.gen(function* () {
        yield* caller.person;
        const { client, state, name } = yield* existing(automationId);
        // A planner waiting on questions takes the message as their answer.
        if (state.pendingChat?.status === "asking")
          yield* client.answer(automationId, state.pendingChat.id, {
            kind: "message",
            text: message,
          });
        else
          yield* client.chat(
            automationId,
            message,
            requestId === undefined ? undefined : `mcp:${requestId}`,
          );
        return outcome(automationId, name, yield* settled(client));
      }).pipe(Effect.mapError(failure)),
  });
});
