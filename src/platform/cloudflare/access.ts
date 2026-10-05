import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import { RequestIdentity } from "../../http/identity.ts";

/** Studio's Access guard authenticates this header. Dev and service-token requests have none. */
export const accessIdentity = Layer.effect(
  RequestIdentity,
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.map((request) => {
      const email = request.headers["cf-access-authenticated-user-email"];
      return RequestIdentity.of({ email: email === "" ? undefined : email });
    }),
  ),
);
