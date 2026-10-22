/**
 * The entity-store RPC contract: the values its `EntityStoreRpc` entrypoint returns, decoded, and
 * the `EntityStoreApi` service that calls it. entity-store is the system of record for entity
 * types and entities (roles included); automations reaches it over a service binding, which the
 * platform layer supplies as an `EntityStoreRpc`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { messageOf } from "../error.ts";

/**
 * A failure entity-store reported, or a call that never got an answer. `code` is entity-store's
 * HTTP error code (`EntityNotFound`, `RevConflict`, `ValidationFailed`, `TypeInUse`, …), or
 * `Unavailable` when the binding failed and `InvalidResponse` when its answer didn't decode.
 */
export class EntityStoreApiError extends Schema.TaggedError<EntityStoreApiError>()(
  "EntityStoreApiError",
  {
    code: Schema.String,
    message: Schema.String,
    details: Schema.Record(Schema.String, Schema.Json),
  },
) {}

/** A schema node, kept whole so a new version can carry what automations doesn't read. */
export const SchemaNode = Schema.Record(Schema.String, Schema.Json);
export type SchemaNode = typeof SchemaNode.Type;

/** An entity schema's root. `title` names the field that is an entity's display name. */
export const StoreSchema = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  fields: Schema.Record(Schema.String, SchemaNode),
});
export type StoreSchema = typeof StoreSchema.Type;

export const LensOp = Schema.Record(Schema.String, Schema.Json);
export const Lens = Schema.Struct({ ops: Schema.Array(LensOp) });
export type Lens = typeof Lens.Type;

export const TypeSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  latestVersion: Schema.Int,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type TypeSummary = typeof TypeSummary.Type;

export const VersionInfo = Schema.Struct({
  type: Schema.String,
  version: Schema.Int,
  schema: StoreSchema,
  lens: Schema.optionalKey(Lens),
  note: Schema.String,
  createdAt: Schema.Finite,
});
export type VersionInfo = typeof VersionInfo.Type;

export const TypeInfo = Schema.Struct({
  ...TypeSummary.fields,
  versions: Schema.Array(VersionInfo),
});
export type TypeInfo = typeof TypeInfo.Type;

/** What a lens check found. Only `ok` is read; the rest goes into error messages. */
export const LensReport = Schema.Struct({ ok: Schema.Boolean });
const LensCheck = Schema.Struct({ from: Schema.Int, to: Schema.Int, report: Schema.Json });

export const StoredEntity = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  version: Schema.Int,
  storedVersion: Schema.Int,
  rev: Schema.Int,
  data: Schema.Json,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type StoredEntity = typeof StoredEntity.Type;

export const EntityPage = Schema.Struct({
  items: Schema.Array(StoredEntity),
  failures: Schema.Array(Schema.Struct({ id: Schema.String, error: Schema.String })),
  nextCursor: Schema.optionalKey(Schema.String),
});
export type EntityPage = typeof EntityPage.Type;

export const Op = Schema.Literals(["create", "replace", "patch", "delete"]);
export type Op = typeof Op.Type;

/** What a change queue message carries, and what `listChanges` lists. */
export const ChangeEvent = Schema.Struct({
  v: Schema.Literal(1),
  seq: Schema.Int,
  type: Schema.String,
  id: Schema.String,
  rev: Schema.Int,
  op: Op,
  meta: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
  createdAt: Schema.Finite,
});
export type ChangeEvent = typeof ChangeEvent.Type;

/** A change with its data at `rev - 1` and at `rev`, lensed to the type's latest version. */
export const Change = Schema.Struct({
  ...ChangeEvent.fields,
  version: Schema.Int,
  before: Schema.Json,
  after: Schema.Json,
});
export type Change = typeof Change.Type;

/** `meta` on every write: entity-store stores it with the change and never reads it. */
export type WriteMeta = Readonly<Record<string, Schema.Json>>;

/**
 * The entrypoint as the binding exposes it. Every method resolves to a `Result`, never throwing
 * for a domain error; its value is decoded by `makeEntityStoreApi`.
 */
