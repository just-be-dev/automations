import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { AutomationIndex } from "../automation/index.ts";
import { Automations } from "../automation/service.ts";
import { EntityStore, EntityStoreError, layerMemory } from "../entities/store.ts";
import { EntitySubscribers } from "../entities/subscribers.ts";
import type { EntityType } from "../entities/model.ts";
import { makeChanges } from "./application.ts";
import type { ChangeStorage } from "./host.ts";
import type { Event } from "../events/model.ts";
import { EventError } from "../events/service.ts";

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
  const keys: string[] = [];
  const origins: Array<Event | undefined> = [];
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
  const layer = Layer.mergeAll(
    layerMemory({
      types: [person],
      templates: [template],
      entities: [
        {
          type: "person",
          id: "ada",
          data: { name: "Ada", email: "ada@example.com", old: "removed" },
          updatedAt: 0,
        },
      ],
    }),
    Layer.succeed(AutomationIndex, {
      list: Effect.succeed([
        { id: "a", name: "A", updatedAt: 0 },
        { id: "broken", name: "Broken", updatedAt: 0 },
      ]),
      create: () => Effect.succeed(true),
      record: () => Effect.void,
      recordIfMissing: () => Effect.void,
    }),
    Layer.succeed(Automations, {
      get: (id) => ({
        templateUses: () =>
          id === "broken" ? Effect.fail("unreachable") : Effect.sync(() => usages),
        overview: () => Effect.succeed({ activeRuns: [] }),
        inspectWorkflow: unused,
        answer: unused,
        chat: unused,
        save: unused,
        setPermissions: unused,
        start: unused,
        entityChanged: unused,
        eventReceived: unused,
        plannerTrace: unused,
        runTrace: unused,
        run: unused,
        respond: unused,
      }),
    }),
    Layer.succeed(EntitySubscribers, {
      notify: (_change, key, event) =>
        Effect.sync(() => {
          keys.push(key ?? "");
          origins.push(event);
          return [{ automation: "a", runId: `entity-${key}`, error: null }];
        }),
    }),
  );
  return {
    storage,
    layer,
    data,
    keys,
    origins,
    usages,
    receiptFailure: (value: boolean) => {
      failReceipt = value;
    },
    applyingFailure: (value: boolean) => {
      failApplying = value;
    },
  };
};

test("prepare validates without writes, shows asymmetric merged fields, and isolates cancellation and replay by owner", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const store = yield* EntityStore;
      const proposal = yield* changes.prepare("owner", action, "call-1");
      expect(proposal.details).toContainEqual({
        label: "name",
        before: "Ada",
        after: "Ada Lovelace",
      });
      expect(proposal.details).toContainEqual({
        label: "old",
        before: "removed",
        after: "Removed",
      });
      expect(proposal.details.some((detail) => detail.label === "email")).toBe(false);
      expect(proposal.consequences.join(" ")).toContain("may start");
      expect(proposal.consequences.join(" ")).toContain("impact could not be checked");
      expect((yield* store.getEntity("person", "ada"))?.data.name).toBe("Ada");
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
      expect(h.keys).toEqual([]);
      yield* changes.prepare("owner", { ...action, data: { name: 1 } }).pipe(Effect.flip);
    }).pipe(Effect.provide(h.layer)),
  );
});

test("stale records, types, subscriptions and template uses require another review", async () => {
  for (const dependency of ["record", "type", "subscription", "template", "uses"]) {
    const h = harness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const changes = yield* makeChanges(h.storage);
        const store = yield* EntityStore;
        const proposal = yield* changes.prepare("owner", action);
        if (dependency === "record") yield* store.putEntity("person", "ada", { name: "Different" });
        if (dependency === "type") yield* store.putType({ ...person, label: "Changed" });
        if (dependency === "subscription") yield* store.subscribe("new", "person");
        if (dependency === "template")
          yield* store.putTemplate({ ...template, content: { body: "Changed" } });
        if (dependency === "uses") h.usages.draft = [];
        expect(yield* changes.decide("owner", proposal.id, true).pipe(Effect.flip)).toMatchObject({
          message: expect.stringContaining("stale"),
        });
        expect(h.keys).toEqual([]);
      }).pipe(Effect.provide(h.layer)),
    );
  }
});

