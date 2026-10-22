import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { AutomationIndex } from "../automation/index.ts";
import { Automations } from "../automation/service.ts";
import { EntityStore } from "../entities/store.ts";
import { layerFake, seededEntityStore } from "../entities/memory.ts";
import type { EntityType } from "../entities/model.ts";
import { makeChanges } from "./application.ts";
import type { ChangeStorage } from "./host.ts";
import type { Event } from "../events/model.ts";

const person: EntityType = {
  name: "person",
  label: "Person",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "text" },
  ],
};
const template = {
  name: "welcome",
  label: "Welcome",
  description: "Welcome wording",
  slots: [],
  content: { body: "Hello" },
};
const action = {
  kind: "putEntity",
  type: "person",
  id: "ada",
  data: { name: "Ada Lovelace" },
} as const;

const harness = () => {
  const data = new Map<string, Schema.Json>();
  let failReceipt = false;
  let failApplying = false;
  const storage: ChangeStorage = {
    get: (key) => Effect.sync(() => structuredClone(data.get(key))),
    put: (key, value) =>
      Effect.suspend(() => {
        if (
          Schema.is(Schema.Struct({ state: Schema.String }))(value) &&
          ((value.state === "terminal" && failReceipt) ||
            (value.state === "applying" && failApplying))
        )
          return Effect.fail("storage unavailable");
        return Effect.sync(() => void data.set(key, structuredClone(value)));
      }),
    list: (prefix) =>
      Effect.sync(() =>
        [...data]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, value]) => structuredClone(value)),
      ),
    transaction: (effect) => effect,
  };
  const usages = { saved: ["welcome"], draft: ["welcome"] };
  const unused = () => Effect.die("Unexpected automation operation");
  const store = seededEntityStore({
    types: [person],
    entities: [{ type: "person", id: "ada", data: { name: "Ada", email: "ada@example.com" } }],
  });
  const layer = Layer.mergeAll(
    layerFake(store, [template]),
    Layer.succeed(AutomationIndex, {
      list: Effect.succeed([
        { id: "a", name: "A", updatedAt: 0 },
        { id: "broken", name: "Broken", updatedAt: 0 },
      ]),
      create: () => Effect.succeed(true),
      record: () => Effect.void,
      recordIfMissing: () => Effect.void,
      remove: () => Effect.void,
    }),
    Layer.succeed(Automations, {
      get: (id) => ({
        templateUses: () => (id === "broken" ? Effect.fail("unreachable") : Effect.succeed(usages)),
        overview: () => Effect.succeed({ activeRuns: [] }),
        inspectWorkflow: unused,
        answer: unused,
        stopChat: unused,
        chat: unused,
        save: unused,
        setPermissions: unused,
        setDraft: unused,
        remove: unused,
        start: unused,
        entityChanged: unused,
        eventReceived: unused,
        plannerTrace: unused,
        runTrace: unused,
        run: unused,
        respond: unused,
        resumeNow: unused,
      }),
    }),
  );
  /** The writes automations made to `id`: the ones with `meta`. */
  const writes = (id: string) =>
    store.changes().filter((change) => change.id === id && change.meta !== null);
  return {
    storage,
    layer,
    data,
    store,
    usages,
    writes,
    receiptFailure: (value: boolean) => {
      failReceipt = value;
    },
    applyingFailure: (value: boolean) => {
      failApplying = value;
    },
  };
};

const nameOf = (id = "ada") =>
  Effect.gen(function* () {
    return (yield* (yield* EntityStore).getEntity("person", id))?.data["name"];
  });

