# Email

`email.send` sends real email through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) when the deployment has a sender address, `EMAIL_FROM`. Without one, email stays simulated: the step succeeds, contacts no one, and records what it would have sent with `simulated: true`.

Use a test recipient while you try it out. Every saved automation that sends email sends for real once `EMAIL_FROM` is set, under `mise run dev` as well as when deployed.

## How it sends

The Automation object sends through a Workers `send_email` binding named `Email`, which the stack declares only when `EMAIL_FROM` is set. The binding may send only from that address. It is marked remote, so `alchemy dev` sends through the real service instead of Alchemy's local simulator, which only writes `.eml` files.

Email Service takes no idempotency key, so `email.send` is delivered **at least once**, like `slack.sendMessage`. If a run restarts after Cloudflare accepted an email but before the run recorded it, or a send fails in a way that hides whether it went out, the step sends again.

## 1. Onboard a sending domain

Email Service needs the Workers Paid plan and a domain on Cloudflare DNS.

1. In the Cloudflare dashboard, open **Compute → Email Service → Email Sending**.
2. Choose **Onboard Domain** and pick the domain, or a subdomain of it, such as `mail.example.com`.
3. Cloudflare adds the DKIM, SPF and return-path records. Wait until the domain shows as enabled.

Until a domain is onboarded, Email Service sends only to destination addresses verified in your account, so a new hire's address is refused.

## 2. Add the configuration

Put the sender in `.env` at the root of the checkout. `.env` is gitignored, so check with `git check-ignore .env` and never commit it.

```dotenv
EMAIL_FROM=people@mail.example.com   # an address on the onboarded domain
EMAIL_FROM_NAME="People Ops"         # optional: the name recipients see
```

| Set          | Result                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| Neither      | Email is simulated: steps record `simulated: true` and contact no one. |
| `EMAIL_FROM` | Email is live, sent from that address through Email Service.           |

The stack reads these values when it starts (`mise run dev`) or deploys, and binds them to the `Api` Worker, which hosts the Automation objects. Restart or redeploy after changing them. No API key is needed: the binding authorizes sending, and `alchemy dev` reaches it with the same Cloudflare profile it uses for Workers AI.

Workflows never contain the sender. Recipients come from the workflow, usually an entity's `email` field.

## 3. Check it works

Set `STUDIO_URL` to the Studio URL that `mise run dev` prints. Then check which connections are live:

```sh
curl -s "$STUDIO_URL/api/connections"
# {"live":["email"]}
```

If `email` isn't listed, the server didn't see `EMAIL_FROM`. The studio also tags email steps "Simulated" when email isn't live.

In the studio, create an automation with the sidebar's **+**, using an inbox you can read:

> When I start it, email you@example.com with the subject "Hello from automations" and the body "It works." Run it without approval.

Choose **Save draft**, then **Run saved version**. The email should arrive within a minute from `EMAIL_FROM`. The run's step record should show Cloudflare's `messageId` with no "Simulated" tag. Check the spam folder if it doesn't arrive; a newly onboarded domain has no sending reputation yet.

For the welcome email from an approved template, run `mise run demo:reset`, pick an employee entity whose `email` is a real inbox, and run an automation whose `email.send` step uses the welcome template.

## How a send behaves

- **Message.** One recipient, a subject, and a plain-text body, from `EMAIL_FROM`. A person input becomes its email address.
- **Rate limits.** When Email Service answers `E_RATE_LIMIT_EXCEEDED`, the email wasn't sent, so the sender waits (1, 2, then 4 seconds) and tries again, up to three times.
- **Refusals.** Anything else fails the step with a plain reason, such as an unverified sender or a suppressed recipient. The run stops there.

## Troubleshooting

Api logs, where runs send their email, are in `.alchemy/log/dev_$USER/Api/`.

| Symptom                                         | Likely cause                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/api/connections` doesn't list `email`         | `EMAIL_FROM` isn't in `.env`, or the server hasn't restarted since you added it.                 |
| "Cloudflare won't send from EMAIL_FROM"         | `EMAIL_FROM`'s domain isn't onboarded or enabled in Email Sending, or the address has a typo.    |
| "Cloudflare won't send to that address yet"     | The domain is still being onboarded, so only verified destination addresses can receive.         |
| "on the account's suppression list"             | The address bounced or complained before. Remove it from the suppression list in Email Service.  |
| "used up its daily sending quota"               | New accounts start with a small daily quota that grows with good sending. Wait for the next day. |
| "The recipient's mail server refused the email" | The address doesn't exist, or the receiving server rejected the message.                         |
| The step succeeded but nothing arrived          | Check the recipient's spam folder, and the domain's sending activity in Email Service.           |

## Limits

- Delivery is at least once: a retried step can send the same email twice.
- A human step's `notify: email` is still recorded, not sent.
- Bodies are plain text. HTML, attachments, CC and BCC aren't supported.
