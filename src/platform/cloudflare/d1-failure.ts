/** Turns D1 failures, which its executors report as defects, into a caller's typed error. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { messageOf } from "../../error.ts";

/** The failure's own message, without the Cause wrapper. */
const causeMessage = <E>(cause: Cause.Cause<E>) => {
  const squashed = Cause.squash(cause);
  return messageOf(squashed, String(squashed));
};

/**
 * Maps a failure or defect to `make`'s typed error, prefixed with the operation. An interruption
 * stays an interruption, so a caller that ignores the typed error never swallows a cancelled fiber.
 */
export const failWith =
  <E>(operation: string, make: (message: string) => E) =>
  <A, E0, R>(effect: Effect.Effect<A, E0, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.fail(make(`${operation}: ${causeMessage(cause)}`)),
      ),
    );
