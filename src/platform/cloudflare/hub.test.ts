/** Checks who the hub shell's forwarding says Access admitted, and that the edge's imports stay off Alchemy. */
import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { accessJwtHeader, accessTeamDomain, cachedSigningKeys } from "./access-jwt.ts";
import { admittedEmail, forwardToHub } from "./hub.ts";

const audience = "studio-aud";
const now = 1_800_000_000_000;

const keyPair = () =>
  crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
const part = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

const sign = async (key: CryptoKey, claims: Record<string, unknown>, kid = "k1", alg = "RS256") => {
  const unsigned = `${part({ alg, kid })}.${part(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
};

const person = (email = "ada@just-be.dev") => ({
  iss: `https://${accessTeamDomain}`,
  aud: [audience],
  exp: now / 1000 + 300,
  nbf: now / 1000 - 10,
  email,
});

const request = (headers: Record<string, string>) =>
  new Request("https://automations.just-be.dev/_hub/api/threads", { headers });

describe("admittedEmail", async () => {
  const team = await keyPair();
  const other = await keyPair();
  const keys = async (kid: string) => (kid === "k1" ? team.publicKey : undefined);
  const admitted = (headers: Record<string, string>, aud: string | undefined = audience) =>
    admittedEmail(request(headers), aud, keys, now);

  test("is the header's email when Access's verified JWT names the same person", async () => {
    const jwt = await sign(team.privateKey, person("Ada@just-be.dev"));
    expect(
      await admitted({
        "cf-access-authenticated-user-email": "ada@just-be.dev",
        [accessJwtHeader]: jwt,
      }),
    ).toBe("ada@just-be.dev");
  });

  test("is null for a forged header beside a service token's JWT, or another person's", async () => {
    const service = await sign(team.privateKey, {
      ...person(),
      email: undefined,
      common_name: "client.access",
    });
    const sam = await sign(team.privateKey, person("sam@just-be.dev"));
    for (const jwt of [service, sam])
      expect(
        await admitted({
          "cf-access-authenticated-user-email": "ada@just-be.dev",
          [accessJwtHeader]: jwt,
        }),
      ).toBeNull();
  });

  test("is null unless the JWT verifies for this application and the team", async () => {
    const header = { "cf-access-authenticated-user-email": "ada@just-be.dev" };
    const forged = await sign(other.privateKey, person());
    const unknownKey = await sign(team.privateKey, person(), "k2");
    const wrongAudience = await sign(team.privateKey, { ...person(), aud: ["other-app"] });
    const wrongIssuer = await sign(team.privateKey, { ...person(), iss: "https://evil.example" });
    const expired = await sign(team.privateKey, { ...person(), exp: now / 1000 - 120 });
    const unsigned = `${part({ alg: "none", kid: "k1" })}.${part(person())}.`;
    for (const jwt of [forged, unknownKey, wrongAudience, wrongIssuer, expired, unsigned, "junk"])
      expect(await admitted({ ...header, [accessJwtHeader]: jwt })).toBeNull();
    const good = await sign(team.privateKey, person());
    expect(await admitted(header)).toBeNull();
    // No `ctx.access`: the request didn't come through Access.
    expect(
      await admittedEmail(request({ ...header, [accessJwtHeader]: good }), undefined, keys, now),
    ).toBeNull();
    expect(await admitted({ [accessJwtHeader]: good })).toBeNull();
  });
});

test("signing keys are cached, and an unknown kid refetches at most once a minute", async () => {
  const pair = await keyPair();
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  let fetches = 0;
  let clock = 0;
  const keys = cachedSigningKeys(
    async () => {
      fetches++;
      return {
        keys: [
          { ...jwk, kid: "k1" },
          { kty: "EC", kid: "skip" },
        ],
      };
    },
    () => clock,
  );
  expect(await keys("k1")).toBeDefined();
  expect(await keys("k1")).toBeDefined();
  expect(await keys("k2")).toBeUndefined();
  expect(fetches).toBe(1);
  clock = 61_000;
  expect(await keys("k2")).toBeUndefined();
  expect(fetches).toBe(2);
});

test("forwarding passes the admitted email to agents' API, and leaves the prefix off", async () => {
  const calls: Array<{ url: string; email: string | null }> = [];
  const env = {
    HUB_API: {
      platformFetch: async (forwarded: Request, email: string | null) => {
        calls.push({ url: forwarded.url, email });
        return new Response("ok");
      },
    },
  };
  const url = new URL("https://automations.just-be.dev/_hub/api/threads?limit=5");
  await forwardToHub(new Request(url), url, env, null);
  expect(calls).toEqual([
    { url: "https://automations.just-be.dev/api/threads?limit=5", email: null },
  ]);
});

test("the edge's runtime imports never reach Alchemy", async () => {
  const seen = new Set<string>();
  const imports: Array<string> = [];
  const walk = async (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = await Bun.file(path).text();
    // Type-only imports are erased from the bundle.
    for (const match of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']/gmu)) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith(".")) await walk(resolve(dirname(path), specifier));
      else imports.push(specifier);
    }
  };
  await walk(resolve(import.meta.dir, "edge.ts"));
  expect(imports.filter((specifier) => /^(alchemy|effect)/u.test(specifier))).toEqual([]);
});
