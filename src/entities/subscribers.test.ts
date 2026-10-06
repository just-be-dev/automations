/** Checks that entity changes notify only matching automations and retain each subscriber's failure. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EntityStore, layerMemory, type EntityChange } from "./store.ts";
import { EntitySubscribers } from "./subscribers.ts";

test("notifies only this type's subscribers and retains failures alongside later successes", async () => {
  const change: EntityChange = {
    before: { name: "Ada" },
    after: { type: "employee", id: "ada", data: { name: "Ada Lovelace" } },
  };
  const called: Array<{ id: string; change: EntityChange }> = [];
  const subscribers = EntitySubscribers.layer((id, received) => {
    called.push({ id, change: received });
    return id === "broken"
      ? Effect.fail({ message: "Saved workflow no longer fits" })
      : Effect.succeed({ runId: id === "no-match" ? null : "run-welcome" });
  }).pipe(Layer.provideMerge(layerMemory({})));

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.subscribe("broken", "employee");
      yield* store.subscribe("unrelated", "invoice");
      yield* store.subscribe("no-match", "employee");
      yield* store.subscribe("welcome", "employee");
      const notifications = yield* EntitySubscribers;
      return yield* notifications.notify(change);
    }).pipe(Effect.provide(subscribers)),
  );

  expect(called).toEqual([
    { id: "broken", change },
    { id: "no-match", change },
    { id: "welcome", change },
  ]);
  expect(result).toEqual([
    { automation: "broken", runId: null, error: "Saved workflow no longer fits" },
    { automation: "no-match", runId: null, error: null },
    { automation: "welcome", runId: "run-welcome", error: null },
  ]);
});
