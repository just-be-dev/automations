/** Serves the studio's MCP server over stateless HTTP with origin checks, body limits, and JSON-only responses. */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { RequestIdentity } from "./identity.ts";
import {
  answerMcp,
  httpMcpCaller,
  jsonRpcError,
  jsonRpcErrors,
  StudioToolHandlers,
} from "./mcp-server.ts";
import { checkBodySize, json } from "./response.ts";

/** Stateless Streamable HTTP: JSON responses only, with no optional GET stream. */
const mcp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // NOTE: MCP servers must refuse browser origins other than their own (DNS rebinding).
  const origin = request.headers["origin"];
  if (origin !== undefined && origin !== new URL(request.url, "http://studio").origin) {
    return json(jsonRpcError(null, jsonRpcErrors.invalidRequest, "Origin not allowed"), 403);
  }
  const message = yield* checkBodySize.pipe(Effect.andThen(request.json), Effect.option);
  if (message._tag === "None") {
    return json(jsonRpcError(null, jsonRpcErrors.parse, "Expected a JSON body under 32 KB"), 400);
  }
  const { email } = yield* RequestIdentity;
  const answer = yield* answerMcp(message.value).pipe(
    Effect.provide(StudioToolHandlers.pipe(Layer.provide(httpMcpCaller(email)))),
  );
  return answer === undefined ? HttpServerResponse.empty({ status: 202 }) : json(answer);
});

// NOTE: a "*" route would claim POST too, and the router rejects a second POST handler.
export const mcpRoutes = HttpRouter.addAll([
  HttpRouter.route("POST", "/api/mcp", mcp),
  ...(["GET", "PUT", "PATCH", "DELETE"] as const).map((method) =>
    HttpRouter.route(
      method,
      "/api/mcp",
      HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } }),
    ),
  ),
]);
