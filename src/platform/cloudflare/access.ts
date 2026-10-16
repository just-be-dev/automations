import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RequestIdentity } from "../../http/identity.ts";

/**
 * Studio's Access guard authenticates this header. Dev and service-token requests have none.
 * `localUser` stands in for it under `alchemy dev`, where Access is off: it is the address
 * `DEV_USER_EMAIL` gives, and `api.ts` passes one only when `localDevelopment` holds.
 */
export const accessIdentity = (localUser: Option.Option<string>) =>
  Layer.effect(
    RequestIdentity,
    HttpServerRequest.HttpServerRequest.pipe(
      Effect.map((request) => {
        const header = request.headers["cf-access-authenticated-user-email"];
        const email =
          header === undefined || header === "" ? Option.getOrUndefined(localUser) : header;
        return RequestIdentity.of({ email });
      }),
    ),
  );
