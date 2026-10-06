/** Presents agent conversations for debugging, including instructions, reasoning, tool activity, and token usage. */
import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Activity, CircleAlert, ExternalLink, LoaderCircle, RefreshCw } from "lucide";
import { button, buttonClass } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { componentName } from "@/lib/component";
import { formatTime, plural, runDotClass, runStatusLabel } from "@/lib/format";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Trace, TraceEvent, TraceToolCall } from "../../../ai/trace.ts";
import type { RunSummary } from "../../../workflow.ts";
import { automationHref, runHref, tracesHref } from "../../route.ts";
import { Message } from "./message.ts";
import {
  Automations,
  isSameSource,
  type ListedAutomation,
  type Model,
  Runs,
  type Source,
  TraceState,
} from "./model.ts";

const noteClass = "text-sm text-muted-foreground";
const cardClass = "rounded-[10px] bg-card shadow-card";
const labelClass = "text-[11px] font-semibold tracking-tight text-sand-10";
const metaClass = "font-mono text-[11px] text-sand-10";
const preClass =
  "max-h-96 overflow-auto rounded-[8px] bg-sidebar px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-foreground";
const linkClass =
  "my-px flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-muted-foreground transition-colors duration-100 outline-none hover:bg-hover hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [
      componentName("traces"),
      h.Class("grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[16rem_minmax(0,1fr)]"),
    ],
    [sourceListView(model, h), traceDetailView(model, h)],
  ),
);

const sourceListView = (model: Model, h: HtmlBuilder<Message>) =>
  h.nav(
    [
      componentName("source-list"),
      h.AriaLabel("Agent conversations"),
      h.Class(
        "flex flex-col border-b px-3 py-4 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0",
      ),
    ],
    [
      h.h2([h.Class(cn(labelClass, "mb-2 pl-1.5"))], ["Automations"]),
      Automations.match(model.automations, {
        Loading: () => h.p([h.Class(cn(noteClass, "px-1.5 text-xs"))], ["Loading…"]),
        Unavailable: ({ error }) =>
          h.p(
            [h.Class("px-1.5 text-xs text-destructive")],
            [`Couldn't load automations: ${error}`],
          ),
        Ready: ({ automations }) =>
          Array.match(automations, {
            onEmpty: () => h.p([h.Class(cn(noteClass, "px-1.5 text-xs"))], ["No automations yet."]),
            onNonEmpty: (listed) =>
              h.ul(
                [h.Class("flex flex-col")],
                Array.map(listed, (automation) => automationSourcesView(automation, model, h)),
              ),
          }),
      }),
    ],
  );

const isOpen = (model: Model, automationId: string, maybeRunId: Option.Option<string>) =>
  isSameSource(model.maybeSource, Option.some({ automationId, maybeRunId }));

const automationSourcesView = (
  automation: ListedAutomation,
  model: Model,
  h: HtmlBuilder<Message>,
) => {
  const isSelected = Option.exists(
    model.maybeSource,
    (source) => source.automationId === automation.id,
  );
  return h.keyed("li")(
    automation.id,
    [componentName("automation-sources")],
    [
      sourceLinkView(
        tracesHref(Option.some(automation.id), Option.none()),
        isOpen(model, automation.id, Option.none()),
        [h.span([h.Class("truncate text-[13px] font-medium tracking-tight")], [automation.name])],
        h,
      ),
      isSelected ? runSourcesView(automation.id, model, h) : h.empty,
    ],
  );
};

const sourceLinkView = (
  href: string,
  isCurrent: boolean,
  children: ReadonlyArray<Html | string>,
  h: HtmlBuilder<Message>,
) =>
  h.a(
    [
      componentName("source-link"),
      h.Href(href),
      ...(isCurrent ? [h.AriaCurrent("page")] : []),
      h.Class(cn(linkClass, isCurrent && "bg-hover text-foreground")),
    ],
    children,
  );

