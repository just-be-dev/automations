/** Reads entity types and records. Mutations belong to the shared Changes capability. */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Schema from "effect/Schema";
import { EntityId, EntityName } from "../entities/model.ts";
import { EntityStore } from "../entities/store.ts";
import { NotFound, pathParams, respond } from "./response.ts";

const TypeParams = Schema.Struct({ type: EntityName });
const EntityParams = Schema.Struct({ type: EntityName, entityId: EntityId });

export const entityRoutes = HttpRouter.addAll(
  [
    HttpRouter.route("GET", "/types", respond(EntityStore.use((entities) => entities.listTypes))),
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
  ],
  { prefix: "/api/entities" },
);
