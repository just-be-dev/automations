import { beforeEach, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { type EmailBinding, makeCloudflareEmailSender } from "./email.ts";

/** Errors the way the `send_email` binding throws them: an Error with a `code`. */
const refusal = (code: string, message: string) => Object.assign(new Error(message), { code });

/** A fake binding: records each message, and throws the queued errors before sending. */
const sent: Array<Parameters<EmailBinding["send"]>[0]> = [];
const queued: Array<unknown> = [];
const binding: EmailBinding = {
  send: async (message) => {
    sent.push(message);
    const next = queued.shift();
    if (next !== undefined) throw next;
    return { messageId: `msg-${sent.length}` };
  },
};
beforeEach(() => {
  sent.length = 0;
  queued.length = 0;
});

const from = { email: "people@acme.dev", name: "People Ops" };
const sender = makeCloudflareEmailSender(binding, from, "1 millis");
const welcome = { to: "sam@example.com", subject: "Welcome", body: "Hi Sam" };

test("sends one plain-text email from the configured sender and returns Cloudflare's ID", async () => {
  expect(await Effect.runPromise(sender.send(welcome))).toEqual({ messageId: "msg-1" });
  expect(sent).toEqual([
    {
      from: { email: "people@acme.dev", name: "People Ops" },
      to: "sam@example.com",
      subject: "Welcome",
      text: "Hi Sam",
    },
  ]);
});

test("sends from the bare address when there's no display name", async () => {
  const bare = makeCloudflareEmailSender(binding, { email: "people@acme.dev" });
  await Effect.runPromise(bare.send(welcome));
  expect(sent[0]?.from).toBe("people@acme.dev");
});

test("waits out a rate limit, then sends", async () => {
  queued.push(
    refusal("E_RATE_LIMIT_EXCEEDED", "Sending rate limit reached"),
    refusal("E_RATE_LIMIT_EXCEEDED", "Sending rate limit reached"),
  );
  expect(await Effect.runPromise(sender.send(welcome))).toEqual({ messageId: "msg-3" });
  expect(sent).toHaveLength(3);
});

test("gives up on a rate limit that lasts, saying so", async () => {
  queued.push(...Array.from({ length: 4 }, () => refusal("E_RATE_LIMIT_EXCEEDED", "limit")));
  const error = await Effect.runPromise(sender.send(welcome).pipe(Effect.flip));
  expect(error).toMatchObject({ code: "E_RATE_LIMIT_EXCEEDED" });
  expect(error.message).toContain("rate limiting this account");
  expect(sent).toHaveLength(4);
});

test("explains Email Service's refusals in plain words and doesn't retry them", async () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [refusal("E_SENDER_NOT_VERIFIED", "Sender domain not verified"), "onboard its domain"],
    [refusal("E_SENDER_DOMAIN_NOT_AVAILABLE", "Domain not onboarded"), "onboard its domain"],
    [refusal("E_RECIPIENT_NOT_ALLOWED", "Recipient not in allowed list"), "finish onboarding"],
    [refusal("E_RECIPIENT_SUPPRESSED", "Suppressed"), "suppression list"],
    [refusal("E_DAILY_LIMIT_EXCEEDED", "Daily sending quota reached"), "daily sending quota"],
    [refusal("E_DELIVERY_FAILED", "550 no such user"), "mail server refused"],
    [
      refusal("E_FIELD_MISSING", "subject is required"),
      "Cloudflare refused the email: subject is required",
    ],
    // A remote binding may carry the code only in the message.
    [new Error("E_SENDER_NOT_VERIFIED: sender domain not verified"), "onboard its domain"],
    [new Error("socket closed"), "Sending through Cloudflare Email Service failed: socket closed"],
  ];
  for (const [error, words] of cases) {
    queued.push(error);
    const failed = await Effect.runPromise(sender.send(welcome).pipe(Effect.flip));
    expect(failed.message).toContain(words);
  }
  expect(sent).toHaveLength(cases.length);
});
