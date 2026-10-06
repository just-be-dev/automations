/** Manual and assistant confirmations share the persisted Changes capability. */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Schema from "effect/Schema";
import { ChangeAction } from "../changes/model.ts";
import { Changes } from "../changes/service.ts";
import { RequestIdentity } from "./identity.ts";
import { limitedBody, pathParams, respond } from "./response.ts";

export const changeRoutes = HttpRouter.addAll(
  [
    HttpRouter.route(
      "POST",
      "/",
      respond(
        Effect.gen(function* () {
          const { action } = yield* limitedBody(Schema.Struct({ action: ChangeAction }));
          const identity = yield* RequestIdentity;
          const changes = yield* Changes;
          return yield* changes.prepare(identity.email ?? "local", action);
        }),
      ),
    ),
    HttpRouter.route(
      "POST",
      "/:id/decision",
      respond(
        Effect.gen(function* () {
          const { id } = yield* pathParams(Schema.Struct({ id: Schema.String }));
          const { approved } = yield* limitedBody(Schema.Struct({ approved: Schema.Boolean }));
          const identity = yield* RequestIdentity;
          const changes = yield* Changes;
          return yield* changes.decide(identity.email ?? "local", id, approved);
        }),
      ),
    ),
  ],
  { prefix: "/api/changes" },
);