export interface EntityStoreRpc {
  readonly listTypes: () => Promise<unknown>;
  readonly getType: (name: string) => Promise<unknown>;
  readonly createType: (input: {
    readonly name: string;
    readonly description?: string;
    readonly schema: StoreSchema;
  }) => Promise<unknown>;
  readonly checkVersion: (
    type: string,
    input: { readonly schema: StoreSchema; readonly lens: Lens },
  ) => Promise<unknown>;
  readonly createVersion: (
    type: string,
    input: {
      readonly schema: StoreSchema;
      readonly lens: Lens;
      readonly note?: string;
      readonly force?: boolean;
    },
  ) => Promise<unknown>;
  readonly deleteType: (name: string) => Promise<unknown>;
  readonly listEntities: (
    type: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ) => Promise<unknown>;
  readonly getEntity: (id: string, options?: { readonly rev?: number }) => Promise<unknown>;
  readonly upsertEntity: (
    type: string,
    id: string,
    input: {
      readonly patch: Readonly<Record<string, Schema.Json>>;
      readonly expectedRev?: number;
      readonly meta?: WriteMeta;
    },
  ) => Promise<unknown>;
  readonly deleteEntity: (
    id: string,
    options?: { readonly expectedRev?: number; readonly meta?: WriteMeta },
  ) => Promise<unknown>;
  readonly getChange: (id: string, rev: number) => Promise<unknown>;
}

const RpcFailure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Record(Schema.String, Schema.Json),
});
const RpcSuccess = Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json });
const RpcResult = Schema.Union([RpcSuccess, RpcFailure]);

const failure = (code: string, message: string, details: Record<string, Schema.Json> = {}) =>
  new EntityStoreApiError({ code, message, details });

/** One call: the binding's promise, its `Result`, and its value, each checked. */
const call = <A, I>(
  method: string,
  schema: Schema.Codec<A, I>,
  invoke: () => Promise<unknown>,
): Effect.Effect<A, EntityStoreApiError> =>
  Effect.gen(function* () {
    const answer = yield* Effect.tryPromise({
      try: invoke,
      catch: (error) =>
        failure("Unavailable", `entity-store ${method} failed: ${messageOf(error, "no answer")}`),
    });
    const result = yield* Schema.decodeUnknownEffect(RpcResult)(answer).pipe(
      Effect.mapError(() =>
        failure("InvalidResponse", `entity-store ${method} answered with something else`),
      ),
    );
    if (!result.ok) {
      const { code, message, ...details } = result.error;
      return yield* failure(
        typeof code === "string" ? code : "StorageFailure",
        typeof message === "string" ? message : `entity-store ${method} failed`,
        details,
      );
    }
    return yield* Schema.decodeUnknownEffect(schema)(result.value).pipe(
      Effect.mapError((error) =>
        failure("InvalidResponse", `entity-store ${method} answered with ${error.message}`),
      ),
    );
  }).pipe(Effect.withSpan(`EntityStoreApi.${method}`));

const makeApi = (rpc: EntityStoreRpc) => ({
  listTypes: call("listTypes", Schema.Array(TypeSummary), () => rpc.listTypes()),
  getType: (name: string) => call("getType", TypeInfo, () => rpc.getType(name)),
  createType: (input: Parameters<EntityStoreRpc["createType"]>[0]) =>
    call("createType", TypeInfo, () => rpc.createType(input)),
  checkVersion: (type: string, input: Parameters<EntityStoreRpc["checkVersion"]>[1]) =>
    call("checkVersion", LensCheck, () => rpc.checkVersion(type, input)),
  createVersion: (type: string, input: Parameters<EntityStoreRpc["createVersion"]>[1]) =>
    call("createVersion", Schema.Struct({ version: VersionInfo }), () =>
      rpc.createVersion(type, input),
    ),
  deleteType: (name: string) =>
    call("deleteType", Schema.Struct({ name: Schema.String }), () => rpc.deleteType(name)),
  listEntities: (type: string, options?: Parameters<EntityStoreRpc["listEntities"]>[1]) =>
    call("listEntities", EntityPage, () => rpc.listEntities(type, options)),
  getEntity: (id: string) => call("getEntity", StoredEntity, () => rpc.getEntity(id)),
  upsertEntity: (type: string, id: string, input: Parameters<EntityStoreRpc["upsertEntity"]>[2]) =>
    call("upsertEntity", Schema.Struct({ entity: StoredEntity, created: Schema.Boolean }), () =>
      rpc.upsertEntity(type, id, input),
    ),
  deleteEntity: (id: string, options?: Parameters<EntityStoreRpc["deleteEntity"]>[1]) =>
    call("deleteEntity", Schema.Struct({ id: Schema.String, rev: Schema.Int }), () =>
      rpc.deleteEntity(id, options),
    ),
  getChange: (id: string, rev: number) => call("getChange", Change, () => rpc.getChange(id, rev)),
});

/** entity-store's operations as Effects, failing with `EntityStoreApiError`. */
export class EntityStoreApi extends Context.Service<EntityStoreApi, ReturnType<typeof makeApi>>()(
  "automations/EntityStoreApi",
) {}

export const makeEntityStoreApi = (rpc: EntityStoreRpc) => EntityStoreApi.of(makeApi(rpc));
