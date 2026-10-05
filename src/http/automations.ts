import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type Automation from "../automation/durable-object.ts";
import { AutomationIndex } from "../automation/index.ts";
import type { AutomationOverview } from "../automation/model.ts";
import { EntityId } from "../entities/model.ts";
import { EntityStore } from "../entities/store.ts";
import { HumanResponse } from "../workflow/interpreter.ts";
import { Permissions } from "../workflow/model.ts";
import { accessEmail, limitedBody, messageOf, NotFound, pathParams, respond } from "./response.ts";

const AutomationParams = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/)),
});
const RunParams = Schema.Struct({ ...AutomationParams.fields, runId: Schema.String });
const TaskParams = Schema.Struct({ ...RunParams.fields, stepId: Schema.String });
const ChatBody = Schema.Struct({ message: Schema.optionalKey(Schema.String) });
const StartBody = Schema.Struct({ subject: Schema.optionalKey(EntityId) });
const PermissionsBody = Schema.Struct({ permissions: Permissions });
const automationParams = pathParams(AutomationParams);

/** The host binds the Durable Object namespace; handlers use the request's store and directory. */
export const automationRoutes = (automations: Effect.Success<typeof Automation>) =>
  Layer.merge(
    HttpRouter.addAll(
      [
        HttpRouter.route("GET", "/", respond(AutomationIndex.use((index) => index.list))),
        HttpRouter.route(
          "GET",
          "/:id",
          respond(
            Effect.gen(function* () {
              const { id } = yield* automationParams;
              const automation = yield* automations.getByName(id).inspectWorkflow();
              const workflow = automation.draft ?? automation.saved;
              if (workflow !== undefined) {
                const index = yield* AutomationIndex;
                yield* index.recordIfMissing(id, workflow.name).pipe(Effect.ignore);
              }
              return automation;
            }),
          ),
        ),
        HttpRouter.route(
          "GET",
          "/:id/runs/:runId",
          respond(
            Effect.gen(function* () {
              const { id, runId } = yield* pathParams(RunParams);
              const run = yield* automations.getByName(id).run(runId);
              if (run === undefined) {
                return yield* new NotFound({ message: "Run not found" });
              }
              return run;
            }),
          ),
        ),
        HttpRouter.route(
          "POST",
          "/:id/runs/:runId/tasks/:stepId",
          respond(
            Effect.gen(function* () {
              const { id, runId, stepId } = yield* pathParams(TaskParams);
              const body = yield* limitedBody(HumanResponse);
              const responder = yield* accessEmail;
              return yield* automations.getByName(id).respond(runId, stepId, body, responder);
            }),
          ),
        ),
        HttpRouter.route(
          "POST",
          "/:id/chat",
          respond(
            Effect.gen(function* () {
              const { id } = yield* automationParams;
              const body = yield* limitedBody(ChatBody);
              return yield* automations.getByName(id).chat(id, body.message ?? "");
            }),
            202,
          ),
        ),
        HttpRouter.route(
          "POST",
          "/:id/save",
          respond(
            Effect.gen(function* () {
              const { id } = yield* automationParams;
              const saved = yield* automations.getByName(id).save();
              const trigger = saved.saved.trigger;
              const entities = yield* EntityStore;
              yield* entities.subscribe(id, trigger.kind === "entity" ? trigger.entity : undefined);
              const index = yield* AutomationIndex;
              yield* index.record(id, saved.saved.name).pipe(Effect.ignore);
              return saved;
            }),
          ),
        ),
        HttpRouter.route(
          "POST",
          "/:id/permissions",
          respond(
            Effect.gen(function* () {
              const { id } = yield* automationParams;
              const body = yield* limitedBody(PermissionsBody);
              return yield* automations.getByName(id).setPermissions(body.permissions);
            }),
          ),
        ),
        HttpRouter.route(
          "POST",
          "/:id/start",
          respond(
            Effect.gen(function* () {
              const { id } = yield* automationParams;
              const body = yield* limitedBody(StartBody);
              return yield* automations.getByName(id).start(body.subject);
            }),
            202,
          ),
        ),
      ],
      { prefix: "/api/automations" },
    ),
    HttpRouter.add(
      "GET",
      "/api/overview",
      respond(
        Effect.gen(function* () {
          const index = yield* AutomationIndex;
          const listed = yield* index.list;
          return yield* Effect.forEach(
            listed,
            (automation) =>
              automations
                .getByName(automation.id)
                .overview()
                .pipe(
                  Effect.map((status): AutomationOverview => ({ ...automation, ...status })),
                  // NOTE: the stub types `overview` as infallible, so an unreachable object is a defect.
                  Effect.catchCause((cause) =>
                    Effect.succeed<AutomationOverview>({
                      ...automation,
                      activeRuns: [],
                      error: messageOf(Cause.squash(cause)),
                    }),
                  ),
                ),
            { concurrency: 8 },
          );
        }),
      ),
    ),
  );
