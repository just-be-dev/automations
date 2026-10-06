/** Mount this layer directly: routes already include /api/assistant. */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Schema from "effect/Schema";
import { QuestionsAnswer } from "../ai/ask-question/question.ts";
import { PageContext } from "../assistant/model.ts";
import { Assistants } from "../assistant/service.ts";
import { RequestIdentity } from "./identity.ts";
import { limitedBody, pathParams, respond } from "./response.ts";

const Params = Schema.Struct({
  sessionId: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  ),
});
const client = Effect.gen(function* () {
  const { sessionId } = yield* pathParams(Params);
  const { email } = yield* RequestIdentity;
  const assistants = yield* Assistants;
  return assistants.get(email ?? "local", sessionId);
});
export const assistantRoutes = HttpRouter.addAll(
  [
    HttpRouter.route(
      "GET",
      "/:sessionId",
      respond(client.pipe(Effect.flatMap((c) => c.inspect()))),
    ),
    HttpRouter.route(
      "POST",
      "/:sessionId/chat",
      respond(
        Effect.gen(function* () {
          const c = yield* client;
          const body = yield* limitedBody(
            Schema.Struct({ message: Schema.String, context: PageContext }),
          );
          return yield* c.chat(body.message, body.context);
        }),
      ),
    ),
    HttpRouter.route(
      "POST",
      "/:sessionId/confirmation",
      respond(
        Effect.gen(function* () {
          const c = yield* client;
          const body = yield* limitedBody(
            Schema.Struct({ proposalId: Schema.String, approved: Schema.Boolean }),
          );
          return yield* c.confirm(body.proposalId, body.approved);
        }),
      ),
    ),
    HttpRouter.route(
      "POST",
      "/:sessionId/answers",
      respond(
        Effect.gen(function* () {
          const c = yield* client;
          const body = yield* limitedBody(
            Schema.Struct({ callId: Schema.String, answer: QuestionsAnswer }),
          );
          return yield* c.answer(body.callId, body.answer);
        }),
      ),
    ),
  ],
  { prefix: "/api/assistant" },
);
