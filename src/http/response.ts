import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

const MAX_BODY_BYTES = 32_000;

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String,
}) {}

class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()("PayloadTooLarge", {
  message: Schema.String,
}) {}

export const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

// Durable Object RPC failures arrive as plain objects, so read their message structurally.
export const messageOf = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : "Unexpected error";

export const pathParams = <A, I extends Readonly<Record<string, string | undefined>>>(
  schema: Schema.Codec<A, I>,
) =>
  HttpRouter.schemaPathParams(schema).pipe(
    Effect.mapError(() => new NotFound({ message: "Not found" })),
  );

export const checkBodySize = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    return yield* new PayloadTooLarge({ message: "Payload too large" });
  }
});

/** Cloudflare Access's authenticated email. Local dev and service-token requests have none. */
export const accessEmail = HttpServerRequest.HttpServerRequest.pipe(
  Effect.map((request) => {
    const email = request.headers["cf-access-authenticated-user-email"];
    return email === undefined || email === "" ? undefined : email;
  }),
);

export const limitedBody = <A, I, RD>(schema: Schema.Codec<A, I, RD>) =>
  Effect.andThen(checkBodySize, HttpServerRequest.schemaBodyJson(schema));

export const respond = <A, E, R>(effect: Effect.Effect<A, E, R>, status = 200) =>
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
