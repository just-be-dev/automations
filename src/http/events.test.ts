import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import type { Event } from "../events/model.ts";
import { EventError, Events } from "../events/service.ts";
import { eventRoutes } from "./events.ts";

test("event ingress accepts stable IDs, rejects malformed commands and lifecycle spoofing, and reports queue failure", async () => {
  const emitted: Array<Event> = [];
  let unavailable = false;
  const { handler, dispose } = HttpRouter.toWebHandler(
    eventRoutes.pipe(
      Layer.provideMerge(
        Layer.succeed(Events, {
          publish: (event) =>
            unavailable
              ? Effect.fail(new EventError({ message: "Queue unavailable" }))
              : Effect.sync(() => void emitted.push(event)),
        }),
      ),
    ),
    { disableLogger: true },
  );
  const publish = (body: unknown, headers?: Record<string, string>) =>
    handler(
      new Request("http://studio/api/events", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  try {
    const input = { id: "order-81", name: "order.paid", data: { total: 137 }, depth: 16 };
    const accepted = await publish(input);
    expect(accepted.status).toBe(202);
    expect((await accepted.json()) as unknown).toEqual({ eventId: "order-81", status: "accepted" });
    expect(emitted).toEqual([
      { id: "order-81", name: "order.paid", data: { total: 137 }, depth: 0 },
    ]);
    for (const name of ["entity.created", "entity.updated", "entity.deleted", "bad name"]) {
      expect((await publish({ ...input, name })).status).toBe(400);
    }
    expect((await publish({ ...input, id: "" })).status).toBe(400);
    expect(
      (
        await publish({
          ...input,
          name: "entity.put",
          data: { type: "person", id: "sam", data: [] },
        })
      ).status,
    ).toBe(400);
    expect((await publish(input, { "content-length": "33000" })).status).toBe(413);
    expect(emitted).toHaveLength(1);
    unavailable = true;
    const failure = await publish(input);
    expect(failure.status).toBe(400);
    expect((await failure.json()) as unknown).toEqual({ error: "Queue unavailable" });
  } finally {
    await dispose();
  }
});
