import { expect, test } from "bun:test";
import { MailboxSubscriptions } from "@humanlayer/channels-delivery";
import {
  SlackApi,
  SlackApiError,
  SlackChannelId,
  SlackEventId,
  SlackMessage,
  SlackMessageTs,
  SlackNewMention,
  SlackReaction,
  SlackReactionAdded,
  SlackReactionRemoved,
  SlackMessageReceived,
  SlackSubscribedThreadEvents,
  SlackTeamId,
  SlackThread,
  SlackUserId,
} from "@humanlayer/channels-slack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { PublishEvent, type Event } from "../events/model.ts";
import { Events } from "../events/service.ts";
import { onNewMention, onSubscribedThreadEvents, readableText } from "./slack.ts";

const thread = {
  teamId: SlackTeamId.make("T1"),
  channelId: SlackChannelId.make("C1"),
  threadTs: SlackMessageTs.make("100.000"),
  isDm: false,
};
const ada = {
  userId: SlackUserId.make("U1"),
  userName: "ada",
  fullName: "Ada Lovelace",
  isBot: false,
  isMe: false,
};
const message = (ts: string, text: string) =>
  SlackMessage.make({
    ref: { teamId: thread.teamId, channelId: thread.channelId, messageTs: SlackMessageTs.make(ts) },
    thread,
    author: ada,
    content: { _tag: "SlackMarkdownContent", markdown: text },
    files: [],
    metadata: {},
  });
const slackThread = SlackThread.make({ ref: thread, mailboxKey: "slack-thread" });

/** Slack's directory: UBOT is the bot itself, U2 is a person, UGONE can't be looked up. */
const people: Record<string, { fullName: string; isMe: boolean }> = {
  UBOT: { fullName: "Automations", isMe: true },
  U2: { fullName: "Grace Hopper", isMe: false },
};
const lookups: Array<string> = [];
const resolveParticipant: (typeof SlackApi.Service)["resolveParticipant"] = ({ userId }) => {
  lookups.push(userId ?? "");
  const found = people[userId ?? ""];
  return found === undefined
    ? Effect.fail(
        SlackApiError.make({ operation: "resolve_participant", message: "user_not_found" }),
      )
    : Effect.succeed({ ...ada, userId: SlackUserId.make(userId ?? ""), ...found });
};
/** Only lookups are expected; any other Slack call fails the test. */
const slackApi = Layer.succeed(
  SlackApi,
  new Proxy(
    {},
    {
      get: (_, name) =>
        name === "resolveParticipant"
          ? resolveParticipant
          : () => Effect.die(`unexpected SlackApi.${String(name)}`),
    },
  ) as typeof SlackApi.Service,
);

const harness = () => {
  const published: Array<Event> = [];
  const subscribed: Array<string> = [];
  const layer = Layer.mergeAll(
    slackApi,
    Layer.succeed(Events, {
      publish: (event) => Effect.sync(() => void published.push(event)),
    }),
    Layer.succeed(MailboxSubscriptions, {
      subscribe: ({ mailboxKey }) =>
        Effect.sync(() => {
          subscribed.push(mailboxKey);
          return { _tag: "Created" as const };
        }),
      isSubscribed: () => Effect.succeed(true),
      unsubscribe: () => Effect.void,
    }),
  );
  return { published, subscribed, layer };
};

test("a mention follows its thread and publishes the mention, then the events after it, in order", async () => {
  const { published, subscribed, layer } = harness();
  const mention = SlackNewMention.make({
    thread: slackThread,
    trigger: message("100.000", "<@UBOT> onboard Sam"),
    events: [
      SlackMessageReceived.make({
        eventId: SlackEventId.make("Ev2"),
        message: message("101.000", "starting Monday"),
      }),
      // Activity automations can't listen for yet is left out.
      SlackReactionRemoved.make({
        eventId: SlackEventId.make("Ev3"),
        message: message("100.000", "<@UBOT> onboard Sam"),
        actor: ada,
        reaction: SlackReaction.make("eyes"),
      }),
    ],
  });
  await Effect.runPromise(onNewMention(mention).pipe(Effect.provide(layer)));
  expect(subscribed).toEqual(["slack-thread"]);
  expect(published).toEqual([
    {
      id: "slack:mention:T1:C1:100.000",
      name: "slack.mention",
      data: {
        text: "onboard Sam",
        raw: "<@UBOT> onboard Sam",
        user: { id: "U1", name: "Ada Lovelace", handle: "ada" },
        team: "T1",
        channel: "C1",
        thread: "100.000",
        ts: "100.000",
        direct: false,
      },
      depth: 0,
    },
    expect.objectContaining({ id: "slack:message:T1:C1:101.000", name: "slack.message" }),
  ]);
});

test("followed-thread activity publishes messages and added reactions under Slack-derived IDs", async () => {
  const { published, subscribed, layer } = harness();
  const events = SlackSubscribedThreadEvents.make({
    thread: slackThread,
    events: [
      SlackReactionAdded.make({
        eventId: SlackEventId.make("Ev9"),
        message: message("101.000", "starting Monday"),
        actor: ada,
        reaction: SlackReaction.make("white_check_mark"),
      }),
    ],
  });
  // A redelivered batch publishes the same IDs, so automations' receipts start no second run.
  await Effect.runPromise(onSubscribedThreadEvents(events).pipe(Effect.provide(layer)));
  await Effect.runPromise(onSubscribedThreadEvents(events).pipe(Effect.provide(layer)));
  expect(subscribed).toEqual([]);
  expect(published.map((event) => event.id)).toEqual(["slack:reaction:Ev9", "slack:reaction:Ev9"]);
  expect(published[0]?.data).toMatchObject({
    reaction: "white_check_mark",
    user: { id: "U1" },
    message: { text: "starting Monday", ts: "101.000" },
  });
});

test("workflows and clients can't publish Slack events", () => {
  const decode = Schema.decodeUnknownExit(PublishEvent);
  expect(decode({ id: "x", name: "slack.mention", data: null, depth: 0 })._tag).toBe("Failure");
  expect(decode({ id: "x", name: "slacker.joined", data: null, depth: 0 })._tag).toBe("Success");
});

test("text reads as a person would: the bot's mention gone, people and channels named", async () => {
  lookups.length = 0;
  const read = (markdown: string) =>
    Effect.runPromise(readableText(message("1.0", markdown)).pipe(Effect.provide(slackApi)));
  expect(await read("<@UBOT>: ask <@U2> about <#C9|launch> &amp; <https://x.dev|the doc>")).toBe(
    "ask @Grace Hopper about #launch & the doc (https://x.dev)",
  );
  // Each person is looked up once per message.
  expect(lookups).toEqual(["UBOT", "U2"]);
  // A failed lookup keeps the mention as Slack wrote it instead of holding up the event.
  expect(await read("<!here> ping <@UGONE> and <@UBOT>")).toBe("@here ping <@UGONE> and");
});
