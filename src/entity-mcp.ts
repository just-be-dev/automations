import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  EntityData,
  EntityId,
  EntityName,
  EntityRecord,
  EntityType,
  InvalidEntity,
  Subject,
} from "./entities.ts";
import { EntityStore, EntityStoreError, type EntityChange } from "./entity-store.ts";

/**
 * The entity store as an MCP server, served at `/api/mcp` by `src/api.ts`. The tools are an Effect
 * `Toolkit`; this module also answers the JSON-RPC messages of MCP's Streamable HTTP transport.
 *
 * It is stateless on purpose: Workers keep nothing between requests, so `initialize` assigns no
 * session and every message is answered on its own. It answers with JSON, never SSE, and sends no
 * requests or notifications of its own.
 */

export class EntityNotFound extends Schema.TaggedError<EntityNotFound>()("EntityNotFound", {
  message: Schema.String,
}) {}

const EntityFailure = Schema.Union([EntityStoreError, InvalidEntity, EntityNotFound]);

/** A run an entity write started, or why an automation watching the type couldn't start one. */
export const Triggered = Schema.Struct({
  automation: Schema.String,
  runId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type Triggered = typeof Triggered.Type;

/** Tells the automations watching an entity's type that it changed. Provided by the Api Worker. */
export class EntitySubscribers extends Context.Service<
  EntitySubscribers,
  {
    readonly notify: (
      change: EntityChange,
    ) => Effect.Effect<ReadonlyArray<Triggered>, EntityStoreError, EntityStore>;
  }
>()("automations/EntitySubscribers") {}

const TypeParams = Schema.Struct({ type: EntityName });
const EntityParams = Schema.Struct({ type: EntityName, id: EntityId });

const ListEntityTypes = Tool.make("list_entity_types", {
  description:
    "Lists every entity type with its fields. Field types are text, number, boolean, date (YYYY-MM-DD), datetime (ISO 8601), and ref (another entity's ID, with the target type in `to`). Steps that contact a person read a text field named `email`.",
  success: Schema.Struct({ types: Schema.Array(EntityType) }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "List entity types")
  .annotate(Tool.Readonly, true);

const DefineEntityType = Tool.make("define_entity_type", {
  description:
    "Creates an entity type or replaces one with the same name. Names are snake_case. `title` names the field shown as the entity's name, and a ref field names its target type in `to`. Stored entities aren't rewritten.",
  parameters: Schema.Struct({ type: EntityType }),
  success: Schema.Struct({ type: EntityType }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Define entity type")
  .annotate(Tool.Idempotent, true);

const DeleteEntityType = Tool.make("delete_entity_type", {
  description:
    "Deletes an entity type. Fails while it has entities, another type or a template slot refers to it, or a saved automation watches it.",
  parameters: TypeParams,
  success: Schema.Struct({ deleted: EntityName }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Delete entity type")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

const ListEntities = Tool.make("list_entities", {
  description: "Lists the entities of a type.",
  parameters: TypeParams,
  success: Schema.Struct({ entities: Schema.Array(EntityRecord) }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "List entities")
  .annotate(Tool.Readonly, true);

const GetEntity = Tool.make("get_entity", {
  description: "Reads one entity by type and ID.",
  parameters: EntityParams,
  success: Schema.Struct({ entity: EntityRecord }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Get entity")
  .annotate(Tool.Readonly, true);

const PutEntity = Tool.make("put_entity", {
  description:
    "Creates an entity or updates one, merging `data` over its stored fields; `null` clears a field. Like any entity write, it starts the saved automations whose trigger matches the change, and returns them in `triggered`.",
  parameters: Schema.Struct({ ...EntityParams.fields, data: EntityData }),
  success: Schema.Struct({ entity: Subject, triggered: Schema.Array(Triggered) }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Create or update entity")
  .annotate(Tool.OpenWorld, true);

const DeleteEntity = Tool.make("delete_entity", {
  description: "Deletes an entity. Starts no automations.",
  parameters: EntityParams,
  success: Schema.Struct({ deleted: EntityRecord }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Delete entity")
  .annotate(Tool.Destructive, true);

export const EntityTools = Toolkit.make(
  ListEntityTypes,
  DefineEntityType,
  DeleteEntityType,
  ListEntities,
  GetEntity,
  PutEntity,
  DeleteEntity,
);

const notFound = (type: string, id: string) =>
  new EntityNotFound({ message: `No ${type} with ID ${id}` });

/** The tools' handlers, over the request's `EntityStore`. */
export const EntityToolHandlers = EntityTools.toLayer(
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const subscribers = yield* EntitySubscribers;
    return EntityTools.of({
      list_entity_types: () => Effect.map(store.listTypes, (types) => ({ types })),
      define_entity_type: ({ type }) =>
        Effect.map(store.putType(type), (stored) => ({ type: stored })),
      delete_entity_type: ({ type }) => Effect.as(store.deleteType(type), { deleted: type }),
      list_entities: ({ type }) =>
        Effect.map(store.listEntities(type), (entities) => ({ entities })),
      get_entity: ({ type, id }) =>
        Effect.flatMap(store.getEntity(type, id), (entity) =>
          entity === undefined ? Effect.fail(notFound(type, id)) : Effect.succeed({ entity }),
        ),
      put_entity: ({ type, id, data }) =>
        Effect.gen(function* () {
          const change = yield* store.putEntity(type, id, data);
          const triggered = yield* subscribers
            .notify(change)
            .pipe(Effect.provideService(EntityStore, store));
          return { entity: change.after, triggered };
        }),
      delete_entity: ({ type, id }) =>
        Effect.flatMap(store.deleteEntity(type, id), (deleted) =>
          deleted === undefined ? Effect.fail(notFound(type, id)) : Effect.succeed({ deleted }),
        ),
    });
  }),
);

// JSON-RPC

/** The MCP revisions this server speaks. They differ in what it doesn't use (sessions, SSE). */
export const protocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

const RequestId = Schema.Union([Schema.String, Schema.Finite]);
type RequestId = typeof RequestId.Type;

const JsonRpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: RequestId,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const JsonRpcNotification = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.String,
});

const JsonRpcClientResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.NullOr(RequestId),
});

const InitializeParams = Schema.Struct({ protocolVersion: Schema.String });
const CallToolParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

export const jsonRpcErrors = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;

export type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: RequestId; readonly result: unknown }
  | {
      readonly jsonrpc: "2.0";
      readonly id: RequestId | null;
      readonly error: { readonly code: number; readonly message: string };
    };

export const jsonRpcError = (
  id: RequestId | null,
  code: number,
  message: string,
): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

const instructions =
  "Reads and writes the automations studio's entity store: entity types (schemas) and the entities stored under them. Writing an entity with put_entity starts the saved automations that watch its type, the same as the HTTP API does.";

const describeTool = (tool: Tool.Any) => ({
  name: tool.name,
  title: Option.getOrUndefined(Context.getOption(tool.annotations, Tool.Title)),
  description: Tool.getDescription(tool),
  inputSchema: Tool.getJsonSchema(tool),
  outputSchema: Tool.getJsonSchemaFromSchema(tool.successSchema),
  annotations: {
    readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
    destructiveHint: Context.get(tool.annotations, Tool.Destructive),
    idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
    openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
  },
});

const messageOf = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : "The tool failed";

const toolText = (value: unknown) => ({ type: "text", text: JSON.stringify(value) });

const callTool = Effect.fn("EntityMcp.callTool")(function* (name: string, args: unknown) {
  const tools = yield* EntityTools;
  // NOTE: `handle` is typed by tool name; a name from the wire is checked by `handle` itself,
  // which fails with `ToolNotFoundError` for one the toolkit lacks.
  const handle = tools.handle as (
    name: string,
    params: unknown,
  ) => Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>, unknown>, unknown>;
  return yield* handle(name, args).pipe(
    Effect.flatMap(Stream.runLast),
    Effect.flatMap(Effect.fromOption),
    Effect.map((result) => ({
      content: [toolText(result.encodedResult)],
      structuredContent: result.encodedResult,
      isError: false,
    })),
    Effect.catch((error: unknown) =>
      Effect.succeed({ content: [{ type: "text", text: messageOf(error) }], isError: true }),
    ),
  );
});

const answerRequest = Effect.fn("EntityMcp.answerRequest")(function* (
  request: typeof JsonRpcRequest.Type,
) {
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: request.id, result });
  const invalidParams = () =>
    jsonRpcError(request.id, jsonRpcErrors.invalidParams, `Invalid params for ${request.method}`);
  switch (request.method) {
    case "initialize": {
      const params = Schema.decodeUnknownOption(InitializeParams)(request.params);
      if (Option.isNone(params)) {
        return invalidParams();
      }
      const requested = params.value.protocolVersion;
      return reply({
        protocolVersion:
          protocolVersions.find((version) => version === requested) ?? protocolVersions[0],
        capabilities: { tools: {} },
        serverInfo: { name: "automations-entity-store", title: "Entity store", version: "0.1.0" },
        instructions,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: Object.values(EntityTools.tools).map(describeTool) });
    case "tools/call": {
      const params = Schema.decodeUnknownOption(CallToolParams)(request.params);
      if (Option.isNone(params)) {
        return invalidParams();
      }
      return reply(yield* callTool(params.value.name, params.value.arguments ?? {}));
    }
    default:
      return jsonRpcError(
        request.id,
        jsonRpcErrors.methodNotFound,
        `Unknown method ${request.method}`,
      );
  }
});

/**
 * Answers one decoded JSON-RPC message. Notifications and responses get no answer (`undefined`,
 * sent as HTTP 202). Batches aren't supported: MCP dropped them after 2025-03-26.
 */
export const answerMcp = Effect.fn("EntityMcp.answer")(function* (message: unknown) {
  const request = Schema.decodeUnknownOption(JsonRpcRequest)(message);
  if (Option.isSome(request)) {
    return yield* answerRequest(request.value);
  }
  if (
    Schema.is(JsonRpcNotification)(message) ||
    (Schema.is(JsonRpcClientResponse)(message) && !Array.isArray(message))
  ) {
    return undefined;
  }
  return jsonRpcError(null, jsonRpcErrors.invalidRequest, "Expected one JSON-RPC 2.0 message");
});
