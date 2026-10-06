/** Routes role and template management and reports which listed automations use a template. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AutomationIndex } from "../automation/index.ts";
import type { TemplateUsage } from "../automation/model.ts";
import { Automations } from "../automation/service.ts";
import { EntityName, Role } from "../entities/model.ts";
import { EntityStore } from "../entities/store.ts";
import { Template } from "../entities/templates.ts";
import { messageOf } from "../error.ts";
import { BadRequest, limitedBody, NotFound, pathParams, respond } from "./response.ts";

const RoleParams = Schema.Struct({ role: EntityName });
const TemplateParams = Schema.Struct({ name: EntityName });

/**
 * Asks every listed automation which templates its saved workflow and draft use. A deleted
 * template's users are still found, so they can be fixed.
 */
const templateUsage = Effect.fn("Catalog.templateUsage")(function* (name: string) {
  const index = yield* AutomationIndex;
  const automations = yield* Automations;
  const listed = yield* index.list;
  const answers = yield* Effect.forEach(
    listed,
    (automation) =>
      automations
        .get(automation.id)
        .templateUses()
        .pipe(
          Effect.map((uses) => ({
            ...automation,
            saved: uses.saved.includes(name),
            draft: uses.draft.includes(name),
          })),
          // One unreachable automation must not hide the others.
          Effect.catchCause((cause) =>
            Effect.fail({ ...automation, error: messageOf(Cause.squash(cause)) }),
          ),
          Effect.result,
        ),
    { concurrency: 8 },
  );
  const usage: TemplateUsage = {
    automations: answers.flatMap((answer) =>
      Result.isSuccess(answer) && (answer.success.saved || answer.success.draft)
        ? [answer.success]
        : [],
    ),
    unchecked: answers.flatMap((answer) => (Result.isFailure(answer) ? [answer.failure] : [])),
  };
  return usage;
});

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
      HttpRouter.route(
        "GET",
        "/:name/automations",
        respond(
          Effect.gen(function* () {
            const { name } = yield* pathParams(TemplateParams);
            return yield* templateUsage(name);
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