test("prepare checks without writing, shows merged fields, and isolates cancellation and replay by owner", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const proposal = yield* changes.prepare("owner", action, "call-1");
      expect(proposal.details).toEqual([{ label: "name", before: "Ada", after: "Ada Lovelace" }]);
      expect(proposal.consequences.join(" ")).toContain("may start");
      // Only template changes ask every automation how it uses templates.
      expect(proposal.consequences.join(" ")).not.toContain("impact could not be checked");
      expect(yield* nameOf()).toBe("Ada");
      expect(yield* changes.prepare("owner", action, "call-1")).toEqual(proposal);
      expect(
        (yield* changes.decide("other", proposal.id, true).pipe(Effect.flip)) as object,
      ).toMatchObject({ message: "Proposal not found" });
      expect(yield* changes.decide("owner", proposal.id, false)).toEqual({
        status: "cancelled",
        result: null,
      });
      expect(yield* changes.decide("owner", proposal.id, true)).toEqual({
        status: "cancelled",
        result: null,
      });
      expect(h.writes("ada")).toEqual([]);
      yield* changes.prepare("owner", { ...action, data: { name: 1 } }).pipe(Effect.flip);
    }).pipe(Effect.provide(h.layer)),
  );
});

test("a stale confirmation fails instead of overwriting", async () => {
  for (const dependency of ["record", "type", "subscription", "template", "uses"]) {
    const h = harness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const changes = yield* makeChanges(h.storage);
        const store = yield* EntityStore;
        const templating = dependency === "template" || dependency === "uses";
        const proposal = yield* changes.prepare(
          "owner",
          templating ? { kind: "putTemplate", template: { ...template, label: "Hi" } } : action,
        );
        if (dependency === "record") yield* store.putEntity("person", "ada", { name: "Different" });
        if (dependency === "type") yield* store.putType({ ...person, label: "Changed" });
        if (dependency === "subscription") yield* store.subscribe("new", "person");
        if (dependency === "template")
          yield* store.putTemplate({ ...template, content: { body: "Changed" } });
        if (dependency === "uses") h.usages.draft = [];
        expect(yield* changes.decide("owner", proposal.id, true).pipe(Effect.flip)).toMatchObject({
          message: expect.stringContaining("stale"),
        });
        expect(yield* nameOf()).toBe(dependency === "record" ? "Different" : "Ada");
      }).pipe(Effect.provide(h.layer)),
    );
  }
});

test("a confirmation that loses a race to another writer fails at entity-store instead of overwriting", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const proposal = yield* changes.prepare("owner", action);
      // Another writer lands after the staleness check, just before the write: only the
      // revision condition can catch it.
      const upsert = h.store.upsertEntity;
      let raced = false;
      Object.assign(h.store, {
        upsertEntity: async (...args: Parameters<typeof upsert>) => {
          if (!raced) {
            raced = true;
            await upsert("person", "ada", { patch: { name: "Racer" } });
          }
          return upsert(...args);
        },
      });
      const failure = yield* changes.decide("owner", proposal.id, true).pipe(Effect.flip);
      expect(failure).toMatchObject({ message: expect.stringContaining("stale") });
      expect(yield* nameOf()).toBe("Racer");
      // Nothing was written, so the proposal is pending again, and can be cancelled.
      expect(h.data.get(`proposal:${proposal.id}`)).toMatchObject({ state: "pending" });
      expect((yield* changes.decide("owner", proposal.id, false)).status).toBe("cancelled");
    }).pipe(Effect.provide(h.layer)),
  );
});

test("a write that landed before its receipt is found after a restart and never applied twice", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const proposal = yield* changes.prepare("owner", action, "stable");
      h.receiptFailure(true);
      yield* changes.decide("owner", proposal.id, true).pipe(Effect.flip);
      expect(yield* nameOf()).toBe("Ada Lovelace");
      // Another writer edits it before the restart.
      yield* (yield* EntityStore).putEntity("person", "ada", { name: "Edited after" });
      h.receiptFailure(false);
      const restarted = yield* makeChanges(h.storage);
      const receipt = yield* restarted.decide("owner", proposal.id, true);
      expect(receipt).toEqual({
        status: "applied",
        result: {
          entity: {
            type: "person",
            id: "ada",
            data: { name: "Ada Lovelace", email: "ada@example.com" },
          },
        },
      });
      expect(yield* nameOf()).toBe("Edited after");
      expect(h.writes("ada").map((change) => change.meta)).toEqual([
        { depth: 0, changeId: proposal.id },
      ]);
      expect(yield* restarted.decide("owner", proposal.id, false)).toEqual(receipt);
      expect(yield* restarted.prepare("owner", action, "stable")).toEqual(proposal);
    }).pipe(Effect.provide(h.layer)),
  );
});

