/**
 * The studio agent's thread directory: which threads each person has, their titles, and which are
 * archived. Each thread's conversation stays in its own Durable Object; Cloudflare can't list
 * those, so this directory is what the history view reads.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AssistantThread } from "./model.ts";
import { Assistants } from "./service.ts";

export { AssistantThread } from "./model.ts";

export class AssistantThreadsError extends Schema.TaggedError<AssistantThreadsError>()(
  "AssistantThreadsError",
  { message: Schema.String },
) {}

/** Every operation is scoped to one owner, so a person never sees another's threads. */
export class AssistantThreads extends Context.Service<
  AssistantThreads,
  {
    /** Lists the thread, or moves a listed one to the top and out of the archive. */
    readonly touch: (owner: string, id: string) => Effect.Effect<void, AssistantThreadsError>;
    /** Sets or clears a listed thread's title. A thread that isn't listed stays unlisted. */
    readonly rename: (
      owner: string,
      id: string,
      title: string | undefined,
    ) => Effect.Effect<void, AssistantThreadsError>;
    /** Archives or restores a listed thread without moving it. */
    readonly archive: (
      owner: string,
      id: string,
      archived: boolean,
    ) => Effect.Effect<void, AssistantThreadsError>;
    /** Takes the thread out of the owner's list. A thread that isn't listed stays unlisted. */
    readonly remove: (owner: string, id: string) => Effect.Effect<void, AssistantThreadsError>;
    /** The owner's threads, archived ones included, most recently used first. */
    readonly list: (
      owner: string,
    ) => Effect.Effect<ReadonlyArray<AssistantThread>, AssistantThreadsError>;
  }
>()("automations/AssistantThreads") {}

/** An in-memory directory for tests and evals, empty each time it is built. */
export const layerMemory = Layer.sync(AssistantThreads, () => {
  const threads = new Map<string, AssistantThread & { readonly owner: string }>();
  const key = (owner: string, id: string) => JSON.stringify([owner, id]);
  const modify = (owner: string, id: string, f: (thread: AssistantThread) => AssistantThread) =>
    Effect.sync(() => {
      const current = threads.get(key(owner, id));
      if (current !== undefined) threads.set(key(owner, id), { ...f(current), owner });
    });
  return AssistantThreads.of({
    touch: (owner, id) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Effect.sync(
            () =>
              void threads.set(key(owner, id), {
                ...(threads.get(key(owner, id)) ?? { id, createdAt: now }),
                owner,
                updatedAt: now,
                archived: false,
              }),
          ),
        ),
      ),
    rename: (owner, id, title) =>
      modify(owner, id, ({ title: _title, ...thread }) =>
        title === undefined ? thread : { ...thread, title },
      ),
    archive: (owner, id, archived) => modify(owner, id, (thread) => ({ ...thread, archived })),
    remove: (owner, id) => Effect.sync(() => void threads.delete(key(owner, id))),
    list: (owner) =>
      Effect.sync(() =>
        [...threads.values()]
          .filter((thread) => thread.owner === owner)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(({ owner: _owner, ...thread }) => thread),
      ),
  });
});

/** Archives or restores one of the owner's threads, and resolves with their threads afterwards. */
export const archiveThread = Effect.fn("AssistantThreads.archiveThread")(function* (
  owner: string,
  id: string,
  archived: boolean,
) {
  const threads = yield* AssistantThreads;
  yield* threads.archive(owner, id, archived);
  return { threads: yield* threads.list(owner) };
});

/**
 * Deletes one of the owner's threads: erases its conversation, then takes it out of their list,
 * and resolves with their threads afterwards. A failed erase leaves the thread listed, so deleting
 * it again retries. A later message to the same ID starts a fresh thread and lists it again.
 */
export const deleteThread = Effect.fn("AssistantThreads.deleteThread")(function* (
  owner: string,
  id: string,
) {
  const assistants = yield* Assistants;
  yield* assistants.get(owner, id).clear();
  const threads = yield* AssistantThreads;
  yield* threads.remove(owner, id);
  return { threads: yield* threads.list(owner) };
});
