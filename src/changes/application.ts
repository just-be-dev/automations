/**
 * Persisted confirmation coordinator. A proposal reads only what its action touches, and an
 * entity write is conditioned on the revision the person reviewed, so a stale confirmation fails
 * instead of overwriting. Writes carry the proposal's ID in their `meta`, which is how a restart
 * tells whether an interrupted write landed. Lifecycle events and entity triggers follow from
 * entity-store's change queue, not from here.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AutomationIndex } from "../automation/index.ts";
import { Automations } from "../automation/service.ts";
import { InvalidEntity } from "../entities/model.ts";
import { EntityRevConflict, EntityStore } from "../entities/store.ts";
import { checkTemplate, InvalidTemplate } from "../entities/templates.ts";
import { changeIdOf, changeMeta } from "../entities/write-meta.ts";
import { messageOf } from "../error.ts";
import type { ChangeStorage } from "./host.ts";
import { ChangeAction, ChangeDecision, ChangeProposal } from "./model.ts";
import { ChangeError, Changes } from "./service.ts";
import { Event, MAX_EVENT_DEPTH } from "../events/model.ts";

/** What a proposal was reviewed against. */
const Basis = Schema.Struct({
  /** What the action changes: the entity's data, the type or the template; `null` when absent. */
  target: Schema.Json,
  /** What else its checks and consequences read. A change to either makes the proposal stale. */
  context: Schema.Json,
});
type Basis = typeof Basis.Type;

/** An entity write's condition: the revision it expects, and the one it makes. */
const Revisions = Schema.Struct({ expectedRev: Schema.Int, rev: Schema.Int });
type Revisions = typeof Revisions.Type;

const Stored = Schema.Struct({
  version: Schema.Literal(2),
  owner: Schema.String,
  requestId: Schema.optionalKey(Schema.String),
  sourceEvent: Schema.optionalKey(Event),
  proposal: ChangeProposal,
  before: Basis,
  /** The target as the dry run left it. */
  after: Schema.Json,
  write: Schema.optionalKey(Revisions),
  result: Schema.Json,
  state: Schema.Literals(["pending", "applying", "terminal"]),
  receipt: Schema.optionalKey(ChangeDecision),
});
type Stored = typeof Stored.Type;

/**
 * A proposal prepared while automations kept entities itself, with a snapshot of the whole store.
 * Its receipt still answers; one that never got a receipt can't be confirmed any more.
 */
const Legacy = Schema.Struct({
  owner: Schema.String,
  requestId: Schema.optionalKey(Schema.String),
  proposal: ChangeProposal,
  state: Schema.Literals(["pending", "applying", "terminal"]),
  receipt: Schema.optionalKey(ChangeDecision),
});
const Record = Schema.Union([Stored, Legacy]);
type Record = typeof Record.Type;

const isCurrent = (record: Record): record is Stored => "version" in record;

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
const fail = (message: string) => new ChangeError({ message });

const STALE =
  "This proposal is stale. Prepare a new change to review the current values and consequences.";
const LEGACY =
  "This proposal was prepared before entities moved to entity-store. Prepare the change again.";
/** How many times an authorized command is checked again against newer data before it gives up. */
const COMMAND_ATTEMPTS = 3;

/** A proposal and what it was reviewed against, before it is stored. */
interface Look {
  readonly before: Basis;
  readonly after: Schema.Json;
  readonly write?: Revisions;
  readonly result: Schema.Json;
}

/** Why an approved change didn't apply. Nothing was written. */
type Outcome =
  | { readonly applied: true; readonly result: Schema.Json }
  | { readonly applied: false; readonly reason: "conflict" | "refused"; readonly message: string };

