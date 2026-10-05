import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { openAutomationIndex } from "./automation-index.ts";
import Automation from "./automation.ts";
import { HumanResponse } from "./interpreter.ts";
import { EntityData, EntityName, EntityType } from "./entities.ts";
import { EntityStore, type EntityChange } from "./entity-store.ts";
import { EntityStoreD1 } from "./entity-store-d1.ts";
import type { AutomationOverview } from "./workflow.ts";

const MAX_BODY_BYTES = 32_000;

const AutomationParams = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/)),
});
const RunParams = Schema.Struct({ ...AutomationParams.fields, runId: Schema.String });
const TaskParams = Schema.Struct({ ...RunParams.fields, stepId: Schema.String });
const EntityId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.@-]{1,120}$/));
const TypeParams = Schema.Struct({ type: EntityName });
const EntityParams = Schema.Struct({ type: EntityName, entityId: EntityId });
const ChatBody = Schema.Struct({ message: Schema.optionalKey(Schema.String) });
const StartBody = Schema.Struct({ subject: Schema.optionalKey(EntityId) });
const EntityBody = Schema.Struct({ data: EntityData });

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String,
}) {}

class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()("PayloadTooLarge", {
  message: Schema.String,
}) {}

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

// Durable Object RPC failures arrive as plain objects, so read their message structurally.
const messageOf = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : "Unexpected error";

const notFound = () => new NotFound({ message: "Not found" });

const pathParams = <A, I extends Readonly<Record<string, string | undefined>>>(
  schema: Schema.Codec<A, I>,
) => HttpRouter.schemaPathParams(schema).pipe(Effect.mapError(notFound));

const automationParams = pathParams(AutomationParams);

const limitedBody = <A, I, RD>(schema: Schema.Codec<A, I, RD>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
      return yield* new PayloadTooLarge({ message: "Payload too large" });
    }
    return yield* HttpServerRequest.schemaBodyJson(schema);
  });

const respond = <A, E, R>(effect: Effect.Effect<A, E, R>, status = 200) =>
  effect.pipe(
    Effect.map((body) => json(body, status)),
    Effect.catch((error: unknown) =>
      Effect.succeed(
        error instanceof NotFound
          ? json({ error: error.message }, 404)
          : error instanceof PayloadTooLarge
            ? json({ error: error.message }, 413)
            : json({ error: messageOf(error) }, 400),
      ),
    ),
  );

/** The studio's `/api` surface. Reached only through the Studio Worker's service binding. */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    compatibility: { date: "2026-10-04" },
    // NOTE: no public URL. Cloudflare Access guards the Studio Worker, which forwards `/api/*` here.
    workersDev: false,
  },
  Effect.gen(function* () {
    const automations = yield* Automation;
    // The index only feeds the studio's list, so a failure to update it must not fail the request.
    const index = yield* openAutomationIndex;
    // The entity store's D1 layer, provided per request.
    const entityStore = yield* EntityStoreD1;

    const automationRoutes = HttpRouter.addAll(
      [
        HttpRouter.route("GET", "/", respond(index.list())),
        HttpRouter.route(
          "GET",
          "/:id",
          respond(
            Effect.gen(function* () {
              const { id } = yield* automationParams;
              const automation = yield* automations.getByName(id).inspectWorkflow();
              const workflow = automation.draft ?? automation.saved;
              if (workflow !== undefined) {
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
              return yield* automations.getByName(id).respond(runId, stepId, body);
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
              yield* index.record(id, saved.saved.name).pipe(Effect.ignore);
              return saved;
            }).pipe(Effect.provide(entityStore)),
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
    );

    /** Tells every automation subscribed to the entity's type about the change. */
    const notifySubscribers = Effect.fn("Api.notifySubscribers")(function* (change: EntityChange) {
      const entities = yield* EntityStore;
      const subscribers = yield* entities.subscribers(change.after.type);
      return yield* Effect.forEach(subscribers, (automationId) =>
        automations
          .getByName(automationId)
          .entityChanged(change.before, change.after)
          .pipe(
            Effect.map(({ runId }) => ({ automation: automationId, runId, error: null })),
            Effect.catch((error: unknown) =>
              Effect.succeed({ automation: automationId, runId: null, error: messageOf(error) }),
            ),
          ),
      );
    });

    const withEntities = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      respond(effect.pipe(Effect.provide(entityStore)));

    const entityRoutes = HttpRouter.addAll(
      [
        HttpRouter.route(
          "GET",
          "/types",
          withEntities(EntityStore.use((entities) => entities.listTypes)),
        ),
        HttpRouter.route(
          "PUT",
          "/types/:type",
          withEntities(
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
          "GET",
          "/:type",
          withEntities(
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
          withEntities(
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
          withEntities(
            Effect.gen(function* () {
              const { type, entityId } = yield* pathParams(EntityParams);
              const body = yield* limitedBody(EntityBody);
              const entities = yield* EntityStore;
              const change = yield* entities.putEntity(type, entityId, body.data);
              const triggered = yield* notifySubscribers(change);
              return { entity: change.after, triggered };
            }),
          ),
        ),
      ],
      { prefix: "/api/entities" },
    );

    // Each automation is its own Durable Object, so the overview asks every listed one. One that
    // can't answer is listed with its error instead of failing the whole overview.
    const overviewRoute = HttpRouter.add(
      "GET",
      "/api/overview",
      respond(
        Effect.gen(function* () {
          const listed = yield* index.list();
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
    );

    const fallback = HttpRouter.add("*", "*", json({ error: "Not found" }, 404));

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(automationRoutes, entityRoutes, overviewRoute, fallback),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
