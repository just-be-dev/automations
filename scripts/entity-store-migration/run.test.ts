/** Checks the migration against an in-memory entity-store behind its HTTP routes. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeFakeEntityStore, type FakeEntityStore } from "../../src/entities/entity-store-fake.ts";
import type { EntityType } from "../../src/entities/model.ts";
import type { Source } from "./plan.ts";
import { migrate, Refusal, type Answer, type Target } from "./run.ts";

const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "text" },
  ],
};

const source: Source = {
  types: [employee],
  entities: [
    { type: "employee", id: "grace", data: { name: "Grace", email: "grace@example.com" } },
    { type: "employee", id: "ada", data: { name: "Ada" } },
  ],
  roles: [
    { name: "people_ops", label: "People Ops", members: [{ type: "employee", id: "grace" }] },
  ],
};

type Result = {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { code: string; message: string };
};

/** The routes `run.ts` calls, answered by `store` as entity-store's HTTP API would. */
const targetOver = (store: FakeEntityStore): { target: Target; writes: Array<string> } => {
  const writes: Array<string> = [];
  const route = async (method: string, path: string, body: unknown): Promise<Result> => {
    const url = new URL(path, "https://entity-store.test");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const input = body as never;
    if (method !== "GET" && !path.endsWith("/check")) writes.push(`${method} ${path}`);
    if (method === "GET" && parts.length === 2) {
      const listed = (await store.listTypes()) as Result;
      return listed.ok ? { ok: true, value: { items: listed.value } } : listed;
    }
    if (method === "GET" && parts[1] === "types")
      return (await store.getType(parts[2] ?? "")) as Result;
    if (method === "GET" && parts[1] === "entities") {
      const rev = url.searchParams.get("rev");
      return (await store.getEntity(
        parts[2] ?? "",
        rev === null ? undefined : { rev: Number(rev) },
      )) as Result;
    }
    if (method === "POST" && parts.length === 2) return (await store.createType(input)) as Result;
    if (method === "POST" && parts[3] === "versions")
      return (await store.createVersion(parts[2] ?? "", input)) as Result;
    if (method === "POST" && parts[5] === "check")
      return (await store.checkEntity(parts[2] ?? "", parts[4] ?? "", input)) as Result;
    if (method === "PUT")
      return (await store.upsertEntity(parts[2] ?? "", parts[4] ?? "", input)) as Result;
    throw new Error(`No route ${method} ${path}`);
  };
  const target: Target = {
    attempt: <A>(method: string, path: string, schema: Schema.Codec<A, unknown>, body?: unknown) =>
      Effect.promise(() => route(method, path, structuredClone(body))).pipe(
        Effect.map((answer): Answer<A> =>
          answer.ok
            ? { value: Schema.decodeUnknownSync(schema)(answer.value), refused: undefined }
            : {
                value: undefined,
                refused: Schema.decodeUnknownSync(Refusal)({
                  ...answer.error,
                  error: answer.error?.message,
                }),
              },
        ),
      ),
  };
  return { target, writes };
};

/** An entity-store that already holds `ada`, as another type. */
const withClash = (deleted: boolean) => {
  const store = makeFakeEntityStore();
  store.seedType("contractor", "Contractors", { fields: { name: { type: "string" } } });
  store.seedEntity("contractor", "ada", { name: "Ada C" });
  if (deleted) void store.deleteEntity("ada");
  return store;
};

test("an ID another type holds is a clash: the dry run lists it, and apply refuses before writing anything", async () => {
  for (const deleted of [false, true]) {
    const store = withClash(deleted);
    const before = store.changes().length;
    const { target, writes } = targetOver(store);
    const dry = await Effect.runPromise(Effect.flip(migrate(target, source, false)));
    expect(dry.message).toContain("ID clash: employee ada: entity-store");
    expect(dry.message).toContain("contractor ada");
    const applied = await Effect.runPromise(Effect.flip(migrate(target, source, true)));
    expect(applied.message).toContain("ID clash: employee ada");
    expect(writes).toEqual([]);
    expect(store.changes()).toHaveLength(before);
    expect(((await store.getType("employee")) as Result).ok).toBe(false);
  }
});

test("an ID the same type already holds is left as it is, and doesn't stop the copy", async () => {
  const store = makeFakeEntityStore();
  const { target, writes } = targetOver(store);
  await Effect.runPromise(migrate(target, source, true));
  await store.upsertEntity("employee", "ada", { patch: { name: "Ada Lovelace" } });
  const firstWrites = writes.length;
  const again = await Effect.runPromise(migrate(target, source, true));
  expect(again).toEqual({ created: [], skipped: [] });
  expect(writes).toHaveLength(firstWrites);
  expect(await store.getEntity("ada")).toMatchObject({ value: { data: { name: "Ada Lovelace" } } });
});
