/** Declares the Access-protected studio, private API binding, and local-versus-deployed Alchemy state store. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import Api from "./api.ts";
import Channels from "./channels.ts";
import { hubPaths } from "./hub.ts";
import { hubBindings } from "./hub-bindings.ts";
import { SLACK_INTERACTIVITY_PATH } from "../../channels/slack-interactivity.ts";

/** The stage served on {@link PRODUCTION_DOMAIN}; other deployed stages stay on workers.dev. */
const PRODUCTION_STAGE = "prod";
/** The studio's hostname on `prod`, the one the platform's app rail links to. */
export const PRODUCTION_DOMAIN = "automations.just-be.dev";
const PRODUCTION_ZONE = "just-be.dev";

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
    const production = !dev && (yield* Alchemy.Stage) === PRODUCTION_STAGE;
    return {
      // The zone's `*.just-be.dev/*` route (another project) redirects unknown subdomains, and
      // zone routes run before Custom Domains: the domain gives DNS and a certificate, and the
      // more specific route runs the Studio.
      domain: production ? PRODUCTION_DOMAIN : undefined,
      routes: production
        ? [{ pattern: `${PRODUCTION_DOMAIN}/*`, zoneName: PRODUCTION_ZONE }]
        : undefined,
      main: "src/platform/cloudflare/edge.ts",
      env: { API: Api, ...hubBindings(dev) },
      assets: { runWorkerFirst: ["/api/*", ...hubPaths] },
      compatibility: { date: "2026-10-04" },
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
        traces: { enabled: true, headSamplingRate: 1, persist: true },
      },
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
    // The public Slack webhooks need both secrets at deploy; without them Slack stays off.
    const slack = yield* Config.all([
      Config.Redacted("SLACK_SIGNING_SECRET"),
      Config.Redacted("SLACK_BOT_TOKEN"),
    ]).pipe(Config.option);
    const channels = Option.isSome(slack) ? yield* Channels : undefined;
    return {
      url: studio.url,
      slackWebhookUrl: channels
        ? Output.map(channels.url, (url) => url && `${url}/integrations/slack/webhook`)
        : undefined,
      slackInteractivityUrl: channels
        ? Output.map(channels.url, (url) => url && `${url}${SLACK_INTERACTIVITY_PATH}`)
        : undefined,
    };
  }),
);
