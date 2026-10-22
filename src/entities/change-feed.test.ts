/** Checks that entity-store's change messages become lifecycle events and entity notifications. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type { Event } from "../events/model.ts";
import { EventError, Events } from "../events/service.ts";
import { deliverEntityChange } from "./change-feed.ts";
import { layerFake, seededEntityStore } from "./memory.ts";
import type { EntityType } from "./model.ts";
import { EntityStore, type EntityChange } from "./store.ts";
import { EntitySubscribers } from "./subscribers.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "text" },
  ],
};

const harness = (options: { failing?: ReadonlyArray<string>; publishFails?: boolean } = {}) => {
  const store = seededEntityStore({ types: [employee] });
  const published: Array<Event> = [];
  const notified: Array<{ automation: string; change: EntityChange; key?: string; event?: Event }> =
    [];
  const entities = layerFake(store);
  const layer = Layer.mergeAll(
    EntitySubscribers.layer((automation, change, key, event) =>
      Effect.suspend(() => {
        notified.push({
          automation,
          change,
          ...(key === undefined ? {} : { key }),
          ...(event === undefined ? {} : { event }),
        });
        return options.failing?.includes(automation)
          ? Effect.fail({ message: "offline" })
          : Effect.succeed({ runId: `entity-${key}` });
      }),
    ),
    Layer.succeed(Events, {
      publish: (event) =>
        options.publishFails
          ? Effect.fail(new EventError({ message: "Queue unavailable" }))
          : Effect.sync(() => void published.push(event)),
    }),
  ).pipe(Layer.provideMerge(entities));
  const latest = () => store.changes().at(-1);
  return { store, published, notified, layer, latest };
};

test("each write becomes its lifecycle event and reaches the type's watchers under one key", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const entities = yield* EntityStore;
      yield* entities.subscribe("onboarding", "employee");
      yield* entities.putEntity("employee", "ada", { name: "Ada" });
      const created = h.latest();
      yield* deliverEntityChange(created);
      // The queue delivers at least once.
      yield* deliverEntityChange(created);
      yield* entities.putEntity("employee", "ada", { email: "ada@example.com" });
      yield* deliverEntityChange(h.latest());
      yield* entities.deleteEntity("employee", "ada");
      yield* deliverEntityChange(h.latest());
    }).pipe(Effect.provide(h.layer)),
  );
  const ada = (data: Record<string, string>) => ({ type: "employee", id: "ada", data });
  expect(h.published).toEqual([
    {
      id: "entity-store:1",
      name: "entity.created",
      data: { before: null, after: { name: "Ada" } },
      subject: ada({ name: "Ada" }),
      depth: 0,
    },
    {
      id: "entity-store:1",
      name: "entity.created",
      data: { before: null, after: { name: "Ada" } },
      subject: ada({ name: "Ada" }),
      depth: 0,
    },
    {
      id: "entity-store:2",
      name: "entity.updated",
      data: { before: { name: "Ada" }, after: { name: "Ada", email: "ada@example.com" } },
      subject: ada({ name: "Ada", email: "ada@example.com" }),
      depth: 0,
    },
    {
      id: "entity-store:3",
      name: "entity.deleted",
      data: { before: { name: "Ada", email: "ada@example.com" }, after: null },
      subject: ada({ name: "Ada", email: "ada@example.com" }),
      depth: 0,
    },
  ]);
  // A delete reaches event listeners only; a write outside a chain carries no origin event.
  expect(h.notified).toEqual([
    {
      automation: "onboarding",
      change: { before: undefined, after: ada({ name: "Ada" }), committedAt: expect.any(Number) },
      key: "entity-store:1",
    },
    {
      automation: "onboarding",
      change: { before: undefined, after: ada({ name: "Ada" }), committedAt: expect.any(Number) },
      key: "entity-store:1",
    },
    {
      automation: "onboarding",
      change: {
        before: { name: "Ada" },
        after: ada({ name: "Ada", email: "ada@example.com" }),
        committedAt: expect.any(Number),
      },
      key: "entity-store:2",
    },
  ]);
});

test("a write's depth comes from its meta, and a chain's runs get the lifecycle event as their origin", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const entities = yield* EntityStore;
      yield* entities.subscribe("echo", "employee");
      const write = (name: string, meta: Record<string, unknown>) =>
        Effect.gen(function* () {
          yield* entities.putEntity("employee", "ada", { name }, { meta: meta as never });
          yield* deliverEntityChange(h.latest());
        });
      yield* write("Deep", { depth: 16, sourceEventId: "command-15", changeId: "change-1" });
      // A depth automations never writes is taken as the limit, so the chain stops.
      yield* write("Forged", { depth: 99 });
      yield* write("Odd", { depth: "two" });
    }).pipe(Effect.provide(h.layer)),
  );
  expect(h.published.map((event) => event.depth)).toEqual([16, 16, 16]);
  expect(h.notified[0]?.event).toEqual(h.published[0]);
  expect(h.notified[0]?.event?.depth).toBe(16);
});

test("types automations can't use publish nothing", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const entities = yield* EntityStore;
      yield* entities.subscribe("watcher", "employee");
      h.store.seedType("Office-Space", "", { fields: { name: { type: "string" } } });
      yield* Effect.promise(() =>
        h.store.upsertEntity("Office-Space", "hq", { patch: { name: "HQ" } }),
      );
      yield* deliverEntityChange(h.latest());
    }).pipe(Effect.provide(h.layer)),
  );
  expect(h.published).toEqual([]);
  expect(h.notified).toEqual([]);
});

test("a message that can never be delivered is dropped; a failure to deliver retries it", async () => {
  const run = (
    h: ReturnType<typeof harness>,
    message: (h: ReturnType<typeof harness>) => unknown,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.subscribe("broken", "employee");
        yield* entities.subscribe("healthy", "employee");
        yield* entities.putEntity("employee", "ada", { name: "Ada" });
        return yield* deliverEntityChange(message(h)).pipe(Effect.exit);
      }).pipe(Effect.provide(h.layer)),
    );
  const dropped = harness();
  expect(Exit.isSuccess(await run(dropped, () => ({ not: "a change" })))).toBe(true);
  expect(Exit.isSuccess(await run(dropped, (h) => ({ ...h.latest(), id: "gone", rev: 1 })))).toBe(
    true,
  );
  expect(dropped.published).toEqual([]);

  const failing = harness({ failing: ["broken"] });
  expect(Exit.isFailure(await run(failing, (h) => h.latest()))).toBe(true);
  // Every watcher was still tried before the retry.
  expect(failing.notified.map((each) => each.automation)).toEqual(["broken", "healthy"]);

  const unpublished = harness({ publishFails: true });
  expect(Exit.isFailure(await run(unpublished, (h) => h.latest()))).toBe(true);
  expect(unpublished.notified).toEqual([]);

  const unreachable = harness();
  unreachable.store.failing("getChange", "throw");
  expect(Exit.isFailure(await run(unreachable, (h) => h.latest()))).toBe(true);
});

test("an ID that comes back after its type was deleted gets new keys; a stale message is dropped", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const entities = yield* EntityStore;
      yield* entities.subscribe("watcher", "employee");
      yield* entities.putEntity("employee", "ada", { name: "Ada" });
      const first = h.latest();
      yield* deliverEntityChange(first);
      yield* entities.deleteEntity("employee", "ada");
      yield* entities.subscribe("watcher", undefined);
      yield* entities.deleteType("employee");
      yield* entities.putType(employee);
      yield* entities.subscribe("watcher", "employee");
      yield* entities.putEntity("employee", "ada", { name: "Ada again" });
      const again = h.latest();
      expect(again).toMatchObject({ id: "ada", rev: 1 });
      // The first change is gone; its late redelivery names a revision another change now has.
      yield* deliverEntityChange(first);
      yield* deliverEntityChange(again);
    }).pipe(Effect.provide(h.layer)),
  );
  expect(h.published.map((event) => [event.id, event.subject?.data])).toEqual([
    ["entity-store:1", { name: "Ada" }],
    ["entity-store:3", { name: "Ada again" }],
  ]);
  expect(h.notified.map((each) => each.key)).toEqual(["entity-store:1", "entity-store:3"]);
});

test("a change entity-store can't present at its type's latest version is dropped", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const entities = yield* EntityStore;
      yield* entities.putEntity("employee", "ada", { name: "Ada" });
      h.store.failing("getChange", { code: "ProjectionFailed", message: "Couldn't present it" });
      yield* deliverEntityChange(h.latest());
    }).pipe(Effect.provide(h.layer)),
  );
  expect(h.published).toEqual([]);
});
