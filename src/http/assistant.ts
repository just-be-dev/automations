/** Mount this layer directly: routes already include /api/assistant. */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Schema from "effect/Schema";
import { QuestionsAnswer } from "../ai/ask-question/question.ts";
import { PageContext } from "../assistant/model.ts";
import { Assistants } from "../assistant/service.ts";
import { archiveThread, AssistantThreads, deleteThread } from "../assistant/threads.ts";
import { RequestIdentity } from "./identity.ts";
import { limitedBody, pathParams, respond } from "./response.ts";

// The same check as the StudioAssistant's identity, so a session the object would refuse gets a 400 here.
const Params = Schema.Struct({ sessionId: Schema.String.check(Schema.isUUID(4)) });
const ownerOf = Effect.map(RequestIdentity, ({ email }) => email ?? "local");
const client = Effect.gen(function* () {
  const { sessionId } = yield* pathParams(Params);
  const assistants = yield* Assistants;
  return assistants.get(yield* ownerOf, sessionId);
});
export const assistantRoutes = HttpRouter.addAll(
  [
    HttpRouter.route(
      "GET",
      "/",
      respond(
        Effect.gen(function* () {
          const threads = yield* AssistantThreads;
          return { threads: yield* threads.list(yield* ownerOf) };
        }),
      ),
    ),
    HttpRouter.route(
      "GET",
      "/:sessionId",
      respond(client.pipe(Effect.flatMap((c) => c.inspect()))),
    ),
    HttpRouter.route(
      "DELETE",
      "/:sessionId",
      respond(
        Effect.gen(function* () {
          const { sessionId } = yield* pathParams(Params);
          return yield* deleteThread(yield* ownerOf, sessionId);
        }),
      ),
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
    HttpRouter.route(
      "POST",
      "/:sessionId/stop",
      respond(client.pipe(Effect.flatMap((c) => c.stop()))),
    ),
    HttpRouter.route(
      "POST",
      "/:sessionId/clear",
      respond(client.pipe(Effect.flatMap((c) => c.clear()))),
    ),
    HttpRouter.route(
      "POST",
      "/:sessionId/archive",
      respond(
        Effect.gen(function* () {
          const { sessionId } = yield* pathParams(Params);
          const body = yield* limitedBody(Schema.Struct({ archived: Schema.Boolean }));
          return yield* archiveThread(yield* ownerOf, sessionId, body.archived);
        }),
      ),
    ),
  ],
  { prefix: "/api/assistant" },
);
