import {
  CompactionEntry,
  ResetEntry,
  type Conversation,
  type Cursor,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import type { Trace, TraceEvent } from "../../ai/trace.ts";

/** Reads pi's records of a conversation back as a `Trace`. */

type Context = Parameters<Conversation["entries"]>[3];

/** Joins an assistant message's `text` or `thinking` parts. */
export const assistantContent = (message: unknown, type: "text" | "thinking") => {
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

/** The most entries a trace reads, newest first, so a long conversation stays one response. */
const MAX_TRACE_ENTRIES = 1000;
const TRACE_PAGE = 200;

/** Newest first, up to `MAX_TRACE_ENTRIES`, and whether older entries were left out. */
const readEntries = async (
  target: Conversation,
  context: Context,
  cursor: Cursor | undefined,
  read: ReadonlyArray<EntryRecord>,
): Promise<{ readonly entries: ReadonlyArray<EntryRecord>; readonly truncated: boolean }> => {
  const page = await target.entries({}, TRACE_PAGE, cursor, context);
  const entries = [...read, ...page.items];
  if (entries.length >= MAX_TRACE_ENTRIES) {
    return {
      entries: entries.slice(0, MAX_TRACE_ENTRIES),
      truncated: page.next !== undefined || entries.length > MAX_TRACE_ENTRIES,
    };
  }
  return page.next === undefined
    ? { entries, truncated: false }
    : readEntries(target, context, page.next, entries);
};

type ModelMessage = NonNullable<EntryRecord["model"]>[number];

const textOf = (
  content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>,
) =>
  typeof content === "string"
    ? content
    : content.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join("");

const sectionsText = (sections: Readonly<Record<string, string | null>> | undefined) =>
  Object.entries(sections ?? {}).map(([name, value]) =>
    value === null ? `[section ${name} removed]` : value,
  );

const messageEvent = (id: string, message: ModelMessage): TraceEvent => {
  switch (message.role) {
    case "system":
      return {
        _tag: "Instructions",
        id,
        at: message.timestamp,
        text: [textOf(message.content), ...sectionsText(message.sections)]
          .filter((part) => part !== "")
          .join("\n\n"),
        toolsAdded: (message.toolsAdded ?? []).map((tool) => tool.name),
        toolsRemoved: (message.toolsRemoved ?? []).map((tool) => tool.name),
      };
    case "user":
      return { _tag: "Prompt", id, at: message.timestamp, text: textOf(message.content) };
    case "assistant":
      return {
        _tag: "Answer",
        id,
        at: message.timestamp,
        model: message.responseModel ?? message.model,
        thinking: assistantContent(message, "thinking"),
        text: assistantContent(message, "text"),
        toolCalls: message.content.flatMap((part) =>
          part.type === "toolCall"
            ? [{ id: part.id, name: part.name, arguments: JSON.stringify(part.arguments, null, 2) }]
            : [],
        ),
        stopReason: message.stopReason,
        ...(message.errorMessage === undefined ? {} : { error: message.errorMessage }),
        usage: {
          input: message.usage.input,
          output: message.usage.output,
          cacheRead: message.usage.cacheRead,
          cacheWrite: message.usage.cacheWrite,
          cost: message.usage.cost.total,
        },
      };
    case "toolResult":
      return {
        _tag: "ToolResult",
        id,
        at: message.timestamp,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        text: textOf(message.content),
        isError: message.isError,
      };
  }
};

/** Resets and summaries read as markers; every other entry by the messages it gave the model. */
const traceEvents = (entry: EntryRecord): ReadonlyArray<TraceEvent> => {
  const id = String(entry.id);
  const messages = entry.model ?? [];
  const carried = messages.map((message) =>
    message.role === "user" ? textOf(message.content) : "",
  );
  if (entry.kind === ResetEntry.kind) {
    return [{ _tag: "Reset", id, text: carried.join("\n\n") }];
  }
  if (entry.kind === CompactionEntry.kind) {
    return [{ _tag: "Compaction", id, text: carried.join("\n\n") }];
  }
  return messages.map((message, index) =>
    messageEvent(index === 0 ? id : `${id}.${index}`, message),
  );
};

/** The conversation's latest entries as trace events, oldest first. */
export const readTrace = async (target: Conversation, context: Context): Promise<Trace> => {
  const { entries, truncated } = await readEntries(target, context, undefined, []);
  return { events: entries.toReversed().flatMap(traceEvents), truncated };
};
