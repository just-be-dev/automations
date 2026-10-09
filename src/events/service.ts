/** Durable acceptance; delivery is asynchronous and at least once. */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Event } from "./model.ts";

export class EventError extends Schema.TaggedError<EventError>()("EventError", {
  message: Schema.String,
}) {}

export class Events extends Context.Service<
  Events,
  { readonly publish: (event: Event) => Effect.Effect<void, EventError> }
>()("automations/Events") {}
