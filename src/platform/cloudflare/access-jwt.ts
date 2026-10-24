/**
 * Verifies the JWT Cloudflare Access forwards with every request it admits
 * (`cf-access-jwt-assertion`): RS256, signed by one of the team's keys, issued by the team for the
 * expected application, and unexpired. Plain async code over WebCrypto, with no Alchemy or Effect,
 * because the Studio's edge entry runs it.
 */

/** Access forwards this signed JWT on every request it admits. */
export const accessJwtHeader = "cf-access-jwt-assertion";

// NOTE: The account's Zero Trust team domain, fixed per account. Access signs its JWTs with this
// team's keys, published at `https://<team>/cdn-cgi/access/certs`, and names it as the issuer.
export const accessTeamDomain = "round-bush-6519.cloudflareaccess.com";

/** What a JWT must show: the team that issued it and the application it's for. */
export interface AccessJwtCheck {
  readonly teamDomain: string;
  readonly audience: string;
}

/** The claims this code reads. */
export interface AccessClaims {
  readonly email?: string;
  readonly common_name?: string;
}

/** The team's signing keys by `kid`, or undefined when there is no such key. */
export type SigningKeys = (kid: string) => Promise<CryptoKey | undefined>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fromBase64Url = (part: string): Uint8Array<ArrayBuffer> | undefined => {
  try {
    const base64 = part.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const jsonPart = (part: string): Record<string, unknown> | undefined => {
  const bytes = fromBase64Url(part);
  if (bytes === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

// NOTE: Clock skew between Access and the Worker is small; a minute keeps a just-issued JWT valid.
const leewaySeconds = 60;

/**
 * The JWT's claims when it verifies against `check`, otherwise undefined. Any failure, keys that
 * can't be fetched included, is undefined.
 */
export const verifyAccessJwt = async (
  jwt: string,
  check: AccessJwtCheck,
  keys: SigningKeys,
  nowMillis: number,
): Promise<AccessClaims | undefined> => {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  const [headerPart = "", payloadPart = "", signaturePart = ""] = parts;
  const header = jsonPart(headerPart);
  const claims = jsonPart(payloadPart);
  const signature = fromBase64Url(signaturePart);
  if (header === undefined || claims === undefined || signature === undefined) return undefined;
  if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") return undefined;
  const now = Math.floor(nowMillis / 1000);
  const aud = claims["aud"];
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  const exp = claims["exp"];
  const nbf = claims["nbf"];
  if (
    claims["iss"] !== `https://${check.teamDomain}` ||
    !audiences.includes(check.audience) ||
    typeof exp !== "number" ||
    exp + leewaySeconds <= now ||
    (nbf !== undefined && (typeof nbf !== "number" || nbf - leewaySeconds > now))
  )
    return undefined;
  const key = await keys(header["kid"]).catch(() => undefined);
  if (key === undefined) return undefined;
  const verified = await crypto.subtle
    .verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    )
    .catch(() => false);
  if (!verified) return undefined;
  return claimsOf(claims);
};

const claimsOf = (claims: Record<string, unknown>): AccessClaims => {
  const email = claims["email"];
  const commonName = claims["common_name"];
  return {
    ...(typeof email === "string" ? { email } : {}),
    ...(typeof commonName === "string" ? { common_name: commonName } : {}),
  };
};

/**
 * A JWT's claims read without checking its signature, or undefined when it isn't one. Only for
 * decisions that take something away, or that Access, which put the JWT on the request, has
 * already made: never to admit anyone.
 */
export const unverifiedClaims = (jwt: string): AccessClaims | undefined => {
  const parts = jwt.split(".");
  const claims = parts.length === 3 ? jsonPart(parts[1] ?? "") : undefined;
  return claims === undefined ? undefined : claimsOf(claims);
};

/** Whether claims are a service token's: a client id (`common_name`) and no person's email. */
export const isServiceToken = (claims: AccessClaims): boolean =>
  (claims.common_name ?? "") !== "" && (claims.email ?? "") === "";

/** What a service token's JWT must show besides {@link AccessJwtCheck}: the token's client id. */
export interface ServiceTokenCheck extends AccessJwtCheck {
  readonly clientId: string;
}

/** Whether `jwt` verifies against `check` as the service token with `check.clientId`. */
export const verifyServiceTokenJwt = async (
  jwt: string,
  check: ServiceTokenCheck,
  keys: SigningKeys,
  nowMillis: number,
): Promise<boolean> => {
  if (check.clientId === "") return false;
  const claims = await verifyAccessJwt(jwt, check, keys, nowMillis);
  return claims !== undefined && isServiceToken(claims) && claims.common_name === check.clientId;
};

/** Imports a JWKS answer's RSA keys by `kid`, skipping any that aren't usable. */
export const importSigningKeys = async (jwks: unknown): Promise<ReadonlyMap<string, CryptoKey>> => {
  const raw = isRecord(jwks) && Array.isArray(jwks["keys"]) ? jwks["keys"] : [];
  const pairs = await Promise.all(
    raw.map(async (jwk: unknown) => {
      if (
        !isRecord(jwk) ||
        jwk["kty"] !== "RSA" ||
        typeof jwk["kid"] !== "string" ||
        typeof jwk["n"] !== "string" ||
        typeof jwk["e"] !== "string"
      )
        return [];
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk["n"], e: jwk["e"], alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        return [[jwk["kid"], key] as const];
      } catch {
        return [];
      }
    }),
  );
  return new Map(pairs.flat());
};

// NOTE: Access rotates its signing keys every six weeks and publishes the next one in advance, so
// keys are kept for an hour, and a `kid` not among them refetches at most once a minute.
const keysTtlMillis = 60 * 60_000;
const refetchAfterMillis = 60_000;

/** The team's signing keys from `fetchJwks`, kept for the isolate's lifetime. */
export const cachedSigningKeys = (
  fetchJwks: () => Promise<unknown>,
  now: () => number = Date.now,
): SigningKeys => {
  let cached: { readonly keys: ReadonlyMap<string, CryptoKey>; readonly at: number } | undefined;
  return async (kid) => {
    const age = cached === undefined ? Infinity : now() - cached.at;
    const known = cached?.keys.get(kid);
    if (known !== undefined && age < keysTtlMillis) return known;
    if (cached !== undefined && known === undefined && age < refetchAfterMillis) return undefined;
    try {
      cached = { keys: await importSigningKeys(await fetchJwks()), at: now() };
    } catch {
      return undefined;
    }
    return cached.keys.get(kid);
  };
};

/** The keys of {@link accessTeamDomain}, fetched from its certs endpoint. */
export const teamSigningKeys = cachedSigningKeys(() =>
  fetch(`https://${accessTeamDomain}/cdn-cgi/access/certs`).then((response) =>
    response.ok ? response.json() : Promise.reject(new Error(`certs ${response.status}`)),
  ),
);
