/** The email sender `email.send` uses when the deployment can send email; otherwise email stays simulated. */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class EmailSendError extends Schema.TaggedError<EmailSendError>()("EmailSendError", {
  /** Plain words for the person designing the workflow. */
  message: Schema.String,
  /** The provider's error code, such as `E_SENDER_NOT_VERIFIED`, when it gave one. */
  code: Schema.optionalKey(Schema.String),
}) {}

export interface EmailMessage {
  /** One email address. */
  readonly to: string;
  readonly subject: string;
  /** Plain text. */
  readonly body: string;
}

export interface EmailSent {
  /** The provider's ID for the email. */
  readonly messageId: string;
}

export interface EmailSenderService {
  /**
   * Sends one email. The provider takes no idempotency key, so a step retried after a send that
   * wasn't journaled sends again: delivery is at least once.
   */
  readonly send: (message: EmailMessage) => Effect.Effect<EmailSent, EmailSendError>;
}

/**
 * The deployment's email sender, or `null` when it has no sender address (`EMAIL_FROM`).
 * `email.send` reads it: with a sender it sends for real, without one it records what it would
 * have sent. The Automation object provides it from Cloudflare Email Service.
 */
export const EmailSender = Context.Reference<EmailSenderService | null>("automations/EmailSender", {
  defaultValue: () => null,
});
