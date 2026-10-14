# Slack integration

Connecting a Slack workspace does four things:

- **Sending.** `slack.sendMessage` posts for real instead of being simulated. It posts to a channel (`#team`), or sends a DM to a person given by email address or by an entity with an `email` field. This needs only the bot token.
- **Task messages.** When a run waits on a person, they get a DM with what's needed and an **Open in Studio** link to the run. See [Task messages](#task-messages). This also needs only the bot token.
- **Approving.** An approval's DM also has **Approve** and **Reject** buttons. A click counts only from a member of the role. See [Approving from Slack](#approving-from-slack). This needs the bot token, the signing secret, and the interactivity URL that Slack can reach.
- **Receiving.** Mentions of the bot, messages in threads it follows, and reactions in those threads become [`slack.*` events](workflow-dsl.md#event) that can start automations. This needs the bot token, the signing secret, and a public webhook that Slack can reach.

How it works inside is in [Architecture](../ARCHITECTURE.md), and the event payloads are in the [Workflow DSL](workflow-dsl.md#event). This page covers setup.

Use a sandbox or test workspace while you try it out. Every saved automation that posts to Slack posts for real once the token is set.

## 1. Create the Slack app

1. Open [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, and pick the workspace.
2. Paste [`slack-app-manifest.json`](slack-app-manifest.json) as it is. It leaves out event subscriptions on purpose: Slack refuses bot events without a request URL, and it can only verify that URL once the webhook is running. Its interactivity request URL is a placeholder for the same reason. You'll set both in [step 4](#4-turn-on-incoming-events-and-buttons).
3. Create the app, then choose **Install to Workspace** and allow it.

The manifest asks for these bot scopes. The [channels-slack README](https://github.com/humanlayer/effect-channels/tree/main/packages/slack#readme) explains each one.

| Scope                                                                               | Used for                                                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `chat:write`, `chat:write.public`                                                   | Posting, including to public channels the bot hasn't joined, and marking an approval DM decided     |
| `users:read`, `users:read.email`                                                    | Finding a person to DM by email address, naming authors, and checking who clicked Approve or Reject |
| `app_mentions:read`, `channels:*`, `groups:*`, `im:*`, `mpim:*` (`history`, `read`) | Receiving mentions and messages in channels, private chats, DMs                                     |
| `reactions:read`                                                                    | Receiving reactions                                                                                 |

If you add a scope later, Slack asks you to reinstall the app. Reinstalling keeps the same bot token.

## 2. Add the credentials

Copy two values from the app's settings into `.env` at the root of the checkout. `.env` is gitignored, so check with `git check-ignore .env` and never commit it.

```dotenv
SLACK_SIGNING_SECRET=...   # Basic Information → App Credentials → Signing Secret
SLACK_BOT_TOKEN=xoxb-...   # OAuth & Permissions → Bot User OAuth Token
```

Optionally, set where task messages link to. Without it, each automation links to the studio address it was last saved from, which suits both `mise run dev` and a deploy:

```dotenv
STUDIO_URL=https://studio.example.com   # the Studio URL that `mise run dev` or the deploy prints
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

## 4. Turn on incoming events and buttons

Slack must reach two addresses on the `Channels` Worker:

- the events webhook, `https://<Channels Worker>/integrations/slack/webhook`
- the interactivity URL for button clicks, `https://<Channels Worker>/integrations/slack/interactivity`

### Deployed

The deploy prints them as `slackWebhookUrl` and `slackInteractivityUrl`. They stay the same between deploys.

### Local

`mise run dev` runs the `Channels` Worker on a local port; look for `Channels` in its output (often `http://localhost:1337`, but ports can shift if one is taken). Expose it with a quick tunnel:

```sh
cloudflared tunnel --url http://localhost:<Channels port>
```

The webhook is `https://<tunnel>.trycloudflare.com/integrations/slack/webhook`, and the interactivity URL is `https://<tunnel>.trycloudflare.com/integrations/slack/interactivity`. A quick tunnel gets a new address every time it starts, so repeat the next steps each time.

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
5. Open **Interactivity & Shortcuts**. **Interactivity** is already on. Replace the placeholder **Request URL** with the interactivity URL and choose **Save Changes**. Slack doesn't send a challenge for this one, so a wrong URL only shows when a button click fails.

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

## Task messages

A run that waits on a person sends them a DM from the bot:

- **Ask-first actions.** Each member of the role the action asks gets one. It says which automation needs the role to approve what, and for whom. It shows the exact content the action will send. For an email, that is the template it came from, the subject, and the start of the body.
- **Human steps with `notify: "slack"`.** The assignee gets one with the step's title, its prompt, and the fields they'll fill in. With `notify: "email"`, nothing is sent: email is simulated.

People are found by the `email` field of their entity, the same way `slack.sendMessage` finds them. Each DM ends with an **Open in Studio** button that opens the run (`/?automation=<id>&run=<runId>`), where the task can be answered. An approval's DM also has **Approve** and **Reject** beside it; see [Approving from Slack](#approving-from-slack).

The button links to `STUDIO_URL` when it's set. Otherwise it links to the address the automation was last saved from: the Studio Worker forwards the browser's request to the API unchanged, so saving records the studio's origin. An automation saved before task messages existed has no link until it's saved again, and its messages say to answer in the studio instead.

Delivery is recorded on the task, per person, under `notifications`, and the studio shows "Sent on Slack to …" on the task. The bot sends each person at most one DM per task, even when the run replays:

1. Before posting, the task records the person as `sending`. Afterwards it records `sent`, with the DM's channel and timestamp, or `failed`, with Slack's reason.
2. A person already `sent` or `failed` isn't messaged again. A failure doesn't fail the run; the task can still be answered in the studio.
3. A person left `sending` may have been messaged just before a restart. Slack takes no idempotency key, so the bot reads its recent DM with them (`im:read`, `im:history`) for the message's key, which it sends as message metadata. It posts only if the key isn't there. If Slack can't be read, it posts, so a rare duplicate is possible.

### Approving from Slack

An ask-first action's DM has **Approve** and **Reject** after **Open in Studio**. Human steps don't get them, even ones that ask for approval: they have no role to check a click against, so they're answered in the studio.

When someone clicks:

1. Slack posts the click to the interactivity URL. The `Channels` Worker checks Slack's signature, puts the click on the `SlackActions` queue, and answers at once with an empty 200, inside Slack's 3-second limit.
2. The private `Api` takes the click off the queue. It asks Slack for the clicker's email address (`users.info`, which needs `users:read.email`) and answers the task with it, as the studio answers with the Cloudflare Access email. Only the members the task recorded when it opened may answer.
3. A member's click decides the task. The bot then updates the message: the two buttons go, **Open in Studio** stays, and a last line says who decided and when, such as "✅ Approved by Grace Hopper · today at 10:05 AM". Slack shows the time in each reader's own time zone.
4. Anyone else sees a message only they can see, such as "Only members of People Ops can answer this". So does someone Slack has no email address for. The task stays open and the message doesn't change. This is rare, because only a DM's recipient can click its buttons, but nothing about the message itself is trusted.

Deciding is idempotent. The first answer closes the task and is recorded on it as `decision`, with whether it was approved, by whom, and when. A repeated click, a click on the other button, or a click after the task was answered in the studio decides nothing more: it redraws the message from that recorded decision. If Slack or the automation can't be reached, the queue retries the click up to three times, which is safe for the same reason.

The other members' DMs keep their buttons until someone clicks them. A decision made in the studio doesn't update any DM.

### Try it in a sandbox

The seeded data already fits: Grace Hopper is Ada Lovelace's manager and the only member of People Ops.

1. Point Grace at your own address in the Slack sandbox. Ask the studio's assistant ("Change Grace Hopper's email to you@your-sandbox.example") and confirm the change, or prepare it and approve it:

   ```sh
   curl -X POST "$STUDIO_URL/api/changes" -H "Content-Type: application/json" \
     -d '{"action":{"kind":"putEntity","type":"employee","id":"grace","data":{"email":"you@your-sandbox.example"}}}'
   curl -X POST "$STUDIO_URL/api/changes/<proposal-id>/decision" \
     -H "Content-Type: application/json" -d '{"approved":true}'
   ```

2. Create an automation with the sidebar's **+**:

   > When I start it for an employee, send them the engineering welcome email, asking People Ops first. Then ask their manager how it's going, and notify them on Slack.

3. Choose **Save draft** in the studio, then run it for Ada Lovelace. You get a DM asking People Ops to approve the email, with its template, subject and body. **Open in Studio** opens the run.
4. Choose **Approve** in the DM. Within a few seconds the buttons give way to a line saying you approved it, and when. Clicking again changes nothing. You then get a second DM, for the manager's check-in, with only **Open in Studio**.

You won't see a refusal in this walkthrough. Only a DM's recipient can click its buttons, and the bot only DMs the role's members. The check still matters, because it never trusts the message itself: it compares the clicker's Slack email with the members the task recorded.

The run's task shows who it was sent to. In the Api log, `Couldn't send a task on Slack` means the whole delivery failed, and `Task messages have no studio link` means the automation needs saving again or `STUDIO_URL`.

## What automations receive

A mention or DM starts `slack.mention`, and the bot then follows that thread: later messages arrive as `slack.message` and reactions as `slack.reaction`. Their data fields are in the [Workflow DSL](workflow-dsl.md#event). Keep in mind:

- Echoing `{{event.data.text}}` back reads naturally, because `text` drops the bot's own mention. `raw` keeps Slack's mrkdwn for anything that needs user IDs.
- The bot ignores its own posts, so a reply doesn't start another run.
- Slack sends `app_mention` and `message.channels` for the same message, and Slack retries webhooks. Event IDs come from Slack's own identifiers, so each automation starts at most one run per message.

## Troubleshooting

Channels logs are in `.alchemy/log/dev_$USER/Channels/`. Api logs, where runs post their messages, are in `.alchemy/log/dev_$USER/Api/`.

| Symptom                                                                        | Likely cause                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack rejects the manifest                                                     | An `event_subscriptions` block was added to it. Remove it and add the events in step 4.                                                                                                                        |
| Request URL won't verify                                                       | Dev or the tunnel isn't running, the URL is missing `/integrations/slack/webhook`, or the tunnel address changed.                                                                                              |
| `/api/connections` returns `{"live":[]}`                                       | `SLACK_BOT_TOKEN` isn't in `.env`, or the server hasn't restarted since you added it.                                                                                                                          |
| A step fails with "Slack rejected the bot token"                               | The token is wrong or was revoked. Copy it again from OAuth & Permissions.                                                                                                                                     |
| "the bot isn't in that channel"                                                | The channel is private. Invite the bot.                                                                                                                                                                        |
| "the Slack app is missing a scope"                                             | The app was created without the full manifest. Add the scope and reinstall.                                                                                                                                    |
| A task's DM failed with "no one in the Slack workspace has that email address" | The person's entity has an `email` that isn't a member of the workspace. Fix the address, then start a new run.                                                                                                |
| A task DM has no **Open in Studio** button                                     | The automation was saved before task messages existed. Save it again, or set `STUDIO_URL`.                                                                                                                     |
| Clicking **Approve** or **Reject** shows an error in Slack                     | The interactivity Request URL is still the placeholder, the tunnel address changed, or dev isn't running. The Channels log shows `Slack interactivity authentication failed` when the signing secret is wrong. |
| "Only members of … can answer this" after a click                              | Your Slack account's email address isn't the `email` of any member the task recorded when it opened. Fix the entity or the role, then start a new run.                                                         |
| "Slack has no email address for you" after a click                             | The app lacks `users:read.email`, or the account is a bot or has no email. Add the scope and reinstall.                                                                                                        |
| A click is accepted but the message never changes                              | The Api log shows `Slack click failed` or `Dropped a Slack click`. `SLACK_BOT_TOKEN` must be set for the Api too.                                                                                              |
| A mention starts nothing                                                       | The bot isn't in the channel, the bot events aren't subscribed, no saved automation listens for `slack.mention`, or the Channels log shows a signature failure (wrong `SLACK_SIGNING_SECRET`).                 |
| `Webhook authentication failed` in the log                                     | A request without a valid Slack signature was refused, as intended. If it came from Slack, check the signing secret.                                                                                           |

Slack takes no idempotency key, so a send step that is retried after a post that wasn't recorded posts again. Task messages check the DM before posting again; see [Task messages](#task-messages).
