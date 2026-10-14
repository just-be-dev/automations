/** Executes action operations: guarded HTTP requests, email and Slack when credentialed, and replay-stable simulations otherwise. */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { EntityPut, MAX_EVENT_DEPTH, PublishEvent } from "../events/model.ts";
import { Events } from "../events/service.ts";
import { EmailSender } from "./email.ts";
import { SlackSender } from "./slack.ts";
import { StepFailed } from "../workflow/interpreter.ts";
import {
  durationMillis,
  isDuration,
  isPublicHttpsUrl,
  loneRef,
  type ActionStep,
} from "../workflow/model.ts";
import type { ExecutionValues } from "../workflow/execution.ts";

/**
 * Executes connection operations for action steps. `http.post` really sends and `events.emit`
 * really publishes. Email sends for real when the deployment provides an `EmailSender` (a Resend
 * API key), passing the step's idempotency key so a retried step sends once. Slack posts for real
 * when the deployment provides a `SlackSender` (a bot token); delivery is at least once, because
 * Slack takes no idempotency key. Calendar, and Email and Slack without credentials, are
 * simulated: they succeed, contact nothing, and record what they would have sent with
 * `simulated: true`. Their IDs derive from the step's idempotency key, so a retried step records
 * the same thing.
 */

type Inputs = Readonly<Record<string, Schema.Json>>;

const recorded = (value: Record<string, Schema.Json>): Schema.Json => value;

const fail = (step: ActionStep, message: string) => new StepFailed({ step: step.id, message });

const text = (inputs: Inputs, name: string) => {
  const value = inputs[name];
  return typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : JSON.stringify(value);
};

const fieldOf = (value: Schema.Json, name: string) =>
  typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined;

/** A person input as a recipient: an entity with an `email` field, or an email address. */
const recipient = (step: ActionStep, name: string, value: Schema.Json | undefined) => {
  const email = typeof value === "string" ? value : fieldOf(value ?? null, "email");
  const title = fieldOf(value ?? null, "$title");
  return typeof email === "string" && email.includes("@")
    ? Effect.succeed({ email, name: typeof title === "string" ? title : email })
    : Effect.fail(fail(step, `${name} has no email address: ${JSON.stringify(value ?? null)}`));
};

const recipients = (step: ActionStep, name: string, value: Schema.Json | undefined) =>
  Effect.forEach(Array.isArray(value) ? value : [value ?? null], (person) =>
    recipient(step, name, person),
  );

const dateInput = (step: ActionStep, inputs: Inputs, name: string) => {
  const value = text(inputs, name);
  const millis = Date.parse(value);
  return Number.isNaN(millis)
    ? Effect.fail(fail(step, `${name} is not a date and time: ${value || "(empty)"}`))
    : Effect.succeed(millis);
};

const durationInput = (step: ActionStep, inputs: Inputs, name: string) => {
  const value = text(inputs, name);
  return isDuration(value)
    ? Effect.succeed(value)
    : Effect.fail(fail(step, `${name} must be a duration such as "30 minutes": ${value}`));
};

const workday = (millis: number) => {
  const day = new Date(millis).getUTCDay();
  return day !== 0 && day !== 6;
};

/** Pretend availability: weekday slots at 10:00 and 14:00 UTC, starting the day after `after`. */
const openTimes = (after: number) =>
  Array.from({ length: 14 }, (_, offset) => {
    const day = new Date(after);
    day.setUTCHours(0, 0, 0, 0);
    return day.getTime() + (offset + 1) * 86_400_000;
  })
    .filter(workday)
    .flatMap((day) => [day + 10 * 3_600_000, day + 14 * 3_600_000])
    .slice(0, 4)
    .map((millis) => new Date(millis).toISOString());

const postJson = Effect.fn("Connections.httpPost")(
  function* (step: ActionStep, url: string, body: Schema.Json, idempotencyKey: string) {
    if (!isPublicHttpsUrl(url)) {
      return yield* fail(step, "url must be a public HTTPS URL without credentials");
    }
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeader("idempotency-key", idempotencyKey),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
    const responseText = yield* response.text;
    if (response.status < 200 || response.status >= 300) {
      return yield* fail(step, `POST ${url} returned ${response.status}`);
    }
    return { status: response.status, body: responseText.slice(0, 4000) };
  },
  Effect.timeout("30 seconds"),
  // Webhook receivers are third parties: don't forward trace headers to them.
  Effect.provideService(HttpClient.TracerPropagationEnabled, false),
  Effect.provide(FetchHttpClient.layer),
  Effect.mapError((error) =>
    error instanceof StepFailed
      ? error
      : new StepFailed({ step: "http.post", message: String(error) }),
  ),
);

