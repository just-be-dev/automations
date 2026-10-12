/** Exposes entity-store tools and answers MCP JSON-RPC messages statelessly, without sessions or background handlers. */
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { messageOf } from "../error.ts";
import {
  EntityData,
  EntityId,
  EntityName,
  EntityRecord,
  EntityType,
  InvalidEntity,
  Role,
} from "../entities/model.ts";
import { EntityStore, EntityStoreError } from "../entities/store.ts";
import { ChangeDecision, ChangeProposal } from "../changes/model.ts";
import { ChangeError, Changes } from "../changes/service.ts";
import { RequestIdentity } from "./identity.ts";

/**
 * The entity store as an MCP server, served at `/api/mcp` by `src/http/mcp.ts`. The tools are an Effect
 * `Toolkit`; this module also answers the JSON-RPC messages of MCP's Streamable HTTP transport.
 *
 * It is stateless on purpose: Workers keep nothing between requests, so `initialize` assigns no
 * session and every message is answered on its own. It answers with JSON, never SSE, and sends no
 * requests or notifications of its own.
 */

export class EntityNotFound extends Schema.TaggedError<EntityNotFound>()("EntityNotFound", {
  message: Schema.String,
}) {}

const EntityFailure = Schema.Union([EntityStoreError, InvalidEntity, EntityNotFound, ChangeError]);

const TypeParams = Schema.Struct({ type: EntityName });
const EntityParams = Schema.Struct({ type: EntityName, id: EntityId });

/**
 * Lets a client retry a proposing call without preparing a second proposal. The coordinator
 * returns the proposal it already prepared for this person under the same ID.
 */
const ProposalRequest = {
  requestId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
      description:
        "Optional. A unique ID for this proposal, such as a UUID. Repeating the call with the same requestId returns the same proposal instead of preparing another.",
    }),
  ),
};
const requestIdOf = (requestId: string | undefined) =>
  requestId === undefined ? undefined : `mcp:${requestId}`;

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
    "Proposes creating or replacing an entity type; does not write. Review the returned proposal with the person, then use decide_change. Names are snake_case. Stored entities aren't rewritten.",
  parameters: Schema.Struct({ type: EntityType, ...ProposalRequest }),
  success: ChangeProposal,
  failure: EntityFailure,
}).annotate(Tool.Title, "Define entity type");

const DeleteEntityType = Tool.make("delete_entity_type", {
  description:
    "Proposes deleting an entity type; does not delete. Review the proposal with the person, then use decide_change. Fails while the type has dependants.",
  parameters: Schema.Struct({ ...TypeParams.fields, ...ProposalRequest }),
  success: ChangeProposal,
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Delete entity type")
  .annotate(Tool.Destructive, true);

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
    "Proposes creating or updating an entity, merging data; null clears a field. Does not write or start runs. Review the proposal with the person, then use decide_change. Approval may start matching saved automations.",
  parameters: Schema.Struct({ ...EntityParams.fields, data: EntityData, ...ProposalRequest }),
  success: ChangeProposal,
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Create or update entity")
  .annotate(Tool.OpenWorld, true);

const DeleteEntity = Tool.make("delete_entity", {
  description:
    "Proposes deleting an entity; does not delete. Review the proposal with the person, then use decide_change. Approval may start automations triggered by entity.deleted. Fails while a role lists the entity as a member.",
  parameters: Schema.Struct({ ...EntityParams.fields, ...ProposalRequest }),
  success: ChangeProposal,
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Delete entity")
  .annotate(Tool.Destructive, true);

const ListRoles = Tool.make("list_roles", {
  description:
    "Lists the roles. A role is a named group of people who approve the operations an automation asks first about. Its members are entities, by type and ID, whose type has a text field named `email`.",
  success: Schema.Struct({ roles: Schema.Array(Role) }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "List roles")
  .annotate(Tool.Readonly, true);

const DefineRole = Tool.make("define_role", {
  description:
    "Creates a role or replaces one with the same name. Names are snake_case. Every member must be a stored entity with an email: its type has a text field named `email`. Approval tasks already open keep the members they had.",
  parameters: Schema.Struct({ role: Role }),
  success: Schema.Struct({ role: Role }),
  failure: EntityFailure,
})
  .annotate(Tool.Title, "Define role")
  .annotate(Tool.Idempotent, true);

const DecideChange = Tool.make("decide_change", {
  description:
    "Confirm or cancel a proposal for this person. Only approve after the person has explicitly agreed to the exact proposal. Returns the persisted terminal receipt, not a new proposal.",
  parameters: Schema.Struct({ proposalId: Schema.String, approved: Schema.Boolean }),
  success: ChangeDecision,
  failure: ChangeError,
}).annotate(Tool.Idempotent, true);

export const EntityTools = Toolkit.make(
  ListEntityTypes,
  DefineEntityType,
  DeleteEntityType,
  ListEntities,
  GetEntity,
  PutEntity,
  DeleteEntity,
  ListRoles,
  DefineRole,
  DecideChange,
);

const notFound = (type: string, id: string) =>
  new EntityNotFound({ message: `No ${type} with ID ${id}` });

/** The tools' handlers, over the request's `EntityStore`. */
export const EntityToolHandlers = EntityTools.toLayer(
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const changes = yield* Changes;
    const identity = yield* RequestIdentity;
    const owner = identity.email ?? "local";
    const changeFailure = (error: unknown) => new ChangeError({ message: messageOf(error) });
    return EntityTools.of({
      list_entity_types: () => Effect.map(store.listTypes, (types) => ({ types })),
      define_entity_type: ({ type, requestId }) =>
        changes
          .prepare(owner, { kind: "putType", type }, requestIdOf(requestId))
          .pipe(Effect.mapError(changeFailure)),
      delete_entity_type: ({ type, requestId }) =>
        changes
          .prepare(owner, { kind: "deleteType", name: type }, requestIdOf(requestId))
          .pipe(Effect.mapError(changeFailure)),
      list_entities: ({ type }) =>
        Effect.map(store.listEntities(type), (entities) => ({ entities })),
      get_entity: ({ type, id }) =>
        Effect.flatMap(store.getEntity(type, id), (entity) =>
          entity === undefined ? Effect.fail(notFound(type, id)) : Effect.succeed({ entity }),
        ),
      put_entity: ({ type, id, data, requestId }) =>
        changes
          .prepare(owner, { kind: "putEntity", type, id, data }, requestIdOf(requestId))
          .pipe(Effect.mapError(changeFailure)),
      delete_entity: ({ type, id, requestId }) =>
        changes
          .prepare(owner, { kind: "deleteEntity", type, id }, requestIdOf(requestId))
          .pipe(Effect.mapError(changeFailure)),
      list_roles: () => Effect.map(store.listRoles, (roles) => ({ roles })),
      define_role: ({ role }) => Effect.map(store.putRole(role), (stored) => ({ role: stored })),
      decide_change: ({ proposalId, approved }) =>
        changes.decide(owner, proposalId, approved).pipe(Effect.mapError(changeFailure)),
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
  "Reads the studio's entity store and proposes changes to entity types and records. Mutation tools return proposals without committing. Show the exact details and consequences to the person and use decide_change only after explicit confirmation or cancellation. Role writes remain direct. A role's members can't be deleted or lose their email.";

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
      Effect.succeed({
        content: [{ type: "text", text: messageOf(error, "The tool failed") }],
        isError: true,
      }),
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