/** Under the selected automation: its planner, then each recent run's agent steps. */
const runSourcesView = (automationId: string, model: Model, h: HtmlBuilder<Message>) =>
  h.ul(
    [componentName("run-sources"), h.Class("mb-1 ml-3 flex flex-col border-l pl-1.5")],
    [
      h.li(
        [],
        [
          sourceLinkView(
            tracesHref(Option.some(automationId), Option.none()),
            isOpen(model, automationId, Option.none()),
            [h.span([h.Class("text-xs")], ["Planner"])],
            h,
          ),
        ],
      ),
      ...Runs.match(model.runs, {
        NotSelected: () => [],
        Loading: () => [h.li([h.Class(cn(noteClass, "px-2 py-1 text-xs"))], ["Loading runs…"])],
        Unavailable: ({ error }) => [
          h.li([h.Class("px-2 py-1 text-xs text-destructive")], [`Couldn't load runs: ${error}`]),
        ],
        Ready: ({ runs }) => Array.map(runs, (run) => runSourceView(automationId, run, model, h)),
      }),
    ],
  );

const runSourceView = (
  automationId: string,
  run: RunSummary,
  model: Model,
  h: HtmlBuilder<Message>,
) =>
  h.keyed("li")(
    run.id,
    [componentName("run-source")],
    [
      sourceLinkView(
        tracesHref(Option.some(automationId), Option.some(run.id)),
        isOpen(model, automationId, Option.some(run.id)),
        [
          h.span([
            h.Class(cn("size-1.5 shrink-0 rounded-full", runDotClass[run.status])),
            h.Title(runStatusLabel[run.status]),
          ]),
          h.span(
            [h.Class("flex min-w-0 flex-col")],
            [
              h.span([h.Class("truncate text-xs")], [run.subject ?? formatTime(run.startedAt)]),
              h.span([h.Class(cn(metaClass, "truncate"))], [run.id]),
            ],
          ),
        ],
        h,
      ),
    ],
  );

const traceDetailView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [
      componentName("trace-detail"),
      h.AriaLabel("Agent trace"),
      h.Class("flex flex-col gap-5 px-6 py-5 lg:min-h-0 lg:overflow-y-auto"),
    ],
    Option.match(model.maybeSource, {
      onNone: () => [noSourceView(h)],
      onSome: (source) => [
        traceHeaderView(source, model.trace, h),
        TraceState.match(model.trace, {
          NotSelected: () => h.empty,
          Loading: () => loadingView(h),
          Unavailable: ({ error }) =>
            h.p(
              [h.Class("flex items-center gap-2 text-sm text-destructive")],
              [icon(h, CircleAlert, "size-4"), `Couldn't load the trace: ${error}`],
            ),
          Ready: ({ trace }) => traceView(source, trace, h),
          Refreshing: ({ trace }) => traceView(source, trace, h),
        }),
      ],
    }),
  );

const noSourceView = (h: HtmlBuilder<Message>) =>
  Empty(
    { className: cn("max-w-xl", cardClass), attributes: [componentName("no-source")] },
    [
      Empty.header(
        {},
        [
          Empty.media({ className: "icon-tile" }, [icon(h, Activity, "size-3.5")], h),
          Empty.title({}, ["Agent traces"], h),
          Empty.description(
            {},
            [
              "Choose an automation to see its planner's conversation: the instructions it was given, its reasoning, and every tool call it made to edit the draft. Its runs list the prompts and answers of their agent and decide steps.",
            ],
            h,
          ),
        ],
        h,
      ),
    ],
    h,
  );

const loadingView = (h: HtmlBuilder<Message>) =>
  h.p(
    [componentName("loading"), h.Class(cn(noteClass, "flex items-center gap-2"))],
    [icon(h, LoaderCircle, "size-4 animate-spin"), "Loading trace…"],
  );

const sourceTitle = (source: Source) =>
  Option.match(source.maybeRunId, {
    onNone: () => "Planner conversation",
    onSome: (runId) => `Agent steps of run ${runId}`,
  });

