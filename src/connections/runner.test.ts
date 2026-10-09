import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { Event } from "../events/model.ts";
import { Events } from "../events/service.ts";
import { RunId } from "../workflow/run.ts";
import type { ActionStep } from "../workflow/model.ts";
import { runAction } from "./runner.ts";

test("emit uses a stable ID across retries, decodes JSON and refuses invalid entity commands and reserved facts", async () => {
  const emitted: Array<Event> = [];
  const step: ActionStep = {
    id: "emit",
    title: "Emit",
    kind: "action",
    use: "events.emit",
    with: { name: "order.paid", data: '{"total":137}' },
  };
  const state = { runId: RunId.make("run-81"), subject: null, steps: {} };
  await Effect.runPromise(
    Effect.gen(function* () {
      const inputs = { name: "order.paid", data: '{"total":137}' };
      const first = yield* runAction(step, inputs, state, "stable-key");
      expect(yield* runAction(step, inputs, state, "stable-key")).toEqual(first);
      expect(emitted).toEqual([
        { id: "action:stable-key", name: "order.paid", data: { total: 137 }, depth: 0 },
        { id: "action:stable-key", name: "order.paid", data: { total: 137 }, depth: 0 },
      ]);
      for (const name of ["entity.created", "entity.updated", "entity.deleted", "entity.put"]) {
        yield* runAction(step, { name, data: "{}" }, state, name).pipe(Effect.flip);
      }
      yield* runAction(step, { name: "valid", data: "not JSON" }, state, "bad-data").pipe(
        Effect.flip,
      );
      expect(emitted).toHaveLength(2);
    }).pipe(
      Effect.provideService(Events, {
        publish: (event) => Effect.sync(() => void emitted.push(event)),
      }),
    ),
  );
});
