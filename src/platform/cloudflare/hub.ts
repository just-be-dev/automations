/**
 * The hub shell: the platform's app rail and assistant, served by the agents project (stack `cfp`,
 * docs/hub-shell.md there) and loaded on this studio's page from `/_hub/shell.js`. The Studio
 * Worker forwards `/_hub/*` to agents' `Embed` Worker, and `/_hub/api/*` to agents' API over RPC
 * (`platformFetch`) with the email Access admitted, so the assistant acts for the same person.
 *
 * Every deployed stage binds agents' prod, which owns the assistant (`hub-bindings.ts`); `alchemy
 * dev` binds nothing and the page simply has no shell.
 */
// NOTE: The edge imports this module at runtime, so it must not import Alchemy: the bindings live
// in hub-bindings.ts, which only the stack imports.
import {
  accessJwtHeader,
  accessTeamDomain,
  type SigningKeys,
  teamSigningKeys,
  verifyAccessJwt,
} from "./access-jwt.ts";

/** The paths the Studio Worker runs first for the shell. */
export const hubPaths = ["/_hub", "/_hub/*"];

const HUB = "/_hub";
const HUB_API = `${HUB}/api/`;

interface Fetcher {
  readonly fetch: (request: Request) => Promise<Response>;
}
interface PlatformApi {
  readonly platformFetch: (request: Request, email: string | null) => Promise<Response>;
}

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" &&
  value !== null &&
  "fetch" in value &&
  typeof value.fetch === "function";

const isPlatformApi = (value: unknown): value is PlatformApi =>
  typeof value === "object" &&
  value !== null &&
  "platformFetch" in value &&
  typeof value.platformFetch === "function";

const unbound = () => new Response("The hub shell isn't available here.", { status: 404 });

const accessEmailHeader = "cf-access-authenticated-user-email";

/**
 * The person Access admitted, or null. Access sets the email header for a person it signed in,
 * but the Studio's application also admits the test service token, whose requests carry no email
 * of Access's: a header sent alongside it would be the client's. So the header counts only when
 * Access's JWT verifies (the team's signature, `audience`, unexpired) and names the same email.
 * `audience` is the admitting application's, from `ctx.access`; without one, nobody is admitted.
 */
export const admittedEmail = async (
  request: Request,
  audience: string | undefined,
  keys: SigningKeys = teamSigningKeys,
  now: number = Date.now(),
): Promise<string | null> => {
  const header = request.headers.get(accessEmailHeader)?.trim() ?? "";
  const jwt = request.headers.get(accessJwtHeader);
  if (header === "" || jwt === null || audience === undefined || audience === "") return null;
  const claims = await verifyAccessJwt(jwt, { teamDomain: accessTeamDomain, audience }, keys, now);
  const email = claims?.email?.trim() ?? "";
  return email !== "" && email.toLowerCase() === header.toLowerCase() ? header : null;
};

/** Whether `url` is the shell's. */
export const isHubPath = (url: URL) => url.pathname === HUB || url.pathname.startsWith(`${HUB}/`);

/** Whether `url` is the assistant's API, the only shell path that acts for someone. */
export const isHubApiPath = (url: URL) => url.pathname.startsWith(HUB_API);

/**
 * Forwards a shell request to agents. Only call it for {@link isHubPath} URLs. `email` is the
 * person the assistant acts for: the one {@link admittedEmail} found, or null, which the
 * assistant refuses.
 */
export const forwardToHub = (
  request: Request,
  url: URL,
  env: Readonly<Record<string, unknown>>,
  email: string | null,
): Promise<Response> => {
  if (isHubApiPath(url)) {
    const api = env["HUB_API"];
    if (!isPlatformApi(api)) return Promise.resolve(unbound());
    // The API's own path: the prefix dropped, the query kept.
    const forwarded = `${url.origin}${url.pathname.slice(HUB.length)}${url.search}`;
    return api.platformFetch(new Request(forwarded, request), email);
  }
  const embed = env["HUB_EMBED"];
  return isFetcher(embed) ? embed.fetch(request) : Promise.resolve(unbound());
};