const traceHeaderView = (source: Source, trace: TraceState, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("trace-header"), h.Class("flex flex-wrap items-center justify-between gap-3")],
    [
      h.div(
        [h.Class("flex min-w-0 flex-col gap-0.5")],
        [
          h.h1([h.Class("truncate text-base font-semibold tracking-tight")], [sourceTitle(source)]),
          h.span([h.Class(metaClass)], [source.automationId]),
        ],
      ),
      h.div(
        [h.Class("flex items-center gap-2")],
        [
          h.a(
            [
              h.Href(
                Option.match(source.maybeRunId, {
                  onNone: () => automationHref(source.automationId),
                  onSome: (runId) => runHref(source.automationId, runId),
                }),
              ),
              h.DataAttribute("slot", "button"),
              h.Class(buttonClass({ variant: "outline", size: "sm" })),
            ],
            [
              icon(h, ExternalLink, "size-3.5", "inline-start"),
              Option.isNone(source.maybeRunId) ? "Open studio" : "Open run",
            ],
          ),
          button(
            {
              onClick: Message.ClickedRefresh(),
              variant: "outline",
              size: "sm",
              isDisabled: TraceState.guards.Refreshing(trace) || TraceState.guards.Loading(trace),
            },
            [
              icon(
                h,
                RefreshCw,
                cn("size-3.5", TraceState.guards.Refreshing(trace) && "animate-spin"),
                "inline-start",
              ),
              "Refresh",
            ],
            h,
          ),
        ],
      ),
    ],
  );

type Answer = Extract<TraceEvent, { readonly _tag: "Answer" }>;

const answersOf = (trace: Trace): ReadonlyArray<Answer> =>
  Array.filter(trace.events, (event): event is Answer => event._tag === "Answer");

const tokens = (count: number) => count.toLocaleString("en-US");

const costText = (cost: number) => (cost === 0 ? "" : ` · $${cost.toFixed(4)}`);

const traceView = (source: Source, trace: Trace, h: HtmlBuilder<Message>) =>
  Array.match(trace.events, {
    onEmpty: () =>
      h.p(
        [componentName("empty-trace"), h.Class(noteClass)],
        [
          Option.isNone(source.maybeRunId)
            ? "The planner hasn't been asked anything yet."
            : "This run has no agent or decide steps that ran, so no agent was asked anything.",
        ],
      ),
    onNonEmpty: (events) =>
      h.div(
        [componentName("trace"), h.Class("flex flex-col gap-4")],
        [
          traceSummaryView(trace, h),
          ...(trace.truncated
            ? [
                h.p(
                  [h.Class("text-xs text-sand-11")],
                  ["This conversation is long, so only its latest entries are shown."],
                ),
              ]
            : []),
          h.ol(
            [h.Class("flex flex-col gap-3")],
            Array.map(events, (event) => eventView(event, h)),
          ),
        ],
      ),
  });

const traceSummaryView = (trace: Trace, h: HtmlBuilder<Message>) => {
  const answers = answersOf(trace);
  const sum = (read: (answer: Answer) => number) =>
    Array.reduce(answers, 0, (total, answer) => total + read(answer));
  const models = Array.dedupe(Array.map(answers, (answer) => answer.model));
  const toolCalls = sum((answer) => answer.toolCalls.length);
  return h.p(
    [componentName("trace-summary"), h.Class(metaClass)],
    [
      [
        plural(answers.length, "model response", "model responses"),
        plural(toolCalls, "tool call", "tool calls"),
        `${tokens(sum((answer) => answer.usage.input))} in`,
        `${tokens(sum((answer) => answer.usage.output))} out`,
        `${tokens(sum((answer) => answer.usage.cacheRead))} cached`,
        ...models,
      ].join(" · ") + costText(sum((answer) => answer.usage.cost)),
    ],
  );
};

const eventCardView = (
  id: string,
  tone: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
) =>
  h.keyed("li")(
    id,
    [componentName("trace-event"), h.Class(cn(cardClass, "flex flex-col gap-2 px-4 py-3", tone))],
    children,
  );

const eventHeadingView = (
  label: string,
  meta: ReadonlyArray<string>,
  maybeAt: Option.Option<number>,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [h.Class("flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1")],
    [
      h.span([h.Class("text-xs font-semibold tracking-tight")], [label]),
      h.span(
        [h.Class(metaClass)],
        [
          [...meta, ...Option.match(maybeAt, { onNone: () => [], onSome: (at) => [timeText(at)] })]
            .filter((part) => part !== "")
            .join(" · "),
        ],
      ),
    ],
  );

const timeText = (at: number) =>
  new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

