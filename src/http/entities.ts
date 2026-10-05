import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Schema from "effect/Schema";
import { EntityData, EntityId, EntityName, EntityType } from "../entities/model.ts";
import { EntityStore } from "../entities/store.ts";
import { EntitySubscribers } from "../entities/subscribers.ts";
import { BadRequest, limitedBody, NotFound, pathParams, respond } from "./response.ts";

const TypeParams = Schema.Struct({ type: EntityName });
const EntityParams = Schema.Struct({ type: EntityName, entityId: EntityId });
const EntityBody = Schema.Struct({ data: EntityData });

export const entityRoutes = HttpRouter.addAll(
  [
    HttpRouter.route("GET", "/types", respond(EntityStore.use((entities) => entities.listTypes))),
    HttpRouter.route(
      "PUT",
      "/types/:type",
      respond(
        Effect.gen(function* () {
          const { type } = yield* pathParams(TypeParams);
          const body = yield* limitedBody(EntityType);
          if (body.name !== type) {
            return yield* new BadRequest({ message: "The type's name must match the URL" });
          }
          const entities = yield* EntityStore;
          return yield* entities.putType(body);
        }),
      ),
    ),
    HttpRouter.route(
      "DELETE",
      "/types/:type",
      respond(
        Effect.gen(function* () {
          const { type } = yield* pathParams(TypeParams);
          const entities = yield* EntityStore;
          yield* entities.deleteType(type);
          return { deleted: type };
        }),
      ),
    ),
    HttpRouter.route(
      "GET",
      "/:type",
      respond(
        Effect.gen(function* () {
          const { type } = yield* pathParams(TypeParams);
          const entities = yield* EntityStore;
          return yield* entities.listEntities(type);
        }),
      ),
    ),
    HttpRouter.route(
      "GET",
      "/:type/:entityId",
      respond(
        Effect.gen(function* () {
          const { type, entityId } = yield* pathParams(EntityParams);
          const entities = yield* EntityStore;
          const found = yield* entities.getEntity(type, entityId);
          if (found === undefined) {
            return yield* new NotFound({ message: "Entity not found" });
          }
          return found;
        }),
      ),
    ),
    // Merges the fields over the stored entity, then starts any automations it triggers.
    HttpRouter.route(
      "PUT",
      "/:type/:entityId",
      respond(
        Effect.gen(function* () {
          const { type, entityId } = yield* pathParams(EntityParams);
          const body = yield* limitedBody(EntityBody);
          const entities = yield* EntityStore;
          const change = yield* entities.putEntity(type, entityId, body.data);
          const subscribers = yield* EntitySubscribers;
          const triggered = yield* subscribers.notify(change);
          return { entity: change.after, triggered };
        }),
      ),
    ),
    // Deleting starts no runs.
    HttpRouter.route(
      "DELETE",
      "/:type/:entityId",
      respond(
        Effect.gen(function* () {
          const { type, entityId } = yield* pathParams(EntityParams);
          const entities = yield* EntityStore;
          const deleted = yield* entities.deleteEntity(type, entityId);
          if (deleted === undefined) {
            return yield* new NotFound({ message: "Entity not found" });
          }
          return { deleted };
        }),
      ),
    ),
  ],
  { prefix: "/api/entities" },
);
