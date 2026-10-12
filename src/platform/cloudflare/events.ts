/** Queue resources and the request/instance-bound event publisher. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Event } from "../../events/model.ts";
import { EventError, Events } from "../../events/service.ts";
import { messageOf } from "../../error.ts";

export const EventQueue = Cloudflare.Queues.Queue("Events");
export const failedEventQueueName = Effect.map(
  Alchemy.Stage,
  (stage) => `automations-${stage}-failed-events`,
);
export const FailedEventQueue = Cloudflare.Queues.Queue(
  "FailedEvents",
  Effect.map(failedEventQueueName, (name) => ({ name })),
);

export const EventsQueue = Effect.gen(function* () {
  const queue = yield* Cloudflare.Queues.WriteQueue(yield* EventQueue);
  return Layer.effect(
    Events,
    Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      return Events.of({
        publish: Effect.fn("Events.publish")(
          function* (event: Event) {
            const decoded = yield* Schema.decodeEffect(Event)(event);
            yield* queue.send(decoded).pipe(Effect.provideService(Alchemy.RuntimeContext, runtime));
          },
          Effect.mapError((error) => new EventError({ message: messageOf(error) })),
        ),
      });
    }),
  );
});
