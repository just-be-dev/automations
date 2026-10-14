/** Sends email through Cloudflare Email Service's `send_email` binding, explaining its refusals in plain words. */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  EmailSendError,
  type EmailMessage,
  type EmailSenderService,
} from "../../connections/email.ts";
import { messageOf } from "../../error.ts";

/** The part of the runtime `send_email` binding the sender uses. */
export interface EmailBinding {
  readonly send: (message: {
    readonly from: string | { readonly email: string; readonly name: string };
    readonly to: string;
    readonly subject: string;
    readonly text: string;
  }) => Promise<{ readonly messageId: string }>;
}

/** The sender every email comes from: an address on a domain onboarded to Email Service. */
export interface EmailFrom {
  readonly email: string;
  /** A display name, such as "People Ops". */
  readonly name?: string | undefined;
}

/** Cloudflare's code from a failed `send()`: on the error as `code`, or at the start of its message. */
const codeOf = (error: unknown) => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : /\bE_[A-Z_]+\b/.exec(messageOf(error, ""))?.[0];
};

/** What to tell the person designing the workflow when Email Service refuses. */
const explain = (code: string | undefined, message: string) => {
  switch (code) {
    case "E_SENDER_NOT_VERIFIED":
    case "E_SENDER_DOMAIN_NOT_AVAILABLE":
      return "Cloudflare won't send from EMAIL_FROM: onboard its domain under Email Service → Email Sending";
    case "E_RECIPIENT_NOT_ALLOWED":
      return "Cloudflare won't send to that address yet: finish onboarding the sending domain in Email Service";
    case "E_RECIPIENT_SUPPRESSED":
      return "That address is on the account's suppression list after an earlier bounce or complaint";
    case "E_DELIVERY_FAILED":
      return "The recipient's mail server refused the email";
    case "E_RATE_LIMIT_EXCEEDED":
      return "Cloudflare Email Service is rate limiting this account; run it again shortly";
    case "E_DAILY_LIMIT_EXCEEDED":
      return "The Cloudflare account has used up its daily sending quota";
    case "E_CONTENT_TOO_LARGE":
      return "The email is too large to send";
    case "E_INTERNAL_SERVER_ERROR":
      return "Cloudflare Email Service is unavailable right now";
    case undefined:
      // No code: the send may not have reached Email Service at all.
      return `Sending through Cloudflare Email Service failed: ${message || "unknown error"}`;
    default:
      return `Cloudflare refused the email: ${message || code}`;
  }
};

/**
 * A sender over the `send_email` binding. Email Service takes no idempotency key, so delivery is
 * at least once. A rate-limited send was refused, not sent, so it is retried after a wait that
 * starts at `rateLimitWait` and doubles; every other refusal is final for this attempt.
 */
export const makeCloudflareEmailSender = (
  binding: EmailBinding,
  from: EmailFrom,
  rateLimitWait: Duration.Input = "1 second",
): EmailSenderService => ({
  send: Effect.fn("Email.send")(
    function* (message: EmailMessage) {
      const sent = yield* Effect.tryPromise({
        try: () =>
          binding.send({
            from: from.name === undefined ? from.email : { email: from.email, name: from.name },
            to: message.to,
            subject: message.subject,
            text: message.body,
          }),
        catch: (error) => {
          const code = codeOf(error);
          return new EmailSendError({
            message: explain(code, messageOf(error, "")),
            ...(code === undefined ? {} : { code }),
          });
        },
      });
      return { messageId: sent.messageId };
    },
    Effect.retry({
      schedule: Schedule.exponential(rateLimitWait),
      times: 3,
      while: (error) => error.code === "E_RATE_LIMIT_EXCEEDED",
    }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new EmailSendError({ message: "Cloudflare Email Service didn't answer in time" }),
        ),
    }),
  ),
});