test("receipt failure after write recovers with original change and stable notification key after restart", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const proposal = yield* changes.prepare("owner", action, "stable");
      h.receiptFailure(true);
      yield* changes.decide("owner", proposal.id, true).pipe(Effect.flip);
      expect((yield* (yield* EntityStore).getEntity("person", "ada"))?.data.name).toBe(
        "Ada Lovelace",
      );
      h.receiptFailure(false);
      const restarted = yield* makeChanges(h.storage);
      const receipt = yield* restarted.decide("owner", proposal.id, true);
      expect(receipt).toMatchObject({
        status: "applied",
        result: {
          entity: { data: { name: "Ada Lovelace" } },
          triggered: [{ runId: `entity-change:${proposal.id}` }],
        },
      });
      expect(h.keys).toEqual([`change:${proposal.id}`, `change:${proposal.id}`]);
      expect(yield* restarted.decide("owner", proposal.id, false)).toEqual(receipt);
      expect(yield* restarted.prepare("owner", action, "stable")).toEqual(proposal);
      expect(h.keys.length).toBe(2);
    }).pipe(Effect.provide(h.layer)),
  );
});

test("failure before applying persistence writes nothing; conflicting recovery blocks instead of overwriting", async () => {
  const h = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage);
      const store = yield* EntityStore;
      const proposal = yield* changes.prepare("owner", action);
      h.applyingFailure(true);
      yield* changes.decide("owner", proposal.id, true).pipe(Effect.flip);
      expect((yield* store.getEntity("person", "ada"))?.data.name).toBe("Ada");
      h.applyingFailure(false);
      h.receiptFailure(true);
      yield* changes.decide("owner", proposal.id, true).pipe(Effect.flip);
      yield* store.putEntity("person", "ada", { name: "External" });
      h.receiptFailure(false);
      expect(yield* changes.prepare("owner", action).pipe(Effect.flip)).toMatchObject({
        message: expect.stringContaining("blocked"),
      });
      expect((yield* store.getEntity("person", "ada"))?.data.name).toBe("External");
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
      const store = yield* EntityStore;
      const failing = yield* makeChanges(h.storage).pipe(
        Effect.provideService(EntityStore, {
          ...store,
          putEntity: () => Effect.fail(new EntityStoreError({ message: "D1 unavailable" })),
        }),
      );
      const proposal = yield* failing.prepare("owner", action);
      yield* failing.decide("owner", proposal.id, true).pipe(Effect.flip);
      expect((yield* store.getEntity("person", "ada"))?.data.name).toBe("Ada");
      expect(h.keys).toEqual([]);
      const restarted = yield* makeChanges(h.storage);
      const receipt = yield* restarted.decide("owner", proposal.id, false);
      // Approval was already persisted; a subsequent cancellation cannot undo the applying intent.
      expect(receipt.status).toBe("applied");
      expect((yield* store.getEntity("person", "ada"))?.data.name).toBe("Ada Lovelace");
      expect(h.keys).toEqual([`change:${proposal.id}`]);
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
      expect(h.keys.length).toBe(1);
    }).pipe(Effect.provide(h.layer)),
  );
});

test("metadata normalization never hides a template-content change named updatedAt", async () => {
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

test("confirmed entity creations, updates and deletions emit immutable facts; cancellation emits nothing", async () => {
  const h = harness();
  const emitted: Array<Event> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage, {
        publish: (event) => Effect.sync(() => void emitted.push(event)),
      });
      const created = yield* changes.prepare("owner", {
        ...action,
        id: "sam",
        data: { name: "Sam", email: "sam@example.com" },
      });
      yield* changes.decide("owner", created.id, true);
      const updated = yield* changes.prepare("owner", {
        ...action,
        id: "sam",
        data: { name: "Samuel" },
      });
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
      yield* changes.decide("owner", deleted.id, true);
      expect(emitted).toEqual([
        {
          id: `change:${created.id}`,
          name: "entity.created",
          data: { before: null, after: { name: "Sam", email: "sam@example.com" } },
          subject: { type: "person", id: "sam", data: { name: "Sam", email: "sam@example.com" } },
          depth: 0,
        },
        {
          id: `change:${updated.id}`,
          name: "entity.updated",
          data: {
            before: { name: "Sam", email: "sam@example.com" },
            after: { name: "Samuel", email: "sam@example.com" },
          },
          subject: {
            type: "person",
            id: "sam",
            data: { name: "Samuel", email: "sam@example.com" },
          },
          depth: 0,
        },
        {
          id: `change:${deleted.id}`,
          name: "entity.deleted",
          data: { before: { name: "Samuel", email: "sam@example.com" }, after: null },
          subject: {
            type: "person",
            id: "sam",
            data: { name: "Samuel", email: "sam@example.com" },
          },
          depth: 0,
        },
      ]);
      expect(yield* (yield* EntityStore).getEntity("person", "sam")).toBeUndefined();
      expect(h.keys).toEqual([`change:${created.id}`, `change:${updated.id}`]);
    }).pipe(Effect.provide(h.layer)),
  );
});