test("an approved write that never landed doesn't overwrite a newer edit or hold other changes back", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const store = yield* EntityStore;
      const proposal = yield* changes.prepare("owner", action);
      h.applyingFailure(true);
      yield* changes.decide("owner", proposal.id, true).pipe(Effect.flip);
      expect(yield* nameOf()).toBe("Ada");
      h.applyingFailure(false);
      // Approved, then entity-store was unreachable: the intent stays applying.
      h.store.failing("upsertEntity", { code: "StorageFailure", message: "D1 unavailable" });
      yield* changes.decide("owner", proposal.id, true).pipe(Effect.flip);
      expect(h.data.get(`proposal:${proposal.id}`)).toMatchObject({ state: "applying" });
      h.store.failing("upsertEntity", undefined);
      yield* store.putEntity("person", "ada", { name: "External" });
      // Recovery runs before the next proposal: the stale intent goes back to pending, unwritten.
      const next = yield* changes.prepare("owner", { ...action, id: "sam", data: { name: "Sam" } });
      expect(yield* nameOf()).toBe("External");
      expect(h.data.get(`proposal:${proposal.id}`)).toMatchObject({ state: "pending" });
      expect((yield* changes.decide("owner", next.id, true)).status).toBe("applied");
      expect(yield* changes.decide("owner", proposal.id, true).pipe(Effect.flip)).toMatchObject({
        message: expect.stringContaining("stale"),
      });
    }).pipe(Effect.provide(h.layer)),
  );
});

test("template deletion distinguishes saved, draft and unchecked impact, and never says running work loses its wording", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const proposal = yield* changes.prepare("owner", { kind: "deleteTemplate", name: "welcome" });
      expect(proposal.consequences.join(" ")).toContain("saved workflow uses");
      expect(proposal.consequences.join(" ")).toContain("draft uses");
      expect(proposal.consequences.join(" ")).toContain("Runs already in flight keep");
      expect(proposal.consequences.join(" ")).toContain("impact could not be checked");
      expect(yield* changes.decide("owner", proposal.id, true)).toEqual({
        status: "applied",
        result: { deleted: "welcome" },
      });
    }).pipe(Effect.provide(h.layer)),
  );
});

test("an applying intent whose entity write failed resumes from the original before state", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const proposal = yield* changes.prepare("owner", action);
      h.store.failing("upsertEntity", "throw");
      yield* changes.decide("owner", proposal.id, true).pipe(Effect.flip);
      expect(yield* nameOf()).toBe("Ada");
      h.store.failing("upsertEntity", undefined);
      const restarted = yield* makeChanges(h.storage);
      const receipt = yield* restarted.decide("owner", proposal.id, false);
      // Approval was already persisted; a subsequent cancellation cannot undo the applying intent.
      expect(receipt.status).toBe("applied");
      expect(yield* nameOf()).toBe("Ada Lovelace");
      expect(h.writes("ada")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer)),
  );
});

test("concurrent approved proposals serialize; only the first of two conflicting changes applies", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const first = yield* changes.prepare("owner", action);
      const second = yield* changes.prepare("owner", { ...action, data: { name: "Another" } });
      const decisions = yield* Effect.all(
        [
          changes.decide("owner", first.id, true).pipe(Effect.result),
          changes.decide("owner", second.id, true).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(decisions.filter(Result.isSuccess).length).toBe(1);
      expect(decisions.filter(Result.isFailure).length).toBe(1);
      expect(h.writes("ada")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer)),
  );
});

