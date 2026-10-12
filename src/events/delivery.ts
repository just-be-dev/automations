/** Fans messages out to automations and routes entity commands through the shared writer. */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { AutomationIndex } from "../automation/index.ts";
import { Automations } from "../automation/service.ts";
import { EntityPut, Event, MAX_EVENT_DEPTH } from "./model.ts";

export const deliverEvent = Effect.fn("Events.deliver")(function* (
  input: unknown,
  putEntity: (event: Event, command: typeof EntityPut.Type) => Effect.Effect<void, unknown>,
) {
  const event = yield* Schema.decodeUnknownEffect(Event)(input);
  if (event.name === "entity.put") {
    // A command that can never apply is dropped, not retried until it reaches the dead letters.
    // Publishers refuse both cases, so this only guards against a stray message.
    const command = Schema.decodeUnknownOption(EntityPut)(event.data);
    if (event.depth >= MAX_EVENT_DEPTH || command._tag === "None") {
      return yield* Effect.logWarning(
        event.depth >= MAX_EVENT_DEPTH
          ? "Dropped an entity command past the event chain limit"
          : "Dropped an entity command whose data isn't an entity",
      ).pipe(Effect.annotateLogs({ eventId: event.id, depth: event.depth }));
    }
    yield* putEntity(event, command.value);
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
