# Slack integration

Connecting a Slack workspace does two things:

- **Sending.** `slack.sendMessage` posts for real instead of being simulated. It posts to a channel (`#team`), or sends a DM to a person given by email address or by an entity with an `email` field. This needs only the bot token.
- **Receiving.** Mentions of the bot, messages in threads it follows, and reactions in those threads become [`slack.*` events](workflow-dsl.md#event) that can start automations. This needs the bot token, the signing secret, and a public webhook that Slack can reach.

How it works inside is in [Architecture](../ARCHITECTURE.md) and the [development guide](development.md#slack). This page covers setup.

Use a sandbox or test workspace while you try it out. Every saved automation that posts to Slack posts for real once the token is set.

## 1. Create the Slack app

1. Open [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, and pick the workspace.
2. Paste [`slack-app-manifest.json`](slack-app-manifest.json) as it is. It leaves out event subscriptions on purpose: Slack refuses bot events without a request URL, and it can only verify that URL once the webhook is running. You'll add them in [step 4](#4-turn-on-incoming-events).
3. Create the app, then choose **Install to Workspace** and allow it.

The manifest asks for these bot scopes. The [channels-slack README](https://github.com/humanlayer/effect-channels/tree/main/packages/slack#readme) explains each one.

| Scope                                                                               | Used for                                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `chat:write`, `chat:write.public`                                                   | Posting, including to public channels the bot hasn't joined     |
| `users:read`, `users:read.email`                                                    | Finding a person to DM by email address, and naming authors     |
| `app_mentions:read`, `channels:*`, `groups:*`, `im:*`, `mpim:*` (`history`, `read`) | Receiving mentions and messages in channels, private chats, DMs |
| `reactions:read`                                                                    | Receiving reactions                                             |

If you add a scope later, Slack asks you to reinstall the app. Reinstalling keeps the same bot token.

## 2. Add the credentials

Copy two values from the app's settings into `.env` at the root of the checkout. `.env` is gitignored, so check with `git check-ignore .env` and never commit it.

```dotenv
SLACK_SIGNING_SECRET=...   # Basic Information → App Credentials → Signing Secret
SLACK_BOT_TOKEN=xoxb-...   # OAuth & Permissions → Bot User OAuth Token
```

| Set               | Result                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| Neither           | Slack is simulated: steps record `simulated: true` and contact no one. |
| `SLACK_BOT_TOKEN` | Sending is live. No webhook is deployed, so nothing comes in.          |
| Both              | Sending is live, and the stack also runs the public `Channels` Worker. |

The stack reads these values when it starts (`mise run dev`) or deploys. Restart or redeploy after changing them.

Workflows never contain the token. Don't paste it into a chat with the planner, and don't use the legacy **Verification Token** on Basic Information: the signing secret replaces it.

## 3. Invite the bot

In Slack, invite the bot to each channel it should read from, or post to if the channel is private:

```text
/invite @Automations
```

It can post in public channels without joining, but Slack only sends it messages and mentions from channels it belongs to.

## 4. Turn on incoming events

Slack must reach the webhook at `https://<Channels Worker>/integrations/slack/webhook`.

### Deployed

The deploy prints it as `slackWebhookUrl`. It stays the same between deploys.

### Local

`mise run dev` runs the `Channels` Worker on a local port; look for `Channels` in its output (often `http://localhost:1337`, but ports can shift if one is taken). Expose it with a quick tunnel:

```sh
cloudflared tunnel --url http://localhost:<Channels port>
```

The webhook is `https://<tunnel>.trycloudflare.com/integrations/slack/webhook`. A quick tunnel gets a new address every time it starts, so repeat the next steps each time.

### In the Slack app

1. Open **Event Subscriptions** and turn on **Enable Events**.
2. Paste the webhook into **Request URL**. Slack sends a challenge at once, so dev or the deploy must be running. Wait for **Verified**.
3. Under **Subscribe to bot events**, add the six events from the manifest:
   - `app_mention`
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
   - `reaction_added`
4. Choose **Save Changes**, and reinstall the app if Slack shows a banner asking you to.

## 5. Check it works

Set `STUDIO_URL` to the Studio URL that `mise run dev` prints. Then check which connections are live:

```sh
curl -s "$STUDIO_URL/api/connections"
# {"live":["slack"]}
```

If `slack` isn't listed, the server didn't see `SLACK_BOT_TOKEN`. The studio also tags Slack steps "Simulated" when it isn't live.

**Sending.** In the studio, create an automation with the sidebar's **+**:

> When I start it, post "Hello from automations" to #automations-test. Run it without approval.

Choose **Save draft**, then **Run saved version**. The message should appear in the channel. The run's step record should show a channel ID (`C…`) and a `ts`, with no "Simulated" tag.

**Receiving.** Create another one:

> When someone mentions the bot in Slack, reply in #automations-test with "Got it: " followed by what they wrote. Run it without approval.

The planner should give it an event trigger on `slack.mention` and a message such as `Got it: {{event.data.text}}`. Save it, then post `@Automations hello` in the channel. Within a few seconds, `GET $STUDIO_URL/api/overview` should show a completed run with an ID like `event-slack:mention:…`, and the bot should reply.

## What automations receive

| Event            | When                                                                           |
| ---------------- | ------------------------------------------------------------------------------ |
| `slack.mention`  | Someone mentions the bot or DMs it. From then on, the bot follows that thread. |
| `slack.message`  | A new message arrives in a thread the bot follows.                             |
| `slack.reaction` | Someone reacts to a message in a thread the bot follows.                       |

The data fields are in the [Workflow DSL](workflow-dsl.md#event). Keep in mind:

- `text` is what the person wrote, without the bot's own mention, with people as `@Name` and channels as `#name`; echoing `{{event.data.text}}` back reads naturally. `raw` keeps Slack's mrkdwn (`<@U…>` mentions) for anything that needs the IDs.
- The bot ignores its own posts, so a reply doesn't start another run.
- Slack sends `app_mention` and `message.channels` for the same message, and Slack retries webhooks. Event IDs come from Slack's own identifiers, so each automation starts at most one run per message.

## Troubleshooting

Channels logs are in `.alchemy/log/dev_$USER/Channels/`. Api logs, where runs post their messages, are in `.alchemy/log/dev_$USER/Api/`.

| Symptom                                          | Likely cause                                                                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack rejects the manifest                       | An `event_subscriptions` block was added to it. Remove it and add the events in step 4.                                                                                                        |
| Request URL won't verify                         | Dev or the tunnel isn't running, the URL is missing `/integrations/slack/webhook`, or the tunnel address changed.                                                                              |
| `/api/connections` returns `{"live":[]}`         | `SLACK_BOT_TOKEN` isn't in `.env`, or the server hasn't restarted since you added it.                                                                                                          |
| A step fails with "Slack rejected the bot token" | The token is wrong or was revoked. Copy it again from OAuth & Permissions.                                                                                                                     |
| "the bot isn't in that channel"                  | The channel is private. Invite the bot.                                                                                                                                                        |
| "the Slack app is missing a scope"               | The app was created without the full manifest. Add the scope and reinstall.                                                                                                                    |
| A mention starts nothing                         | The bot isn't in the channel, the bot events aren't subscribed, no saved automation listens for `slack.mention`, or the Channels log shows a signature failure (wrong `SLACK_SIGNING_SECRET`). |
| `Webhook authentication failed` in the log       | A request without a valid Slack signature was refused, as intended. If it came from Slack, check the signing secret.                                                                           |

Slack takes no idempotency key, so a send step that is retried after a post that wasn't recorded posts again.
