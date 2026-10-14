# Email

`email.send` sends real email through [Resend](https://resend.com) when the deployment has a Resend API key. Without one, email stays simulated: the step succeeds, contacts no one, and records what it would have sent with `simulated: true`.

Use a test recipient while you try it out. Every saved automation that sends email sends for real once the key is set.

## Why Resend

Steps are delivered at least once: a run that restarts after a step's work but before the run recorded it does that step again. So a real send needs the provider to recognize a repeat.

- Resend takes an `Idempotency-Key` header and sends at most one email per key for 24 hours. A repeat with the same key and the same message returns the first email's ID without sending.
- Cloudflare Email Service has a Workers binding, and Alchemy 2 exposes it. Once a domain is onboarded it can reach any recipient, but its `send()` takes no idempotency key, and sending is in beta on the Workers Paid plan. Under `alchemy dev` it also writes `.eml` files instead of sending unless the binding is marked remote.

Resend is called over HTTPS with `fetch`, so it sends the same way under `mise run dev` as when deployed.

## 1. Get an API key

1. Create an account at [resend.com](https://resend.com).
2. Under **API Keys**, create a key with **Sending access**. Full access works too, but sending is all the studio needs.

Without a verified domain, Resend sends only from its shared address, `onboarding@resend.dev`, and only to the email address you signed up with. That's enough to see a real email arrive. To reach anyone else, such as a new hire:

3. Under **Domains**, add a domain you control and create the DNS records Resend lists. If the domain is on Cloudflare, Resend can add them for you.
4. Wait until Resend shows the domain as verified.

## 2. Add the configuration

Put the key, and the sender once you have a verified domain, in `.env` at the root of the checkout. `.env` is gitignored, so check with `git check-ignore .env` and never commit it.

```dotenv
RESEND_API_KEY=re_...                          # API Keys
EMAIL_FROM="People Ops <people@example.com>"   # optional: an address on your verified domain
```

| Set                             | Result                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Neither                         | Email is simulated: steps record `simulated: true` and contact no one.                      |
| `RESEND_API_KEY`                | Email is live, sent from `Automations studio <onboarding@resend.dev>`, to your own address. |
| `RESEND_API_KEY` + `EMAIL_FROM` | Email is live, sent from `EMAIL_FROM`, to anyone.                                           |

The stack reads these values when it starts (`mise run dev`) or deploys, and a deploy binds them to the `Api` Worker as secrets. Restart or redeploy after changing them.

Workflows never contain the key or the sender. Don't paste the key into a chat with the planner.

## 3. Check it works

Set `STUDIO_URL` to the Studio URL that `mise run dev` prints. Then check which connections are live:

```sh
curl -s "$STUDIO_URL/api/connections"
# {"live":["email"]}
```

If `email` isn't listed, the server didn't see `RESEND_API_KEY`. The studio also tags email steps "Simulated" when email isn't live.

In the studio, create an automation with the sidebar's **+**. Without a verified domain, use the address you signed up to Resend with:

> When I start it, email you@example.com with the subject "Hello from automations" and the body "It works." Run it without approval.

Choose **Save draft**, then **Run saved version**. The email should arrive within a minute, and appear under **Emails** in Resend. The run's step record should show Resend's `messageId` with no "Simulated" tag. Resend's test address `delivered@resend.dev` also works as a recipient if you don't want anything in a real inbox.

For the welcome email from an approved template, pick an employee entity whose `email` is a real inbox, and run an automation whose `email.send` step uses the welcome template.

## How a send behaves

- **Message.** One recipient, a subject, and a plain-text body. A person input becomes its email address.
- **Retries.** The step passes its idempotency key, which stays the same across retries and replays of that step in that run, as Resend's `Idempotency-Key`. A retry within 24 hours sends nothing new and records the same `messageId`.
- **Rate limits.** When Resend answers 429 for its rate limit, or 409 because the same key is still in flight, the sender waits for Resend's `Retry-After` (at most 5 seconds) and tries again, up to three times. Server errors are retried the same way, which is safe under the same key.
- **Refusals.** Anything else fails the step with a plain reason, and the run stops there.

## Troubleshooting

Api logs, where runs send their email, are in `.alchemy/log/dev_$USER/Api/`.

| Symptom                                                 | Likely cause                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/api/connections` doesn't list `email`                 | `RESEND_API_KEY` isn't in `.env`, or the server hasn't restarted since you added it.             |
| "Resend rejected the API key"                           | The key is wrong, was deleted, or lacks sending access. Create a new one.                        |
| "Resend won't send from this address to that recipient" | There's no verified domain, or `EMAIL_FROM` isn't on it. Verify the domain and set `EMAIL_FROM`. |
| "used up its daily sending quota"                       | The Resend plan's quota is spent. Wait, or upgrade the plan.                                     |
| "this step already sent a different one"                | The same step, in the same run, sent different text within 24 hours. Nothing was sent again.     |
| The step succeeded but nothing arrived                  | Check **Emails** in Resend for a bounce, and the recipient's spam folder.                        |

## Limits

- Resend keeps idempotency keys for 24 hours. A step retried later than that sends again. Steps retry within seconds, so this matters only for a run restarted by hand a day later.
- A human step's `notify: email` is still recorded, not sent.
- Bodies are plain text. HTML, attachments, CC and BCC aren't supported.
