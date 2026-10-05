import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./api.ts";

/** Machine access for smoke tests: send `CF-Access-Client-Id` / `CF-Access-Client-Secret`. */
export const TestClient = Cloudflare.Access.ServiceToken("TestClient", { duration: "720h" });

/**
 * The Foldkit UI. Static assets are served directly; `/api/*` runs the Cloudflare edge entry, which forwards
 * to the Api Worker over a service binding. Deployed stages sit behind Cloudflare Access, which
 * admits members of the Cloudflare account and the test service token. `alchemy dev` runs locally
 * without Access.
 */
export const Studio = Cloudflare.Website.Foldkit(
  "Studio",
  Effect.gen(function* () {
    const dev = yield* Alchemy.ALCHEMY_DEV.pipe(Effect.orDie);
    const access = dev
      ? undefined
      : yield* Effect.map(TestClient, (token) => ({
          policies: [
            {
              decision: "allow" as const,
              include: [{ cloudflareAccountMember: token.accountId }],
            },
            {
              decision: "non_identity" as const,
              include: [{ serviceToken: token.serviceTokenId }],
            },
          ],
        }));
    return {
      main: "src/platform/cloudflare/edge.ts",
      env: { API: Api },
      assets: { runWorkerFirst: ["/api/*"] },
      compatibility: { date: "2026-10-04" },
      access,
    };
  }),
);

export type StudioEnv = Cloudflare.InferEnv<typeof Studio>;

/**
 * Deploys keep state in Alchemy's Cloudflare-hosted store. `alchemy dev` keeps it in this
 * checkout's `.alchemy/`, next to the local D1 and Durable Object data it describes. With shared
 * state, a fresh checkout or worktree inherited a record of applied migrations and started with an
 * empty, unmigrated database.
 */
const state = Layer.unwrap(
  Effect.gen(function* () {
    const dev = yield* Alchemy.ALCHEMY_DEV.pipe(Effect.orDie);
    return dev ? Alchemy.localState() : Cloudflare.state();
  }),
);

export default Alchemy.Stack(
  "automations",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    yield* Api;
    const studio = yield* Studio;
    return { url: studio.url };
  }),
);
