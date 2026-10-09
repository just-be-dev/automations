/** Composes the platform-independent API routes and their fallback response. */
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { automationRoutes } from "./automations.ts";
import { catalogRoutes } from "./catalog.ts";
import { entityRoutes } from "./entities.ts";
import { mcpRoutes } from "./mcp.ts";
import { json } from "./response.ts";
import { assistantRoutes } from "./assistant.ts";
import { changeRoutes } from "./changes.ts";
import { transcriptionRoutes } from "./transcription.ts";
import { eventRoutes } from "./events.ts";

/** Routes use application services; hosting and request-scoped implementations belong to the host. */
export const apiRoutes = Layer.mergeAll(
  automationRoutes,
  entityRoutes,
  catalogRoutes,
  mcpRoutes,
  assistantRoutes,
  changeRoutes,
  transcriptionRoutes,
  eventRoutes,
  HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
);