test("template changes show content fields by name, even one called updatedAt", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.putTemplate({ ...template, content: { updatedAt: "Original" } });
      const changes = yield* makeChanges(h.storage);
      const next = {
        kind: "putTemplate",
        template: { ...template, content: { updatedAt: "Replacement" } },
      } as const;
      const proposal = yield* changes.prepare("owner", next, "template-call");
      expect(proposal.details).toContainEqual({
        label: "content · updatedAt",
        before: "Original",
        after: "Replacement",
      });
      yield* changes
        .prepare(
          "owner",
          { ...next, template: { ...next.template, content: { updatedAt: "Different" } } },
          "template-call",
        )
        .pipe(Effect.flip);
      expect(yield* changes.decide("owner", proposal.id, true)).toEqual({
        status: "applied",
        result: next.template,
      });
      expect((yield* store.getTemplate("welcome"))?.content).toEqual({ updatedAt: "Replacement" });
    }).pipe(Effect.provide(h.layer)),
  );
});

test("confirmed entity writes carry their change ID and depth to entity-store, and publish nothing themselves", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const created = yield* changes.prepare("owner", {
        ...action,
        id: "sam",
        data: { name: "Sam", email: "sam@example.com" },
      });
      yield* changes.decide("owner", created.id, true);
      const updated = yield* changes.prepare("owner", {
        ...action,
        id: "sam",
        data: { name: "Samuel", email: null },
      });
      expect(updated.details).toEqual([
        { label: "name", before: "Sam", after: "Samuel" },
        { label: "email", before: "sam@example.com", after: "Removed" },
      ]);
      yield* changes.decide("owner", updated.id, true);
      const cancelled = yield* changes.prepare("owner", {
        ...action,
        id: "sam",
        data: { name: "Never written" },
      });
      yield* changes.decide("owner", cancelled.id, false);
      const deleted = yield* changes.prepare("owner", {
        kind: "deleteEntity",
        type: "person",
        id: "sam",
      });
      expect(yield* changes.decide("owner", deleted.id, true)).toMatchObject({
        status: "applied",
        result: { deleted: { type: "person", id: "sam", data: { name: "Samuel" } } },
      });
      expect(h.writes("sam").map(({ op, rev, meta }) => ({ op, rev, meta }))).toEqual([
        { op: "create", rev: 1, meta: { depth: 0, changeId: created.id } },
        { op: "patch", rev: 2, meta: { depth: 0, changeId: updated.id } },
        { op: "delete", rev: 3, meta: { depth: 0, changeId: deleted.id } },
      ]);
      expect(yield* (yield* EntityStore).getEntity("person", "sam")).toBeUndefined();
      // A deleted ID can be created again, at the next revision.
      const again = yield* changes.prepare("owner", { ...action, id: "sam", data: { name: "S" } });
      yield* changes.decide("owner", again.id, true);
      expect(h.writes("sam").at(-1)).toMatchObject({ op: "create", rev: 4 });
    }).pipe(Effect.provide(h.layer)),
  );
});

test("an authorized command records its source event and depth, and recovers before later writers", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const origin: Event = {
        id: "command-1",
        name: "entity.put",
        data: { type: "person", id: "ada", data: action.data },
        depth: 15,
      };
      const command = yield* changes.prepare("event:command-1", action, origin.id, origin);
      // Crash after recording the authorized intent, before deciding it.
      const reopened = yield* makeChanges(h.storage);
      const later = yield* reopened.prepare("owner", { ...action, data: { name: "Later edit" } });
      expect(yield* nameOf()).toBe("Ada Lovelace");
      expect(h.writes("ada").map((change) => change.meta)).toEqual([
        { depth: 16, sourceEventId: "command-1", changeId: command.id },
      ]);
      yield* reopened.decide("owner", later.id, true);
      // Redelivery finds the settled command and writes nothing more.
      expect(yield* reopened.prepare("event:command-1", action, origin.id, origin)).toEqual(
        command,
      );
      expect((yield* reopened.decide("event:command-1", command.id, true)).status).toBe("applied");
      expect(yield* nameOf()).toBe("Later edit");
      expect(h.writes("ada")).toHaveLength(2);
      yield* reopened
        .prepare("event:too-deep", action, "too-deep", { ...origin, depth: 16 })
        .pipe(Effect.flip);
      expect(h.writes("ada")).toHaveLength(2);
    }).pipe(Effect.provide(h.layer)),
  );
});