test("publication failure after an entity write recovers the original event and depth before acknowledging the command", async () => {
  const h = harness();
  const attempts: Array<Event> = [];
  let unavailable = true;
  const publisher = {
    publish: (event: Event) =>
      Effect.gen(function* () {
        attempts.push(event);
        if (unavailable) return yield* new EventError({ message: "Queue unavailable" });
      }),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage, publisher);
      const origin: Event = {
        id: "command-81",
        name: "entity.put",
        data: { type: "person", id: "ada", data: action.data },
        depth: 5,
      };
      const proposal = yield* changes.prepare("event:command-81", action, origin.id, origin);
      yield* changes.decide("event:command-81", proposal.id, true).pipe(Effect.flip);
      expect((yield* (yield* EntityStore).getEntity("person", "ada"))?.data.name).toBe(
        "Ada Lovelace",
      );
      expect(h.data.get(`proposal:${proposal.id}`)).toMatchObject({ state: "applying" });
      unavailable = false;
      const reopened = yield* makeChanges(h.storage, publisher);
      expect((yield* reopened.decide("event:command-81", proposal.id, true)).status).toBe(
        "applied",
      );
      const expected = {
        id: `change:${proposal.id}`,
        name: "entity.updated",
        data: {
          before: { name: "Ada", email: "ada@example.com", old: "removed" },
          after: { name: "Ada Lovelace", email: "ada@example.com" },
        },
        subject: {
          type: "person",
          id: "ada",
          data: { name: "Ada Lovelace", email: "ada@example.com" },
        },
        depth: 6,
      };
      expect(attempts).toEqual([expected, expected]);
      expect(h.origins).toEqual([
        { ...origin, depth: 6 },
        { ...origin, depth: 6 },
      ]);
      yield* reopened.decide("event:command-81", proposal.id, true);
      expect(attempts).toHaveLength(2);
    }).pipe(Effect.provide(h.layer)),
  );
});

test("authorized command intents recover before later writers; redelivery cannot overwrite a newer edit", async () => {
  const h = harness();
  const emitted: Array<Event> = [];
  const publisher = { publish: (event: Event) => Effect.sync(() => void emitted.push(event)) };
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* makeChanges(h.storage, publisher);
      const origin: Event = {
        id: "command-1",
        name: "entity.put",
        data: { type: "person", id: "ada", data: action.data },
        depth: 15,
      };
      const command = yield* changes.prepare("event:command-1", action, origin.id, origin);
      // Crash after recording the authorized intent, before deciding it.
      const reopened = yield* makeChanges(h.storage, publisher);
      const later = yield* reopened.prepare("owner", { ...action, data: { name: "Later edit" } });
      expect((yield* (yield* EntityStore).getEntity("person", "ada"))?.data.name).toBe(
        "Ada Lovelace",
      );
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.depth).toBe(16);
      yield* reopened.decide("owner", later.id, true);
      expect(yield* reopened.prepare("event:command-1", action, origin.id, origin)).toEqual(
        command,
      );
      expect((yield* reopened.decide("event:command-1", command.id, true)).status).toBe("applied");
      expect((yield* (yield* EntityStore).getEntity("person", "ada"))?.data.name).toBe(
        "Later edit",
      );
      expect(emitted).toHaveLength(2);
      yield* reopened
        .prepare("event:too-deep", action, "too-deep", { ...origin, depth: 16 })
        .pipe(Effect.flip);
      expect(emitted).toHaveLength(2);
    }).pipe(Effect.provide(h.layer)),
  );
});
