/** The queue that carries Approve and Reject clicks from the public Channels Worker to the private Api. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  SlackTaskAction,
  SlackTaskActionError,
  SlackTaskActions,
} from "../../channels/slack-approvals.ts";
import { messageOf } from "../../error.ts";

/**
 * A queue rather than a call: Channels can't reach the Automation objects, which the Api hosts,
 * and Slack wants its answer within 3 seconds. The Api consumes it and retries a click whose
 * decision or message update failed, which deciding makes safe to repeat.
 */
export const SlackActionQueue = Cloudflare.Queues.Queue("SlackActions");

/** Bind the queue outside; capture the request's runtime inside the returned layer. */
export const SlackActionsQueue = Effect.gen(function* () {
  const queue = yield* Cloudflare.Queues.WriteQueue(yield* SlackActionQueue);
  return Layer.effect(
    SlackTaskActions,
    Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      return SlackTaskActions.of({
        send: Effect.fn("SlackTaskActions.send")(
          function* (action: SlackTaskAction) {
            const encoded = yield* Schema.encodeEffect(SlackTaskAction)(action);
            yield* queue.send(encoded).pipe(Effect.provideService(Alchemy.RuntimeContext, runtime));
          },
          Effect.mapError((error) => new SlackTaskActionError({ message: messageOf(error) })),
        ),
      });
    }),
  );
});