export const makeChanges = Effect.fn("Changes.make")(function* (storage: ChangeStorage) {
  const store = yield* EntityStore;
  const index = yield* AutomationIndex;
  const automations = yield* Automations;
  const lock = yield* Semaphore.make(1);

  /** Which listed automations use templates, for a template change's consequences. */
  const uses = Effect.gen(function* () {
    return yield* Effect.forEach(
      [...(yield* index.list)].sort((a, b) => a.id.localeCompare(b.id)),
      (item) =>
        Effect.gen(function* () {
          const usage = yield* automations.get(item.id).templateUses();
          return {
            id: item.id,
            name: item.name,
            saved: [...usage.saved].sort(),
            draft: [...usage.draft].sort(),
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
  });

  const currentType = (name: string) =>
    Effect.map(store.listTypes, (types) => types.find((type) => type.name === name) ?? null);

  /**
   * Reads what an action touches. With `check`, also checks the action as its write will, which
   * entity actions always do: their check is what reads the revision.
   */
  const look = Effect.fn("Changes.look")(function* (
    action: ChangeAction,
    check: boolean,
  ): Effect.fn.Return<Look, unknown> {
    switch (action.kind) {
      case "putEntity": {
        const write = yield* store.checkEntity(action.type, action.id, action.data);
        const subscribers = [...(yield* store.subscribers(action.type))].sort();
        return {
          before: {
            target: write.before?.data ?? null,
            context: { type: yield* currentType(action.type), subscribers },
          },
          after: write.after.data,
          write: { expectedRev: write.expectedRev, rev: write.rev },
          result: { entity: write.after },
        };
      }
      case "deleteEntity": {
        const deletion = yield* store.checkDeleteEntity(action.type, action.id);
        if (deletion === undefined) return yield* fail("Entity not found");
        return {
          before: { target: deletion.before.data, context: null },
          after: null,
          write: { expectedRev: deletion.expectedRev, rev: deletion.rev },
          result: { deleted: deletion.before },
        };
      }
      case "putType": {
        const before = { target: yield* currentType(action.type.name), context: null };
        const stored = check ? yield* store.checkType(action.type) : null;
        return { before, after: stored, result: stored };
      }
      case "deleteType": {
        const before = { target: yield* currentType(action.name), context: null };
        if (check) yield* store.checkDeleteType(action.name);
        return { before, after: null, result: { deleted: action.name } };
      }
      case "putTemplate": {
        const target = (yield* store.getTemplate(action.template.name)) ?? null;
        if (check) yield* checkTemplate(yield* store.listTypes, action.template);
        return {
          before: { target, context: { uses: yield* uses } },
          after: action.template,
          result: action.template,
        };
      }
      case "deleteTemplate": {
        const target = (yield* store.getTemplate(action.name)) ?? null;
        return {
          before: { target, context: { uses: yield* uses } },
          after: null,
          result: { deleted: action.name },
        };
      }
    }
  });

  /** Whether the write at the revision a proposal makes carries the proposal's ID. */
  const landed = (record: Stored, action: { readonly id: string }) =>
    record.write === undefined
      ? Effect.succeed(undefined)
      : store
          .getChange(action.id, record.write.rev)
          .pipe(
            Effect.map((change) =>
              change !== undefined && changeIdOf(change.meta) === record.proposal.id
                ? change
                : undefined,
            ),
          );

  /**
   * Applies an approved proposal once. An entity write is conditioned on the reviewed revision;
   * any other change applies only while its target is as reviewed. A write that already landed,
   * before a restart, counts as applied and isn't repeated.
   */
  const apply = Effect.fn("Changes.apply")(function* (
    record: Stored,
  ): Effect.fn.Return<Outcome, unknown> {
    const action = record.proposal.action;
    if (action.kind === "putEntity" || action.kind === "deleteEntity") {
      const options = {
        expectedRev: record.write?.expectedRev ?? 0,
        meta: changeMeta({
          depth: record.sourceEvent === undefined ? 0 : record.sourceEvent.depth + 1,
          ...(record.sourceEvent === undefined ? {} : { sourceEventId: record.sourceEvent.id }),
          changeId: record.proposal.id,
        }),
      };
      const already = yield* landed(record, action);
      if (already !== undefined) {
        return {
          applied: true,
          result:
            action.kind === "putEntity"
              ? { entity: { type: action.type, id: action.id, data: already.after ?? {} } }
              : record.result,
        };
      }
      const written =
        action.kind === "putEntity"
          ? store
              .putEntity(action.type, action.id, action.data, options)
              .pipe(Effect.map((write): Schema.Json => ({ entity: write.after })))
          : store
              .deleteEntity(action.type, action.id, options)
              .pipe(
                Effect.flatMap((deleted) =>
                  deleted === undefined
                    ? Effect.fail(new EntityRevConflict({ message: "The entity is gone" }))
                    : Effect.succeed(record.result),
                ),
              );
      return yield* written.pipe(
        Effect.map((result): Outcome => ({ applied: true, result })),
        Effect.catchTags({
          // A write retried after an answer was lost may have landed before this attempt.
          EntityRevConflict: () =>
            Effect.map(landed(record, action), (change): Outcome =>
              change === undefined
                ? { applied: false, reason: "conflict", message: STALE }
                : { applied: true, result: record.result },
            ),
          InvalidEntity: (error) =>
            Effect.succeed<Outcome>({ applied: false, reason: "refused", message: error.message }),
        }),
      );
    }
    const current = (yield* look(action, false)).before.target;
    if (same(current, record.after)) {
      return { applied: true, result: record.result };
    }
    if (!same(current, record.before.target)) {
      return { applied: false, reason: "conflict", message: STALE };
    }
    switch (action.kind) {
      case "putType":
        return { applied: true, result: yield* store.putType(action.type) };
      case "deleteType":
        yield* store.deleteType(action.name);
        return { applied: true, result: record.result };
      case "putTemplate":
        return { applied: true, result: yield* store.putTemplate(action.template) };
      case "deleteTemplate":
        yield* store.deleteTemplate(action.name);
        return { applied: true, result: record.result };
    }
  });

  const write = (record: Stored) => storage.put(`proposal:${record.proposal.id}`, record);
  const read = (value: unknown) => Schema.decodeUnknownEffect(Record)(value);
  const records = Effect.gen(function* () {
    return yield* Effect.forEach(yield* storage.list("proposal:"), read);
  });

  const terminal = Effect.fn("Changes.terminal")(function* (
    record: Stored,
    receipt: ChangeDecision,
  ) {
    yield* write({ ...record, state: "terminal", receipt });
    return receipt;
  });

  /**
   * Settles an approved (`applying`) proposal. A person's that can't apply goes back to pending
   * and says why; they can cancel it or prepare another. An authorized command is checked again
   * against newer data, since it was never reviewed against a particular version; one that can
   * never apply is settled as cancelled with the reason, so it stops being retried here.
   */
  const settle = Effect.fn("Changes.settle")(function* (
    initial: Stored,
  ): Effect.fn.Return<ChangeDecision, unknown> {
    let record = initial;
    for (let attempt = 1; ; attempt++) {
      const outcome = yield* apply(record);
      if (outcome.applied) {
        return yield* terminal(record, { status: "applied", result: outcome.result });
      }
      if (record.sourceEvent === undefined) {
        yield* write({ ...record, state: "pending" });
        return yield* fail(outcome.message);
      }
      const again =
        outcome.reason === "conflict" && attempt < COMMAND_ATTEMPTS
          ? yield* look(record.proposal.action, true).pipe(
              Effect.catchIf(
                (error) => error instanceof InvalidEntity || error instanceof ChangeError,
                () => Effect.succeed(undefined),
              ),
            )
          : undefined;
      if (again === undefined) {
        if (outcome.reason === "conflict" && attempt >= COMMAND_ATTEMPTS) {
          return yield* fail(outcome.message);
        }
        return yield* terminal(record, {
          status: "cancelled",
          result: { error: outcome.reason === "refused" ? outcome.message : STALE },
        });
      }
      record = {
        ...record,
        before: again.before,
        after: again.after,
        result: again.result,
        ...(again.write === undefined ? {} : { write: again.write }),
      };
      yield* write(record);
    }
  });

  /**
   * Settles approved proposals a restart interrupted, oldest first. Every entity write is
   * conditioned on its revision, so one that fails here can't be overwritten by a later one and
   * doesn't hold other changes back; it is tried again next time.
   */
  const recoverAll = Effect.gen(function* () {
    for (const record of yield* records) {
      if (!isCurrent(record) || record.state !== "applying") continue;
      yield* settle(record).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("An approved change couldn't be settled yet", cause).pipe(
            Effect.annotateLogs({ proposalId: record.proposal.id }),
          ),
        ),
      );
    }
  });

  const isStale = (error: unknown) =>
    error instanceof InvalidEntity ||
    error instanceof InvalidTemplate ||
    error instanceof ChangeError;

  return Changes.of({
    prepare: Effect.fn("Changes.prepare")(
      function* (owner: string, input: ChangeAction, requestId?: string, sourceEvent?: Event) {
        const action = yield* Schema.decodeEffect(ChangeAction)(input);
        if (sourceEvent !== undefined && sourceEvent.depth >= MAX_EVENT_DEPTH) {
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
        const preview = yield* look(action, true);
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
            const a = (left ?? {}) as { readonly [key: string]: unknown };
            const b = (right ?? {}) as { readonly [key: string]: unknown };
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
        walk(preview.before.target ?? undefined, preview.after ?? undefined, "");
        const subscribers =
          action.kind === "putEntity"
            ? ((preview.before.context as { readonly subscribers: ReadonlyArray<string> })
                .subscribers ?? [])
            : [];
        const consequences =
          action.kind === "putEntity"
            ? [
                `This edit may start matching saved automations watching ${action.type}: ${subscribers.join(", ") || "none currently subscribed"}.`,
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
                      "This saves a new version of the type in entity-store. Stored entities keep their data and are read in the new version; new runs must fit it.",
                    ]
                  : [
                      deleting
                        ? "New runs of saved automations using this template will fail validation until fixed. Runs already in flight keep their expanded wording."
                        : "New saved runs use this wording. Runs already in flight keep their expanded wording.",
                    ];
        if (action.kind === "putTemplate" || action.kind === "deleteTemplate") {
          const used = (preview.before.context as { readonly uses: Schema.Json }).uses as Array<{
            id: string;
            saved?: string[];
            draft?: string[];
            unchecked?: string;
          }>;
          for (const item of used) {
            if (item.unchecked)
              consequences.push(`${item.id}: impact could not be checked (${item.unchecked}).`);
            else {
              if (item.saved?.includes(name))
                consequences.push(`${item.id}: saved workflow uses this template.`);
              if (item.draft?.includes(name))
                consequences.push(
                  `${item.id}: draft uses this template; it must be checked before saving.`,
                );
            }
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
          version: 2,
          owner,
          ...(requestId === undefined ? {} : { requestId }),
          ...(sourceEvent === undefined
            ? {}
            : { sourceEvent: yield* Schema.decodeEffect(Event)(sourceEvent) }),
          proposal,
          before: preview.before,
          after: preview.after,
          ...(preview.write === undefined ? {} : { write: preview.write }),
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
        if (!isCurrent(record)) return yield* fail(LEGACY);
        if (record.state === "applying") return yield* settle(record);
        if (!approved) return yield* terminal(record, { status: "cancelled", result: null });
        yield* recoverAll;
        const fresh = yield* look(record.proposal.action, false).pipe(
          Effect.catchIf(isStale, () => Effect.succeed(undefined)),
        );
        if (
          fresh === undefined ||
          !same(fresh.before, record.before) ||
          !same(fresh.write, record.write)
        )
          return yield* fail(STALE);
        const applying: Stored = { ...record, state: "applying" };
        yield* write(applying);
        return yield* settle(applying);
      },
      (effect) => lock.withPermit(effect),
    ),
  });
});
