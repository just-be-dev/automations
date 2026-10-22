/** Checks that entity-store's RPC results are decoded, and its failures kept apart. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { makeEntityStoreApi, type EntityStoreRpc } from "./entity-store-api.ts";
import { makeFakeEntityStore } from "./entity-store-fake.ts";

const answering = (answer: () => Promise<unknown>): EntityStoreRpc => ({
  ...makeFakeEntityStore(),
  getEntity: answer,
});

const failure = (rpc: EntityStoreRpc) =>
  Effect.runPromise(makeEntityStoreApi(rpc).getEntity("ada").pipe(Effect.flip));

test("a domain error keeps its code and details; anything else is unavailable or invalid", async () => {
  expect(
    await failure(
      answering(() =>
        Promise.resolve({
          ok: false,
          error: { code: "EntityDeleted", message: "ada was deleted", rev: 3 },
        }),
      ),
    ),
  ).toMatchObject({ code: "EntityDeleted", message: "ada was deleted", details: { rev: 3 } });
  expect(await failure(answering(() => Promise.reject(new Error("socket closed"))))).toMatchObject({
    code: "Unavailable",
    message: "entity-store getEntity failed: socket closed",
  });
  expect(await failure(answering(() => Promise.resolve({ ok: true })))).toMatchObject({
    code: "InvalidResponse",
  });
  expect(
    await failure(answering(() => Promise.resolve({ ok: true, value: { id: "ada" } }))),
  ).toMatchObject({ code: "InvalidResponse" });
});

test("a value is decoded into the contract's shapes", async () => {
  const fake = makeFakeEntityStore();
  fake.seedType("employee", "Employees", { fields: { name: { type: "string" } } });
  fake.seedEntity("employee", "ada", { name: "Ada" });
  const api = makeEntityStoreApi(fake);
  const entity = await Effect.runPromise(api.getEntity("ada"));
  expect(entity).toMatchObject({ id: "ada", type: "employee", rev: 1, data: { name: "Ada" } });
  const change = await Effect.runPromise(api.getChange("ada", 1));
  expect(change).toMatchObject({ v: 1, op: "create", before: null, after: { name: "Ada" } });
});
