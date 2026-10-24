import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RequestIdentity } from "../../http/identity.ts";
import {
  accessJwtHeader,
  isServiceToken,
  type ServiceTokenCheck,
  type SigningKeys,
  unverifiedClaims,
  verifyServiceTokenJwt,
} from "./access-jwt.ts";
import { hubIdentityHeader, type HubIdentityVerifier } from "./hub-identity.ts";

/**
 * How the Api recognizes the hub that frames the studio (hub-frame.ts): hub prod's service token,
 * as Access's JWT for the Studio's application shows it, and the identity token the hub signs for
 * this stage (hub-identity.ts).
 */
export type HubAccess = Readonly<{
  check: ServiceTokenCheck;
  keys: SigningKeys;
  verifyIdentity: HubIdentityVerifier;
}>;

const accessEmailHeader = "cf-access-authenticated-user-email";

// NOTE: The person's email comes from the header Access sets for someone it signed in, trusted
// because only the Access-protected Studio Worker reaches the Api. A service token (the test token,
// or the hub's) names no one of its own, so an email header beside its JWT is the client's and never
// counts. The hub (hub.just-be.dev, hub-frame-spike.md §4.4) proxies a person's requests with its
// service token and names the person in `x-hub-identity`, which it signs: that email counts only when
// Access's JWT verifies as hub prod's token for the Studio's application, and the identity token
// verifies for this stage. A hub request whose identity token fails acts for no one. Reading the JWT
// unverified to see that it's a service token only takes the header away.
/**
 * Who a request acts for: the person Access signed in, the person the hub vouches for, or no one.
 * `localUser` stands in under `alchemy dev`, where Access is off: it is the address
 * `DEV_USER_EMAIL` gives, and `api.ts` passes one only when `localDevelopment` holds. `hub` is
 * undefined there, and wherever the hub isn't bound.
 */
export const accessIdentity = (localUser: Option.Option<string>, hub?: HubAccess) =>
  Layer.effect(
    RequestIdentity,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const jwt = request.headers[accessJwtHeader];
      const claims = jwt === undefined ? undefined : unverifiedClaims(jwt);
      if (jwt !== undefined && claims !== undefined && isServiceToken(claims)) {
        const token = request.headers[hubIdentityHeader];
        if (hub === undefined || token === undefined || token === "") {
          return RequestIdentity.of({ email: undefined });
        }
        const now = yield* Clock.currentTimeMillis;
        const fromHub = yield* Effect.tryPromise(() =>
          verifyServiceTokenJwt(jwt, hub.check, hub.keys, now),
        ).pipe(Effect.orElseSucceed(() => false));
        const email = fromHub ? yield* hub.verifyIdentity(token, now) : Option.none<string>();
        return RequestIdentity.of({ email: Option.getOrUndefined(email) });
      }
      const header = request.headers[accessEmailHeader];
      const email =
        header === undefined || header === "" ? Option.getOrUndefined(localUser) : header;
      return RequestIdentity.of({ email });
    }),
  );
