/** Authenticated event ingress; callers keep the same ID when retrying a publication. */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Schema from "effect/Schema";
import { EntityPut, PublishEvent } from "../events/model.ts";
import { Events, EventError } from "../events/service.ts";
import { limitedBody, respond } from "./response.ts";

export const eventRoutes = HttpRouter.add(
  "POST",
  "/api/events",
  respond(
    Effect.gen(function* () {
      const input = yield* limitedBody(
        Schema.Struct({
          id: PublishEvent.fields.id,
          name: PublishEvent.fields.name,
          data: PublishEvent.fields.data,
          subject: PublishEvent.fields.subject,
        }),
      );
      if (input.name === "entity.put") yield* Schema.decodeUnknownEffect(EntityPut)(input.data);
      const event = { ...input, depth: 0 };
      if (JSON.stringify(event).length > 30_000) {
        return yield* new EventError({ message: "Event payload is too large" });
      }
      const events = yield* Events;
      yield* events.publish(event);
      return { eventId: event.id, status: "accepted" };
    }),
    202,
  ),
);
