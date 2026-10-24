/**
 * The Studio's Access application on deployed stages, and the service tokens it admits. Only the
 * stack imports this module (through stack.ts and api.ts); `alchemy dev` declares neither.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { hubToken } from "./hub-frame.ts";

/** Machine access for smoke tests: send `CF-Access-Client-Id` / `CF-Access-Client-Secret`. */
export const TestClient = Cloudflare.Access.ServiceToken("TestClient", { duration: "720h" });

/**
 * Members of the Cloudflare account, the test service token, and hub prod's `PlatformToken`
 * (hub-frame.ts), whose requests act for the person its signed identity token names and for no one
 * otherwise (access.ts). The Studio enrolls in it, and the Api checks its JWTs' audience.
 */
// NOTE: The application keeps the logical id the Studio's dedicated `access` form gave it
// (`Studio/Access`), so declaring it updates the existing one in place. Both the Studio and the Api
// yield it; Alchemy registers a resource once per logical id. The Api binds its `aud`, as Desk's
// does: a Worker with static assets, like the Studio, gets no `ctx.access` on Cloudflare's edge
// (cloudflare/workers-sdk#15626), and the application's destinations are the Studio's own.
export const StudioAccess = Effect.suspend(() =>
  Effect.gen(function* () {
    const token = yield* TestClient;
    const hub = yield* hubToken(yield* Alchemy.Stage);
    return yield* Cloudflare.Access.Application("Access", {
      type: "self_hosted",
      policies: [
        {
          decision: "allow" as const,
          include: [{ cloudflareAccountMember: token.accountId }],
        },
        {
          decision: "non_identity" as const,
          include: [{ serviceToken: token.serviceTokenId }, { serviceToken: hub.serviceTokenId }],
        },
      ],
    }).pipe(Alchemy.push("Studio"));
  }),
);
