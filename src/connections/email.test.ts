import { afterAll, beforeEach, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Events } from "../events/service.ts";
import { RunId } from "../workflow/run.ts";
import type { ActionStep } from "../workflow/model.ts";
import { DEFAULT_EMAIL_FROM, EmailSender, makeResendSender } from "./email.ts";
import { runAction } from "./runner.ts";

interface Call {
  readonly path: string;
  readonly auth: string | null;
  readonly key: string | null;
  readonly body: Record<string, unknown>;
}

/** A fake Resend: refuses by recipient, and keeps one email per idempotency key like the real one. */
const calls: Array<Call> = [];
const sent = new Map<string, { id: string; body: string }>();
/** Answers the next requests with these responses before behaving normally. */
const queued: Array<() => Response> = [];
const refusal = (status: number, name: string, message: string) => () =>
  Response.json({ statusCode: status, name, message }, { status });

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const text = await request.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    const key = request.headers.get("idempotency-key");
    calls.push({
      path: new URL(request.url).pathname,
      auth: request.headers.get("authorization"),
      key,
      body,
    });
    const next = queued.shift();
    if (next !== undefined) return next();
    const to = (body["to"] as Array<string>)[0];
    if (to === "stranger@example.com") {
      return refusal(
        403,
        "validation_error",
        "You can only send testing emails to your own email address",
      )();
    }
    if (to === "quota@example.com") {
      return refusal(
        429,
        "daily_quota_exceeded",
        "You have reached your daily email sending quota.",
      )();
    }
    if (key !== null) {
      const earlier = sent.get(key);
      if (earlier !== undefined) {
        return earlier.body === text
          ? Response.json({ id: earlier.id })
          : refusal(
              409,
              "invalid_idempotent_request",
              "This idempotency key has already been used on a request that had a different payload",
            )();
      }
    }
    const id = `email-${sent.size + 1}`;
    if (key !== null) sent.set(key, { id, body: text });
    return Response.json({ id });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  calls.length = 0;
  queued.length = 0;
});

const origin = server.url.href;
const sender = makeResendSender(Redacted.make("re_test"), "People Ops <people@acme.dev>", origin);
const welcome = { to: "sam@example.com", subject: "Welcome", body: "Hi Sam" };

const step: ActionStep = {
  id: "welcome",
  title: "Welcome",
  kind: "action",
  use: "email.send",
  with: {},
};
const state = { runId: RunId.make("run-1"), subject: null, steps: {} };
/** runAction needs a publisher; email steps never publish. */
const noEvents = Effect.provideService(Events, { publish: () => Effect.die("unexpected publish") });

test("sends one plain-text email with the API key and the step's idempotency key", async () => {
  const result = await Effect.runPromise(sender.send(welcome, "step-key-1"));
  expect(result).toEqual({ messageId: "email-1" });
  expect(calls).toEqual([
    {
      path: "/emails",
      auth: "Bearer re_test",
      key: "step-key-1",
      body: {
        from: "People Ops <people@acme.dev>",
        to: ["sam@example.com"],
        subject: "Welcome",
        text: "Hi Sam",
      },
    },
  ]);
});

test("sends from Resend's test address when EMAIL_FROM isn't set", async () => {
  const fallback = makeResendSender(Redacted.make("re_test"), undefined, origin);
  await Effect.runPromise(fallback.send(welcome, "step-key-default"));
  expect(calls[0]?.body["from"]).toBe(DEFAULT_EMAIL_FROM);
});

test("a retried step sends under the same key, so Resend sends it once", async () => {
  const first = await Effect.runPromise(sender.send(welcome, "step-key-retry"));
  const again = await Effect.runPromise(sender.send(welcome, "step-key-retry"));
  expect(again).toEqual(first);
  expect(calls.map((call) => call.key)).toEqual(["step-key-retry", "step-key-retry"]);
  expect([...sent.keys()].filter((key) => key === "step-key-retry")).toHaveLength(1);

  // A different email under a used key is refused in words, not sent.
  const changed = await Effect.runPromise(
    sender.send({ ...welcome, body: "Changed" }, "step-key-retry").pipe(Effect.flip),
  );
  expect(changed).toMatchObject({ code: "invalid_idempotent_request" });
  expect(changed.message).toContain("already sent a different one");
});

test("waits out a rate limit and an in-flight duplicate, then sends", async () => {
  queued.push(
    () =>
      Response.json(
        { name: "rate_limit_exceeded", message: "Too many requests" },
        { status: 429, headers: { "retry-after": "0" } },
      ),
    () =>
      Response.json(
        { name: "concurrent_idempotent_requests", message: "In progress" },
        { status: 409, headers: { "retry-after": "0" } },
      ),
  );
  const result = await Effect.runPromise(sender.send(welcome, "step-key-busy"));
  expect(result.messageId).toStartWith("email-");
  expect(calls.map((call) => call.key)).toEqual([
    "step-key-busy",
    "step-key-busy",
    "step-key-busy",
  ]);
});

test("explains Resend's refusals in plain words and doesn't retry them", async () => {
  const stranger = await Effect.runPromise(
    sender.send({ ...welcome, to: "stranger@example.com" }, "k-stranger").pipe(Effect.flip),
  );
  expect(stranger).toMatchObject({ code: "validation_error" });
  expect(stranger.message).toContain("verify your domain in Resend and set EMAIL_FROM");

  const quota = await Effect.runPromise(
    sender.send({ ...welcome, to: "quota@example.com" }, "k-quota").pipe(Effect.flip),
  );
  expect(quota.message).toContain("used up its daily sending quota");

  // Resend's answer to a wrong key, as observed: 401 with the generic validation_error name.
  queued.push(refusal(401, "validation_error", "API key is invalid"));
  const key = await Effect.runPromise(sender.send(welcome, "k-auth").pipe(Effect.flip));
  expect(key.message).toBe("Resend rejected the API key; check RESEND_API_KEY");

  queued.push(refusal(422, "validation_error", "Invalid `to` field."));
  const invalid = await Effect.runPromise(sender.send(welcome, "k-invalid").pipe(Effect.flip));
  expect(invalid.message).toBe("Resend refused the email: Invalid `to` field.");

  // One request each: refusals are final.
  expect(calls).toHaveLength(4);
});

test("email.send sends when a sender is provided and is simulated without one", async () => {
  const inputs = {
    to: { $title: "Sam", email: "sam@example.com" },
    subject: "Welcome",
    body: "Hi Sam",
  };
  const live = await Effect.runPromise(
    runAction(step, inputs, state, "action-key").pipe(
      Effect.provideService(EmailSender, sender),
      noEvents,
    ),
  );
  expect(live).toEqual({
    messageId: expect.stringMatching(/^email-/),
    to: "sam@example.com",
    subject: "Welcome",
    body: "Hi Sam",
  });
  expect(calls.at(-1)?.key).toBe("action-key");

  calls.length = 0;
  const simulated = await Effect.runPromise(
    runAction(step, inputs, state, "action-key").pipe(noEvents),
  );
  expect(simulated).toEqual({
    simulated: true,
    messageId: "sim_action-key",
    to: "sam@example.com",
    subject: "Welcome",
    body: "Hi Sam",
  });
  expect(calls).toHaveLength(0);

  const failed = await Effect.runPromise(
    runAction(step, { ...inputs, to: "stranger@example.com" }, state, "action-key-2").pipe(
      Effect.provideService(EmailSender, sender),
      noEvents,
      Effect.flip,
    ),
  );
  expect(failed).toMatchObject({ step: "welcome" });
  expect(failed.message).toContain("verify your domain in Resend");
});
