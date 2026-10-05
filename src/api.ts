import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { openAutomationIndex } from "./automation-index.ts";
import Automation from "./automation.ts";

const MAX_BODY_BYTES = 32_000;

const AutomationParams = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/)),
});
const RunParams = Schema.Struct({ ...AutomationParams.fields, runId: Schema.String });
const EventParams = Schema.Struct({ ...AutomationParams.fields, event: Schema.String });
const ChatBody = Schema.Struct({ message: Schema.optionalKey(Schema.String) });
const StartBody = Schema.Struct({ input: Schema.optionalKey(Schema.Unknown) });

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
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

const automationParams = HttpRouter.schemaPathParams(AutomationParams).pipe(
  Effect.mapError(() => new NotFound({ message: "Not found" })),
);

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

    const routes = HttpRouter.addAll(
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
              const { id, runId } = yield* HttpRouter.schemaPathParams(RunParams).pipe(
                Effect.mapError(() => new NotFound({ message: "Not found" })),
              );
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
          "/:id/chat",
          respond(
            Effect.gen(function* () {
              const { id } = yield* automationParams;
              const body = yield* limitedBody(ChatBody);
              const draft = yield* automations.getByName(id).chat(body.message ?? "");
              yield* index.record(id, draft.workflow.name).pipe(Effect.ignore);
              return draft;
            }),
          ),
        ),
        HttpRouter.route(
          "POST",
          "/:id/save",
          respond(
            Effect.gen(function* () {
              const { id } = yield* automationParams;
              const saved = yield* automations.getByName(id).save();
              yield* index.record(id, saved.saved.name).pipe(Effect.ignore);
              return saved;
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
              return yield* automations.getByName(id).start(body.input ?? null);
            }),
            202,
          ),
        ),
        HttpRouter.route(
          "POST",
          "/:id/events/:event",
          respond(
            Effect.gen(function* () {
              const { id, event } = yield* HttpRouter.schemaPathParams(EventParams).pipe(
                Effect.mapError(() => new NotFound({ message: "Not found" })),
              );
              const body = yield* limitedBody(StartBody);
              return yield* automations.getByName(id).start(body.input ?? null, event);
            }),
            202,
          ),
        ),
      ],
      { prefix: "/api/automations" },
    );

    const notFound = HttpRouter.add("*", "*", json({ error: "Not found" }, 404));

    return {
      fetch: yield* HttpRouter.toHttpEffect(Layer.mergeAll(routes, notFound)),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
