/** Sends email through Resend when the deployment has an API key; otherwise email stays simulated. */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/*
 * Why Resend and not Cloudflare's `send_email` binding: steps are delivered at least once, and
 * Resend deduplicates a send by its `Idempotency-Key` for 24 hours, so a retried step doesn't send
 * twice. Cloudflare Email Service's `send()` takes no idempotency key (and sending is in beta).
 */

export class EmailSendError extends Schema.TaggedError<EmailSendError>()("EmailSendError", {
  message: Schema.String,
  /** Resend's error name, such as `validation_error` or `rate_limit_exceeded`, when it gave one. */
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
  /** Resend's ID for the email. */
  readonly messageId: string;
}

export interface EmailSenderService {
  /**
   * Sends one email. Resend sends at most one email per `idempotencyKey` within 24 hours; a repeat
   * with the same key and message returns the first email's ID.
   */
  readonly send: (
    message: EmailMessage,
    idempotencyKey: string,
  ) => Effect.Effect<EmailSent, EmailSendError>;
}

/**
 * The deployment's email sender, or `null` when it has no `RESEND_API_KEY`. `email.send` reads it:
 * with a sender it sends for real, without one it records what it would have sent.
 */
export const EmailSender = Context.Reference<EmailSenderService | null>("automations/EmailSender", {
  defaultValue: () => null,
});

/**
 * Resend's shared test sender, used when `EMAIL_FROM` isn't set. Resend lets it reach only the
 * address that owns the Resend account; anyone else needs a verified domain.
 */
export const DEFAULT_EMAIL_FROM = "Automations studio <onboarding@resend.dev>";

const ErrorResponse = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
const SendResponse = Schema.Struct({ id: Schema.String });

/** What to tell the person designing the workflow when Resend refuses. */
const explain = (status: number, name: string, message: string) => {
  // Resend answers 401 for a missing or wrong key, naming a wrong one only `validation_error`.
  if (status === 401) return "Resend rejected the API key; check RESEND_API_KEY";
  // A 403 validation error is Resend's sandbox: the sender's domain isn't verified for this recipient.
  if (status === 403 && name === "validation_error") {
    return "Resend won't send from this address to that recipient: verify your domain in Resend and set EMAIL_FROM to an address on it";
  }
  switch (name) {
    case "restricted_api_key":
    case "suspended_api_key":
    case "invalid_permission":
      return "Resend rejected the API key; check RESEND_API_KEY";
    case "daily_quota_exceeded":
      return "The Resend account has used up its daily sending quota";
    case "monthly_quota_exceeded":
      return "The Resend account has used up its monthly sending quota";
    case "invalid_idempotent_request":
      return "Resend refused the email: this step already sent a different one, so nothing was sent again";
    default:
      return `Resend refused the email: ${message || name}`;
  }
};

/** Failures worth trying again: the same key makes a repeat safe. */
const transient = new Set([
  "rate_limit_exceeded",
  "concurrent_idempotent_requests",
  "application_error",
  "service_unavailable",
  "internal_server_error",
]);

const retryTransient = Schedule.recurs(3).pipe(
  Schedule.while(
    ({ input }) =>
      input instanceof EmailSendError && input.code !== undefined && transient.has(input.code),
  ),
);

/** How long to wait before the next attempt: Resend's Retry-After, capped, or a second. */
const waitFor = (retryAfter: string | undefined) => {
  const seconds = Number(retryAfter ?? "1");
  return Duration.seconds(Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 5) : 1);
};

/** A sender over Resend's API with an API key. `origin` is for tests. */
export const makeResendSender = (
  apiKey: Redacted.Redacted<string>,
  from: string = DEFAULT_EMAIL_FROM,
  origin = "https://api.resend.com/",
): EmailSenderService => ({
  send: Effect.fn("Email.send")(
    function* (message: EmailMessage, idempotencyKey: string) {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(new URL("emails", origin).toString()).pipe(
          HttpClientRequest.bearerToken(Redacted.value(apiKey)),
          HttpClientRequest.setHeader("idempotency-key", idempotencyKey),
          HttpClientRequest.bodyJsonUnsafe({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.body,
          }),
        ),
      );
      const json = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      if (response.status >= 200 && response.status < 300) {
        const sent = yield* Schema.decodeUnknownEffect(SendResponse)(json).pipe(
          Effect.mapError(
            () => new EmailSendError({ message: "Resend answered in an unexpected shape" }),
          ),
        );
        return { messageId: sent.id };
      }
      const error = Option.getOrUndefined(Schema.decodeUnknownOption(ErrorResponse)(json));
      const name =
        error?.name ?? (response.status >= 500 ? "service_unavailable" : `http_${response.status}`);
      const detail = error?.message ?? "";
      if (transient.has(name)) {
        yield* Effect.sleep(waitFor(response.headers["retry-after"]));
      }
      return yield* new EmailSendError({
        message: explain(response.status, name, detail),
        code: name,
      });
    },
    Effect.retry(retryTransient),
    Effect.timeout("30 seconds"),
    // Resend is a third party: don't forward trace headers to it.
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((error) =>
      error instanceof EmailSendError
        ? error
        : new EmailSendError({ message: `Sending through Resend failed: ${String(error)}` }),
    ),
  ),
});