test("a command checks again against a newer write instead of failing forever; one entity-store refuses is settled", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const store = yield* EntityStore;
      const origin: Event = { id: "command-2", name: "entity.put", data: null, depth: 3 };
      const command = yield* changes.prepare("event:command-2", action, origin.id, origin);
      // Someone edits the entity in entity-store before the command applies.
      yield* store.putEntity("person", "ada", { email: "ada@lovelace.dev" });
      expect((yield* changes.decide("event:command-2", command.id, true)).status).toBe("applied");
      expect((yield* store.getEntity("person", "ada"))?.data).toEqual({
        name: "Ada Lovelace",
        email: "ada@lovelace.dev",
      });

      // A link to an entity that doesn't exist only fails at entity-store.
      yield* store.putType({
        ...person,
        fields: [
          ...person.fields,
          { name: "manager", label: "Manager", type: "ref", to: "person" },
        ],
      });
      const dangling: Event = { id: "command-3", name: "entity.put", data: null, depth: 0 };
      const refused = yield* changes.prepare(
        "event:command-3",
        { ...action, data: { manager: "nobody" } },
        dangling.id,
        dangling,
      );
      expect(yield* changes.decide("event:command-3", refused.id, true)).toMatchObject({
        status: "cancelled",
        result: { error: expect.stringContaining("nobody") },
      });
      // Settled, so it no longer blocks or retries.
      const next = yield* changes.prepare("owner", { ...action, data: { name: "Next" } });
      expect((yield* changes.decide("owner", next.id, true)).status).toBe("applied");
    }).pipe(Effect.provide(h.layer)),
  );
});

test("type changes become entity-store versions, checked when prepared", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const added = yield* changes.prepare("owner", {
        kind: "putType",
        type: {
          ...person,
          fields: [...person.fields, { name: "team", label: "Team", type: "text" }],
        },
      });
      expect(added.details).toContainEqual({
        label: "fields · 3 · name",
        before: "Not set",
        after: "team",
      });
      yield* changes.decide("owner", added.id, true);
      const info = yield* Effect.promise(() => h.store.getType("person"));
      expect(info).toMatchObject({
        value: {
          latestVersion: 2,
          versions: [{}, { lens: { ops: [{ op: "add", field: "team" }] } }],
        },
      });
      const retyped = yield* changes
        .prepare("owner", {
          kind: "putType",
          type: {
            ...person,
            fields: [
              { name: "name", label: "Name", type: "text" },
              { name: "email", label: "Email", type: "number" },
            ],
          },
        })
        .pipe(Effect.flip);
      expect(retyped).toMatchObject({ message: expect.stringContaining("in entity-store") });
    }).pipe(Effect.provide(h.layer)),
  );
});

test("proposals prepared before entity-store keep their receipts, and the rest must be prepared again", async () => {
  const h = harness();
  const proposal = (id: string) => ({
    id,
    action,
    title: "Save person ada",
    details: [],
    consequences: [],
    confirmLabel: "Save",
  });
  const snapshot = {
    types: [],
    entities: [],
    templates: [],
    roles: [],
    subscriptions: {},
    uses: [],
  };
  h.data.set("proposal:change-1", {
    owner: "owner",
    proposal: proposal("change-1"),
    before: snapshot,
    after: snapshot,
    result: { entity: null, triggered: [] },
    state: "terminal",
    receipt: { status: "applied", result: { entity: null, triggered: [] } },
  });
  h.data.set("proposal:change-2", {
    owner: "owner",
    proposal: proposal("change-2"),
    before: snapshot,
    after: snapshot,
    result: null,
    state: "applying",
  });
  h.data.set("sequence", 2);
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      expect(yield* changes.decide("owner", "change-1", true)).toEqual({
        status: "applied",
        result: { entity: null, triggered: [] },
      });
      expect(yield* changes.decide("owner", "change-2", true).pipe(Effect.flip)).toMatchObject({
        message: expect.stringContaining("Prepare the change again"),
      });
      const next = yield* changes.prepare("owner", action);
      expect(next.id).toBe("change-3");
      expect((yield* changes.decide("owner", next.id, true)).status).toBe("applied");
    }).pipe(Effect.provide(h.layer)),
  );
});
