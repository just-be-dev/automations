/**
 * Routes that exist only in local development, such as resuming a waiting run now, and says
 * whether they do.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Schema from "effect/Schema";
import { LocalDevelopment } from "../automation/local-development.ts";
import { Automations } from "../automation/service.ts";
import { EntityStoreApi } from "../entities/entity-store-api.ts";
import { EntityId, EntityName } from "../entities/model.ts";
import { RunParams } from "./automations.ts";
import { limitedBody, NotFound, pathParams, respond } from "./response.ts";

const WaitParams = Schema.Struct({ ...RunParams.fields, stepId: Schema.String });
const EntityParams = Schema.Struct({ type: EntityName, id: EntityId });
const Write = Schema.Struct({
  patch: Schema.Record(Schema.String, Schema.Json),
  meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

/** Outside local development these routes answer like any unknown route. */
const onlyLocally = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    if (!(yield* LocalDevelopment)) {
      return yield* new NotFound({ message: "Not found" });
    }
    return yield* effect;
  });

export const developmentRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/dev",
    respond(
      Effect.gen(function* () {
        return { local: yield* LocalDevelopment };
      }),
    ),
  ),
  // Fires the clock a waiting wait step sleeps on, so a demo needn't wait days.
  HttpRouter.route(
    "POST",
    "/api/automations/:id/runs/:runId/waits/:stepId/resume",
    respond(
      onlyLocally(
        Effect.gen(function* () {
          const { id, runId, stepId } = yield* pathParams(WaitParams);
          const automations = yield* Automations;
          return yield* automations.get(id).resumeNow(runId, stepId);
        }),
      ),
      202,
    ),
  ),
  // Writes to the local entity-store directly, as an edit made in entity-store itself would be:
  // none of automations' checks, and its change reaches automations through the change queue.
  HttpRouter.route(
    "PUT",
    "/api/dev/entity-store/:type/:id",
    respond(
      onlyLocally(
        Effect.gen(function* () {
          const { type, id } = yield* pathParams(EntityParams);
          const { patch, meta } = yield* limitedBody(Write);
          const api = yield* EntityStoreApi;
          return yield* api.upsertEntity(type, id, {
            patch,
            ...(meta === undefined ? {} : { meta }),
          });
        }),
      ),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/dev/entity-store/:type/:id",
    respond(
      onlyLocally(
        Effect.gen(function* () {
          const { id } = yield* pathParams(EntityParams);
          const api = yield* EntityStoreApi;
          return yield* api.deleteEntity(id);
        }),
      ),
    ),
  ),
]);
