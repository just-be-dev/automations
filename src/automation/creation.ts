/** Names and lists a new automation, then submits its description as the first design message. */
import * as Effect from "effect/Effect";
import { nameAutomation } from "../agents/namer/namer.ts";
import { listNewAutomation } from "./index.ts";
import { AutomationError, type PendingChat } from "./model.ts";
import { Automations } from "./service.ts";

const maxDescriptionLength = 10_000;

/**
 * Creates an automation from a description of what it should do: a fast model names it, the
 * directory lists it under an ID from that name, and the description becomes the first chat
 * message. The automation stays listed if that message can't be sent; the caller gets no
 * `pendingChat` and can send the description again.
 */
export const createAutomation = Effect.fn("Automation.create")(function* (description: string) {
  if (!description.trim() || description.length > maxDescriptionLength) {
    return yield* new AutomationError({
      message: "Describe the automation in 1–10,000 characters",
    });
  }
  const name = yield* nameAutomation(description);
  const id = yield* listNewAutomation(name);
  const automations = yield* Automations;
  const maybePendingChat = yield* automations
    .get(id)
    .chat(id, description)
    .pipe(
      Effect.map(({ pendingChat }): PendingChat | undefined => pendingChat),
      Effect.catchCause((cause) =>
        Effect.logWarning("Couldn't send the first chat message", cause).pipe(Effect.as(undefined)),
      ),
    );
  return {
    id,
    name,
    ...(maybePendingChat === undefined ? {} : { pendingChat: maybePendingChat }),
  };
});
