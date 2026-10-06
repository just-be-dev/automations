import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { EntityName, Role } from "../entities/model.ts";
import { EntityStore } from "../entities/store.ts";
import { Template } from "../entities/templates.ts";
import { BadRequest, limitedBody, NotFound, pathParams, respond } from "./response.ts";

const RoleParams = Schema.Struct({ role: EntityName });
const TemplateParams = Schema.Struct({ name: EntityName });

/** Roles and approved wording available to the planner and new runs. */
export const catalogRoutes = Layer.merge(
  HttpRouter.addAll(
    [
      HttpRouter.route("GET", "/", respond(EntityStore.use((entities) => entities.listRoles))),
      HttpRouter.route(
        "PUT",
        "/:role",
        respond(
          Effect.gen(function* () {
            const { role } = yield* pathParams(RoleParams);
            const body = yield* limitedBody(Role);
            if (body.name !== role) {
              return yield* new BadRequest({ message: "The role's name must match the URL" });
            }
            const entities = yield* EntityStore;
            return yield* entities.putRole(body);
          }),
        ),
      ),
    ],
    { prefix: "/api/roles" },
  ),
  HttpRouter.addAll(
    [
      HttpRouter.route("GET", "/", respond(EntityStore.use((entities) => entities.listTemplates))),
      HttpRouter.route(
        "GET",
        "/:name",
        respond(
          Effect.gen(function* () {
            const { name } = yield* pathParams(TemplateParams);
            const entities = yield* EntityStore;
            const found = yield* entities.getTemplate(name);
            if (found === undefined) {
              return yield* new NotFound({ message: "Template not found" });
            }
            return found;
          }),
        ),
      ),
      // Saved workflows pick up replacement wording on their next run.
      HttpRouter.route(
        "PUT",
        "/:name",
        respond(
          Effect.gen(function* () {
            const { name } = yield* pathParams(TemplateParams);
            const body = yield* limitedBody(Template);
            if (body.name !== name) {
              return yield* new BadRequest({ message: "The template's name must match the URL" });
            }
            const entities = yield* EntityStore;
            return yield* entities.putTemplate(body);
          }),
        ),
      ),
      HttpRouter.route(
        "DELETE",
        "/:name",
        respond(
          Effect.gen(function* () {
            const { name } = yield* pathParams(TemplateParams);
            const entities = yield* EntityStore;
            yield* entities.deleteTemplate(name);
            return { ok: true };
          }),
        ),
      ),
    ],
    { prefix: "/api/templates" },
  ),
);