const textView = (text: string, h: HtmlBuilder<Message>) => h.pre([h.Class(preClass)], [text]);

const disclosureView = (summary: string, text: string, h: HtmlBuilder<Message>) =>
  h.details(
    [componentName("trace-disclosure"), h.Class("group")],
    [
      h.summary(
        [h.Class("cursor-pointer text-xs text-sand-11 select-none hover:text-foreground")],
        [summary],
      ),
      h.pre([h.Class(cn(preClass, "mt-2"))], [text]),
    ],
  );

const eventView = (event: TraceEvent, h: HtmlBuilder<Message>): Html =>
  Match.value(event).pipe(
    Match.tagsExhaustive({
      Instructions: ({ id, at, text, toolsAdded, toolsRemoved }) =>
        eventCardView(
          id,
          "bg-sidebar shadow-none",
          [
            eventHeadingView(
              "System prompt",
              [
                Array.isReadonlyArrayNonEmpty(toolsAdded) ? `+ ${toolsAdded.join(", ")}` : "",
                Array.isReadonlyArrayNonEmpty(toolsRemoved) ? `− ${toolsRemoved.join(", ")}` : "",
              ],
              Option.some(at),
              h,
            ),
            text === ""
              ? h.empty
              : disclosureView(
                  `Instructions · ${plural(text.length, "character", "characters")}`,
                  text,
                  h,
                ),
          ],
          h,
        ),
      Prompt: ({ id, at, text }) =>
        eventCardView(
          id,
          "",
          [eventHeadingView("Prompt", [], Option.some(at), h), textView(text, h)],
          h,
        ),
      Answer: (answer) => answerView(answer, h),
      ToolResult: ({ id, at, toolName, toolCallId, text, isError }) =>
        eventCardView(
          id,
          isError ? "ring-1 ring-destructive/40" : "",
          [
            eventHeadingView(
              isError ? `${toolName} failed` : `${toolName} result`,
              [toolCallId],
              Option.some(at),
              h,
            ),
            textView(text, h),
          ],
          h,
        ),
      Reset: ({ id, text }) => markerView(id, "Context reset", text, h),
      Compaction: ({ id, text }) => markerView(id, "Earlier entries summarized", text, h),
    }),
  );

const markerView = (id: string, label: string, text: string, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    id,
    [componentName("trace-marker"), h.Class("flex flex-col gap-2 py-1")],
    [
      h.div(
        [h.Class("flex items-center gap-3")],
        [
          h.span([h.Class("h-px flex-1 bg-border")]),
          h.span([h.Class(labelClass)], [label]),
          h.span([h.Class("h-px flex-1 bg-border")]),
        ],
      ),
      text === "" ? h.empty : disclosureView("Carried forward", text, h),
    ],
  );

const answerView = (answer: Answer, h: HtmlBuilder<Message>) =>
  eventCardView(
    answer.id,
    answer.error === undefined ? "" : "ring-1 ring-destructive/40",
    [
      eventHeadingView(
        "Model response",
        [
          answer.model,
          answer.stopReason,
          `${tokens(answer.usage.input)} in · ${tokens(answer.usage.output)} out${costText(answer.usage.cost)}`,
        ],
        Option.some(answer.at),
        h,
      ),
      answer.thinking === ""
        ? h.empty
        : disclosureView(
            `Reasoning · ${plural(answer.thinking.length, "character", "characters")}`,
            answer.thinking,
            h,
          ),
      answer.text === "" ? h.empty : textView(answer.text, h),
      ...Array.map(answer.toolCalls, (call) => toolCallView(call, h)),
      answer.error === undefined
        ? h.empty
        : h.p([h.Class("text-xs text-destructive")], [answer.error]),
    ],
    h,
  );

const toolCallView = (call: TraceToolCall, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("tool-call"), h.Class("flex flex-col gap-1.5 rounded-[8px] border px-3 py-2")],
    [
      h.div(
        [h.Class("flex items-baseline justify-between gap-3")],
        [
          h.span([h.Class("font-mono text-[12px] font-medium")], [`${call.name}()`]),
          h.span([h.Class(metaClass)], [call.id]),
        ],
      ),
      h.pre([h.Class(preClass)], [call.arguments]),
    ],
  );
