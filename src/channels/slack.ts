/** Turns Slack thread activity, received through effect-channels, into named events that start automations. */
import { QueueDeliveryMode } from "@humanlayer/channels-delivery";
import {
  SlackApi,
  SlackBot,
  type SlackContent,
  type SlackMessage,
  type SlackNewMention,
  type SlackParticipant,
  type SlackSubscribedThreadEvents,
  type SlackThreadEvent,
} from "@humanlayer/channels-slack";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { Event } from "../events/model.ts";
import { Events } from "../events/service.ts";

/**
 * Slack reaches the studio through effect-channels: its webhook is verified, saved in a mailbox
 * per Slack thread, and handed to these callbacks in order, with retries. The callbacks only
 * publish events; automations with an event trigger decide what to do. They write nothing to
 * Slack, so a retried batch publishes the same events under the same IDs and each automation's
 * event receipts start at most one run per event.
 *
 * - `slack.mention`: someone mentioned the bot, or sent it a direct message. The thread is
 *   followed from then on.
 * - `slack.message`: a new message in a followed thread.
 * - `slack.reaction`: a reaction added to a message in a followed thread.
 *
 * Workflows can't emit these names (`PublishEvent`), so a run can't pass for Slack.
 */
export const SLACK_EVENT_PREFIX = "slack.";

const rawText = (content: SlackContent) =>
  content._tag === "SlackMarkdownContent" ? content.markdown : content.text;

/** Slack writes a user mention as `<@U123>` or `<@U123|name>`. */
const userMention = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
/** At most this many distinct people are looked up per message; the rest stay as Slack wrote them. */
const MAX_LOOKUPS = 10;

/** Channels, broadcasts, links, and HTML escapes, as a person would read them. */
const plainSlack = (text: string) =>
  text
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "$1")
    .replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>|]+)>/g, "$1")
    .replace(/<mailto:[^>|]+\|([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * The message as a person reads it: the bot's own mention removed (it's how they addressed it),
 * other people as `@Name`, channels as `#name`. Looking someone up asks Slack; if that fails, the
 * mention stays as Slack wrote it rather than holding up the event.
 */
export const readableText = Effect.fn("Slack.readableText")(function* (message: SlackMessage) {
  const raw = rawText(message.content);
  const ids = [...new Set([...raw.matchAll(userMention)].map((match) => match[1] ?? ""))].slice(
    0,
    MAX_LOOKUPS,
  );
  const api = yield* SlackApi;
  const names = new Map<string, string | null>();
  for (const id of ids) {
    const participant = yield* api
      .resolveParticipant({ teamId: message.ref.teamId, userId: id })
      .pipe(Effect.option);
    if (participant._tag === "Some") {
      names.set(id, participant.value.isMe ? null : `@${participant.value.fullName}`);
    }
  }
  const replaced = raw.replace(userMention, (token, id: string) => {
    const name = names.get(id);
    return name === undefined ? token : (name ?? "");
  });
  return plainSlack(replaced)
    .replace(/^[\s,:]+/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
});

const person = (participant: SlackParticipant): Schema.Json => ({
  id: participant.userId,
  name: participant.fullName,
  handle: participant.userName,
});

/** A message as event data: `text` as a person reads it, `raw` as Slack sent it (mrkdwn). */
export const messageData = Effect.fn("Slack.messageData")(function* (message: SlackMessage) {
  const data: Record<string, Schema.Json> = {
    text: yield* readableText(message),
    raw: rawText(message.content),
    user: person(message.author),
    team: message.ref.teamId,
    channel: message.ref.channelId,
    thread: message.thread.threadTs,
    ts: message.ref.messageTs,
    direct: message.thread.isDm,
  };
  return data;
});

/** IDs come from Slack's own identifiers, so a redelivered or retried batch repeats them. */
const messageKey = (message: SlackMessage) =>
  `${message.ref.teamId}:${message.ref.channelId}:${message.ref.messageTs}`;

export const mentionEvent = Effect.fn("Slack.mentionEvent")(function* (message: SlackMessage) {
  const event: Event = {
    id: `slack:mention:${messageKey(message)}`,
    name: "slack.mention",
    data: yield* messageData(message),
    depth: 0,
  };
  return event;
});

/** The event for one thread event, or none for activity automations can't listen for yet. */
export const threadEvent = Effect.fn("Slack.threadEvent")(function* (event: SlackThreadEvent) {
  switch (event._tag) {
    case "SlackMessageReceived": {
      const published: Event = {
        id: `slack:message:${messageKey(event.message)}`,
        name: "slack.message",
        data: yield* messageData(event.message),
        depth: 0,
      };
      return published;
    }
    case "SlackReactionAdded": {
      const published: Event = {
        id: `slack:reaction:${event.eventId}`,
        name: "slack.reaction",
        data: {
          reaction: event.reaction,
          user: person(event.actor),
          message: yield* messageData(event.message),
        },
        depth: 0,
      };
      return published;
    }
    default:
      return undefined;
  }
});

/** Builds each event just before publishing it, in order, so the thread's order is kept. */
const publishAll = Effect.fn("Slack.publish")(function* (
  events: ReadonlyArray<Effect.Effect<Event | undefined, never, SlackApi>>,
) {
  const publisher = yield* Events;
  for (const build of events) {
    const event = yield* build;
    if (event !== undefined) yield* publisher.publish(event);
  }
});

export const onNewMention = Effect.fn("Slack.onNewMention")(function* (event: SlackNewMention) {
  // Follow the thread before publishing: a retry repeats both, and following is idempotent.
  yield* event.thread.subscribe();
  yield* publishAll([mentionEvent(event.trigger), ...event.events.map(threadEvent)]);
});

export const onSubscribedThreadEvents = Effect.fn("Slack.onSubscribedThreadEvents")(function* (
  event: SlackSubscribedThreadEvents,
) {
  yield* publishAll(event.events.map(threadEvent));
});

/**
 * The Slack provider. It reads `SLACK_SIGNING_SECRET` to verify webhooks and, through
 * `SlackApiLive`, `SLACK_BOT_TOKEN` to resolve message authors.
 */
export const slackProvider = SlackBot.make({
  signingSecret: Config.Redacted("SLACK_SIGNING_SECRET"),
  // Triggers should fire promptly; every waiting event in a thread runs in one ordered batch.
  deliveryMode: QueueDeliveryMode.make({}),
  handlers: {
    onNewMention: (event) => onNewMention(event),
    onSubscribedThreadEvents: (event) => onSubscribedThreadEvents(event),
  },
});
