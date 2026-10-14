import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Events } from "../events/service.ts";
import { RunId } from "../workflow/run.ts";
import type { ActionStep } from "../workflow/model.ts";
import { EmailSendError, EmailSender, type EmailMessage } from "./email.ts";
import { runAction } from "./runner.ts";

const step: ActionStep = {
  id: "welcome",
  title: "Welcome",
  kind: "action",
  use: "email.send",
  with: {},
};
const state = { runId: RunId.make("run-1"), subject: null, steps: {} };
const inputs = {
  to: { $title: "Sam", email: "sam@example.com" },
  subject: "Welcome",
  body: "Hi Sam",
};
/** runAction needs a publisher; email steps never publish. */
const noEvents = Effect.provideService(Events, { publish: () => Effect.die("unexpected publish") });

test("email.send sends through the deployment's sender and records its ID", async () => {
  const sent: Array<EmailMessage> = [];
  const live = await Effect.runPromise(
    runAction(step, inputs, state, "action-key").pipe(
      Effect.provideService(EmailSender, {
        send: (message) => Effect.sync(() => (sent.push(message), { messageId: "msg-1" })),
      }),
      noEvents,
    ),
  );
  expect(sent).toEqual([{ to: "sam@example.com", subject: "Welcome", body: "Hi Sam" }]);
  expect(live).toEqual({
    messageId: "msg-1",
    to: "sam@example.com",
    subject: "Welcome",
    body: "Hi Sam",
  });
});

test("email.send is simulated without a sender", async () => {
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
});

test("a refusal fails the step with the sender's plain words", async () => {
  const failed = await Effect.runPromise(
    runAction(step, inputs, state, "action-key").pipe(
      Effect.provideService(EmailSender, {
        send: () =>
          Effect.fail(
            new EmailSendError({ message: "The recipient's mail server refused the email" }),
          ),
      }),
      noEvents,
      Effect.flip,
    ),
  );
  expect(failed).toMatchObject({
    step: "welcome",
    message: "The recipient's mail server refused the email",
  });
});