export const runAction = Effect.fn("Connections.runAction")(function* (
  step: ActionStep,
  inputs: Inputs,
  state: ExecutionValues,
  idempotencyKey: string,
) {
  const simulatedId = `sim_${idempotencyKey.slice(0, 16)}`;
  switch (step.use) {
    case "events.emit": {
      return yield* Effect.gen(function* () {
        const events = yield* Events;
        const source = step.with["data"];
        const isReference = typeof source === "string" && loneRef(source) !== undefined;
        const data =
          typeof inputs["data"] === "string" && !isReference
            ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(inputs["data"])
            : inputs["data"];
        const name = text(inputs, "name");
        const depth = state.event === undefined ? 0 : state.event.depth + 1;
        if (depth > MAX_EVENT_DEPTH || (depth === MAX_EVENT_DEPTH && name === "entity.put")) {
          return yield* Effect.fail(
            `Event chain limit reached: this run is ${depth - 1} events deep, and chains stop at ${MAX_EVENT_DEPTH}`,
          );
        }
        const event = yield* Schema.decodeUnknownEffect(PublishEvent)({
          id: `action:${idempotencyKey}`,
          name,
          data,
          ...(state.subject === null ? {} : { subject: state.subject }),
          depth,
        });
        if (event.name === "entity.put") yield* Schema.decodeUnknownEffect(EntityPut)(event.data);
        yield* events.publish(event);
        return recorded({ eventId: event.id, name: event.name });
      }).pipe(Effect.mapError((error) => fail(step, String(error))));
    }
    case "email.send": {
      const to = yield* recipient(step, "to", inputs["to"]);
      const message = {
        to: to.email,
        subject: text(inputs, "subject"),
        body: text(inputs, "body"),
      };
      const email = yield* EmailSender;
      if (email !== null) {
        const sent = yield* email
          .send(message, idempotencyKey)
          .pipe(Effect.mapError((error) => fail(step, error.message)));
        return recorded({ messageId: sent.messageId, ...message });
      }
      return recorded({ simulated: true, messageId: simulatedId, ...message });
    }
    case "slack.sendMessage": {
      const to = text(inputs, "to");
      const person = to.startsWith("#") ? undefined : yield* recipient(step, "to", inputs["to"]);
      const slack = yield* SlackSender;
      if (slack !== null) {
        const sent = yield* slack
          .send(
            person === undefined
              ? { kind: "channel", name: to }
              : { kind: "person", email: person.email },
            text(inputs, "text"),
          )
          .pipe(Effect.mapError((error) => fail(step, error.message)));
        return recorded({ channel: sent.channel, ts: sent.ts, text: text(inputs, "text") });
      }
      const channel = person === undefined ? to : `@${person.email}`;
      const sentAt = yield* Clock.currentTimeMillis;
      return recorded({
        simulated: true,
        channel,
        ts: String(sentAt / 1000),
        text: text(inputs, "text"),
      });
    }
    case "calendar.findTimes": {
      const attendees = yield* recipients(step, "attendees", inputs["attendees"]);
      const after = yield* dateInput(step, inputs, "after");
      const duration = yield* durationInput(step, inputs, "duration");
      return recorded({
        simulated: true,
        attendees: attendees.map((person) => person.email),
        duration,
        times: openTimes(after),
      });
    }
    case "calendar.createEvent": {
      const attendees = yield* recipients(step, "attendees", inputs["attendees"]);
      const start = yield* dateInput(step, inputs, "start");
      const duration = yield* durationInput(step, inputs, "duration");
      return recorded({
        simulated: true,
        eventId: simulatedId,
        title: text(inputs, "title"),
        attendees: attendees.map((person) => person.email),
        start: new Date(start).toISOString(),
        end: new Date(start + durationMillis(duration)).toISOString(),
        repeat: text(inputs, "repeat") || null,
      });
    }
    case "http.post": {
      const body = inputs["body"] ?? { subject: state.subject, steps: state.steps };
      return recorded(
        yield* postJson(step, text(inputs, "url"), body, idempotencyKey).pipe(
          Effect.mapError((error) => new StepFailed({ step: step.id, message: error.message })),
        ),
      );
    }
    default:
      return yield* fail(step, `Unknown operation ${step.use}`);
  }
});
