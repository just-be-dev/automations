import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { AutomationIndex } from "../automation/index.ts";
import { Automations } from "../automation/service.ts";
import { deliverEvent } from "./delivery.ts";

test("fan-out attempts every automation before retrying; entity commands decode before writing and respect the chain limit", async () => {
  const received: Array<string> = [];
  const commands: Array<unknown> = [];
  const unused = () => Effect.die("Unexpected operation");
  const layer = Layer.mergeAll(
    Layer.succeed(AutomationIndex, {
      list: Effect.succeed(["broken", "healthy"].map((id) => ({ id, name: id, updatedAt: 0 }))),
      create: unused,
      record: unused,
      recordIfMissing: unused,
      remove: unused,
    }),
    Layer.succeed(Automations, {
      get: (id) => ({
        inspectWorkflow: unused,
        overview: unused,
        templateUses: unused,
        chat: unused,
        answer: unused,
        save: unused,
        setPermissions: unused,
        setDraft: unused,
        remove: unused,
        start: unused,
        entityChanged: unused,
        respond: unused,
        resumeNow: unused,
        run: unused,
        plannerTrace: unused,
        runTrace: unused,
        eventReceived: (event) =>
          Effect.gen(function* () {
            received.push(id);
            if (id === "broken") return yield* Effect.die("offline");
            expect(event).toMatchObject({ name: "entity.put" });
            return { runId: null };
          }),
      }),
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const event = {
        id: "command-81",
        name: "entity.put",
        data: { type: "person", id: "sam", data: { name: "Sam" } },
        depth: 15,
      };
      const put = (_event: unknown, command: unknown) =>
        Effect.sync(() => void commands.push(command));
      const result = yield* deliverEvent(event, put).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(received).toEqual(["broken", "healthy"]);
      expect(commands).toEqual([event.data]);
      // Commands that can never apply are dropped and acknowledged, not retried.
      yield* deliverEvent({ ...event, depth: 16 }, put);
      yield* deliverEvent({ ...event, data: { type: "person", id: "sam", data: [] } }, put);
      expect(commands).toHaveLength(1);
      expect(received).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );
});
