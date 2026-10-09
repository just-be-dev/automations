/** Fans messages out to automations and routes entity commands through the shared writer. */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { AutomationIndex } from "../automation/index.ts";
import { Automations } from "../automation/service.ts";
import { EntityPut, Event } from "./model.ts";
import { EventError } from "./service.ts";

export const deliverEvent = Effect.fn("Events.deliver")(function* (
  input: unknown,
  putEntity: (event: Event, command: typeof EntityPut.Type) => Effect.Effect<void, unknown>,
) {
  const event = yield* Schema.decodeUnknownEffect(Event)(input);
  if (event.name === "entity.put") {
    if (event.depth === 16) return yield* new EventError({ message: "Event chain limit reached" });
    const command = yield* Schema.decodeUnknownEffect(EntityPut)(event.data);
    yield* putEntity(event, command);
  }
  const index = yield* AutomationIndex;
  const automations = yield* Automations;
  // A failure must retry the message, not acknowledge an incomplete fan-out. Successful
  // recipients persist receipts, so delivering to them again cannot start another run.
  const outcomes = yield* Effect.forEach(yield* index.list, (item) =>
    automations.get(item.id).eventReceived(event).pipe(Effect.exit),
  );
  for (const outcome of outcomes) {
    if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
  }
});
