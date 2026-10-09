/** Persisted confirmation coordinator. Dry runs use the very same store validation as writes. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AutomationIndex } from "../automation/index.ts";
import { Automations } from "../automation/service.ts";
import { EntityStore, layerMemory } from "../entities/store.ts";
import { EntitySubscribers } from "../entities/subscribers.ts";
import { EntityRecord, EntityType, Role } from "../entities/model.ts";
import { Template } from "../entities/templates.ts";
import { messageOf } from "../error.ts";
import type { ChangeStorage } from "./host.ts";
import { ChangeAction, ChangeDecision, ChangeProposal } from "./model.ts";
import { ChangeError, Changes } from "./service.ts";
import { Event } from "../events/model.ts";
import type { Events } from "../events/service.ts";

const Snapshot = Schema.Struct({
  types: Schema.Array(EntityType),
  entities: Schema.Array(EntityRecord),
  templates: Schema.Array(Template),
  roles: Schema.Array(Role),
  subscriptions: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  uses: Schema.Json,
});
const Stored = Schema.Struct({
  owner: Schema.String,
  requestId: Schema.optionalKey(Schema.String),
  sourceEvent: Schema.optionalKey(Event),
  proposal: ChangeProposal,
  before: Snapshot,
  after: Snapshot,
  result: Schema.Json,
  state: Schema.Literals(["pending", "applying", "terminal"]),
  receipt: Schema.optionalKey(ChangeDecision),
});
type Stored = typeof Stored.Type;
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
// The dry run and the actual entity write have different write timestamps. Ignore only that
// metadata on recovery, never a data or template-content field that happens to share its name.
const afterFingerprint = (state: typeof Snapshot.Type) =>
  canonical({
    ...state,
    entities: state.entities.map((entity) => ({ ...entity, updatedAt: 0 })),
  });
const fail = (message: string) => new ChangeError({ message });

const mutate = Effect.fn("Changes.mutate")(function* (
  store: EntityStore["Service"],
  action: ChangeAction,
): Effect.fn.Return<Schema.Json, unknown> {
  switch (action.kind) {
    case "putType":
      return yield* store.putType(action.type);
    case "deleteType":
      yield* store.deleteType(action.name);
      return { deleted: action.name };
    case "putTemplate":
      return yield* store.putTemplate(action.template);
    case "deleteTemplate":
      yield* store.deleteTemplate(action.name);
      return { deleted: action.name };
    case "putEntity":
      return {
        entity: (yield* store.putEntity(action.type, action.id, action.data)).after,
        triggered: [],
      };
    case "deleteEntity": {
      const deleted = yield* store.deleteEntity(action.type, action.id);
      if (!deleted) return yield* fail("Entity not found");
      return { deleted };
    }
  }
});

export const makeChanges = Effect.fn("Changes.make")(function* (
  storage: ChangeStorage,
  events?: Events["Service"],
) {
  const store = yield* EntityStore;
  const index = yield* AutomationIndex;
  const automations = yield* Automations;
  const subscribers = yield* EntitySubscribers;
  const lock = yield* Semaphore.make(1);
  const snapshot = Effect.fn("Changes.snapshot")(function* (
    source: EntityStore["Service"] = store,
  ): Effect.fn.Return<typeof Snapshot.Type, unknown> {
    const types = [...(yield* source.listTypes)].sort((a, b) => a.name.localeCompare(b.name));
    const templates = [...(yield* source.listTemplates)].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const entities = (yield* Effect.forEach(types, (type) => source.listEntities(type.name)))
      .flat()
      .sort((a, b) => `${a.type}/${a.id}`.localeCompare(`${b.type}/${b.id}`));
    const subscriptions = Object.fromEntries(
      yield* Effect.forEach(types, (type) =>
        Effect.map(store.subscribers(type.name), (ids) => [type.name, [...ids].sort()] as const),
      ),
    );
    const uses = yield* Effect.forEach(
      [...(yield* index.list)].sort((a, b) => a.id.localeCompare(b.id)),
      (item) =>
        Effect.gen(function* () {
          const client = automations.get(item.id);
          const usage = yield* client.templateUses();
          const overview = yield* client.overview();
          return {
            id: item.id,
            name: item.name,
            saved: [...usage.saved].sort(),
            draft: [...usage.draft].sort(),
            trigger: overview.saved?.trigger ?? null,
          };
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed({
              id: item.id,
              name: item.name,
              unchecked: messageOf(Cause.squash(cause)),
            }),
          ),
        ),
    );
    return {
      types,
      templates,
      entities,
      roles: [...(yield* source.listRoles)].sort((a, b) => a.name.localeCompare(b.name)),
      subscriptions,
      uses,
    };
  });
  const write = (record: Stored) => storage.put(`proposal:${record.proposal.id}`, record);
  const read = (value: unknown) => Schema.decodeUnknownEffect(Stored)(value);
  const records = Effect.gen(function* () {
    return yield* Effect.forEach(yield* storage.list("proposal:"), read);
  });
  const recover = Effect.fn("Changes.recover")(function* (record: Stored) {
    const current = yield* snapshot();
    if (afterFingerprint(current) !== afterFingerprint(record.after)) {
      if (!same(current, record.before))
        return yield* fail(
          "An applying change conflicts with current data. Changes are blocked until the host resolves it.",
        );
      yield* mutate(store, record.proposal.action);
      if (afterFingerprint(yield* snapshot()) !== afterFingerprint(record.after))
        return yield* fail(
          "Change was written but dependencies changed. Changes are blocked pending recovery.",
        );
    }
    let result = record.result;
    const action = record.proposal.action;
    if (action.kind === "putEntity") {
      const before = record.before.entities.find(
        (entity) => entity.type === action.type && entity.id === action.id,
      );
      const after = record.after.entities.find(
        (entity) => entity.type === action.type && entity.id === action.id,
      );
      if (after === undefined)
        return yield* fail(
          "Applying entity change has no stored after value; recovery is blocked.",
        );
      const triggered = yield* subscribers.notify(
        { before: before?.data, after: { type: after.type, id: after.id, data: after.data } },
        `change:${record.proposal.id}`,
        record.sourceEvent === undefined
          ? undefined
          : { ...record.sourceEvent, depth: record.sourceEvent.depth + 1 },
      );
      result = { entity: { type: after.type, id: after.id, data: after.data }, triggered };
    }
    if (events !== undefined && (action.kind === "putEntity" || action.kind === "deleteEntity")) {
      const before = record.before.entities.find(
        (entity) => entity.type === action.type && entity.id === action.id,
      );
      const after = record.after.entities.find(
        (entity) => entity.type === action.type && entity.id === action.id,
      );
      const entity = after ?? before;
      if (entity !== undefined) {
        yield* events.publish({
          id: `change:${record.proposal.id}`,
          name:
            action.kind === "deleteEntity"
              ? "entity.deleted"
              : before === undefined
                ? "entity.created"
                : "entity.updated",
          data: { before: before?.data ?? null, after: after?.data ?? null },
          subject: { type: entity.type, id: entity.id, data: entity.data },
          depth: record.sourceEvent === undefined ? 0 : record.sourceEvent.depth + 1,
        });
      }
    }
    const receipt: ChangeDecision = { status: "applied", result };
    yield* write({ ...record, state: "terminal", receipt });
    return receipt;
  });
  const recoverAll = Effect.gen(function* () {
    for (const record of yield* records) if (record.state === "applying") yield* recover(record);
  });
  return Changes.of({
    prepare: Effect.fn("Changes.prepare")(
      function* (owner: string, input: ChangeAction, requestId?: string, sourceEvent?: Event) {
        const action = yield* Schema.decodeUnknownEffect(ChangeAction)(input);
        if (sourceEvent !== undefined && sourceEvent.depth >= 16) {
          return yield* fail("Event chain limit reached");
        }
        if (requestId !== undefined) {
          const existing = (yield* records).find(
            (record) => record.owner === owner && record.requestId === requestId,
          );
          if (existing) {
            if (!same(existing.proposal.action, action))
              return yield* fail("Request ID already belongs to another action");
            return existing.proposal;
          }
        }
        yield* recoverAll;
        const before = yield* snapshot();
        const preview = yield* Effect.gen(function* () {
          const shadow = yield* EntityStore;
          for (const [type, ids] of Object.entries(before.subscriptions))
            for (const id of ids) yield* shadow.subscribe(id, type);
          const result = yield* mutate(shadow, action);
          const after = yield* snapshot(shadow);
          return { result, after };
        }).pipe(Effect.provide(layerMemory(before)));
        const id = yield* storage.transaction(
          Effect.gen(function* () {
            const count = yield* Schema.decodeUnknownEffect(Schema.Int)(
              (yield* storage.get("sequence")) ?? 0,
            );
            yield* storage.put("sequence", count + 1);
            return `change-${count + 1}`;
          }),
        );
        const name =
          "id" in action
            ? `${action.type} ${action.id}`
            : "template" in action
              ? action.template.name
              : action.kind === "putType"
                ? action.type.name
                : action.name;
        const deleting = action.kind.startsWith("delete");
        const details: ChangeProposal["details"][number][] = [];
        const walk = (left: unknown, right: unknown, label: string) => {
          if (same(left, right)) return;
          if (Array.isArray(left) || Array.isArray(right)) {
            const a = Array.isArray(left) ? left : [];
            const b = Array.isArray(right) ? right : [];
            for (let i = 0; i < Math.max(a.length, b.length); i++)
              walk(a[i], b[i], `${label} · ${i + 1}`);
          } else if ((left && typeof left === "object") || (right && typeof right === "object")) {
            const a = (left ?? {}) as Record<string, unknown>;
            const b = (right ?? {}) as Record<string, unknown>;
            for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
              walk(a[key], b[key], label ? `${label} · ${key}` : key);
          } else
            details.push({
              label,
              before:
                left === undefined
                  ? "Not set"
                  : typeof left === "string"
                    ? left
                    : JSON.stringify(left),
              after:
                right === undefined
                  ? "Removed"
                  : typeof right === "string"
                    ? right
                    : JSON.stringify(right),
            });
        };
        const target = (state: typeof before) =>
          action.kind.includes("Entity")
            ? state.entities.find(
                (e) => "id" in action && e.type === action.type && e.id === action.id,
              )?.data
            : action.kind.includes("Template")
              ? state.templates.find((t) => t.name === name)
              : state.types.find((t) => t.name === name);
        walk(target(before), target(preview.after), "");
        const consequences =
          action.kind === "putEntity"
            ? [
                `This edit may start matching saved automations watching ${action.type}: ${(before.subscriptions[action.type] ?? []).join(", ") || "none currently subscribed"}.`,
                "This edit emits entity.created or entity.updated and may start automations listening for it.",
              ]
            : action.kind === "deleteEntity"
              ? [
                  "Deletion emits entity.deleted and may start automations listening for it. References to this entity will read as empty.",
                ]
              : action.kind === "deleteType"
                ? [
                    "This empty type will no longer be available to drafts or new runs. Existing runs keep their snapshots.",
                  ]
                : action.kind === "putType"
                  ? [
                      "Stored entities are not rewritten. Future writes and new runs must fit the new type; removed fields are dropped on the next entity write.",
                    ]
                  : [
                      deleting
                        ? "New runs of saved automations using this template will fail validation until fixed. Runs already in flight keep their expanded wording."
                        : "New saved runs use this wording. Runs already in flight keep their expanded wording.",
                    ];
        for (const item of before.uses as Array<{
          id: string;
          saved?: string[];
          draft?: string[];
          unchecked?: string;
        }>) {
          if (item.unchecked)
            consequences.push(`${item.id}: impact could not be checked (${item.unchecked}).`);
          else if (action.kind.includes("Template")) {
            if (item.saved?.includes(name))
              consequences.push(`${item.id}: saved workflow uses this template.`);
            if (item.draft?.includes(name))
              consequences.push(
                `${item.id}: draft uses this template; it must be checked before saving.`,
              );
          }
        }
        const proposal: ChangeProposal = {
          id,
          action,
          title: `${deleting ? "Delete" : "Save"} ${name}`,
          details,
          consequences,
          confirmLabel: deleting ? "Delete" : "Save",
        };
        yield* write({
          owner,
          ...(requestId === undefined ? {} : { requestId }),
          ...(sourceEvent === undefined
            ? {}
            : { sourceEvent: yield* Schema.decodeUnknownEffect(Event)(sourceEvent) }),
          proposal,
          before,
          after: preview.after,
          result: preview.result,
          // An event command is already authorized by its producer's permission. Persist the
          // applying intent now, so a restart between prepare and decide cannot make it stale.
          state: sourceEvent === undefined ? "pending" : "applying",
        });
        return proposal;
      },
      (effect) => lock.withPermit(effect),
    ),
    decide: Effect.fn("Changes.decide")(
      function* (owner: string, id: string, approved: boolean) {
        const value = yield* storage.get(`proposal:${id}`);
        if (value === undefined) return yield* fail("Proposal not found");
        const record = yield* read(value);
        if (record.owner !== owner) return yield* fail("Proposal not found");
        if (record.receipt) return record.receipt;
        if (record.state === "applying") return yield* recover(record);
        if (!approved) {
          const receipt: ChangeDecision = { status: "cancelled", result: null };
          yield* write({ ...record, state: "terminal", receipt });
          return receipt;
        }
        yield* recoverAll;
        if (!same(yield* snapshot(), record.before))
          return yield* fail(
            "This proposal is stale. Prepare a new change to review the current values and consequences.",
          );
        const applying: Stored = { ...record, state: "applying" };
        yield* write(applying);
        return yield* recover(applying);
      },
      (effect) => lock.withPermit(effect),
    ),
  });
});
