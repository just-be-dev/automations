/**
 * Checks that request-scoped Access identity reaches approval operations without leaking between
 * requests, and that the hub's identity counts only with hub prod's verified service token.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Namer } from "../../agents/namer/namer.ts";
import { AutomationIndex } from "../../automation/index.ts";
import { Automations } from "../../automation/service.ts";
import { layerMemory } from "../../entities/memory.ts";
import { automationRoutes } from "../../http/automations.ts";
import { RequestIdentity } from "../../http/identity.ts";
import { accessIdentity, type HubAccess } from "./access.ts";
import { accessTeamDomain } from "./access-jwt.ts";
import { hubIdentityVerifier } from "./hub-identity.ts";
import {
  signWithTestKey,
  testClaims,
  testJwt,
  testPublicKeyPem,
} from "./testing/hub-identity-vector.ts";

/** Answers one approval per Access header value and returns the responder each answer carried. */
const respondersFor = async (localUser: Option.Option<string>) => {
  const calls: Array<ReadonlyArray<unknown>> = [];
  const unused = () => Effect.die("Unexpected operation");
  const services = Layer.mergeAll(
    layerMemory({}),
    Layer.succeed(Namer, { complete: unused }),
    Layer.succeed(AutomationIndex, {
      list: Effect.succeed([]),
      create: unused,
      record: unused,
      recordIfMissing: unused,
      remove: unused,
    }),
    Layer.succeed(Automations, {
      get: (id) => ({
        inspectWorkflow: unused,
        overview: unused,
        answer: unused,
        stopChat: unused,
        templateUses: unused,
        chat: unused,
        save: unused,
        setPermissions: unused,
        setDraft: unused,
        remove: unused,
        start: unused,
        entityChanged: unused,
        eventReceived: unused,
        run: unused,
        plannerTrace: unused,
        runTrace: unused,
        resumeNow: unused,
        respond: (runId, stepId, answer, email) =>
          Effect.sync(() => {
            calls.push([id, runId, stepId, answer, email]);
            return { ok: true };
          }),
      }),
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    automationRoutes.pipe(Layer.provideMerge(services)),
    {
      disableLogger: true,
      middleware: (effect) => effect.pipe(Effect.provide(accessIdentity(localUser))),
    },
  );
  try {
    for (const email of ["sam@example.com", "other@example.com", "", undefined]) {
      const response = await handler(
        new Request("http://studio/api/automations/a1/runs/r1/tasks/approve", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(email === undefined ? {} : { "cf-access-authenticated-user-email": email }),
          },
          body: JSON.stringify({ approved: true }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"ok":true}');
    }
  } finally {
    await dispose();
  }
  for (const call of calls) {
    expect(call.slice(0, 4)).toEqual(["a1", "r1", "approve", { approved: true }]);
  }
  return calls.map((call) => call[4]);
};

test("Access identity is request-scoped and reaches the automation's approval operation", async () => {
  expect(await respondersFor(Option.none())).toEqual([
    "sam@example.com",
    "other@example.com",
    undefined,
    undefined,
  ]);
});

test("a local studio's user answers when Access sent no one, and Access still wins", async () => {
  expect(await respondersFor(Option.some("you@example.com"))).toEqual([
    "sam@example.com",
    "other@example.com",
    "you@example.com",
    "you@example.com",
  ]);
});

// --- The hub's identity (hub-frame-spike.md §4.4) ---

const audience = "studio-aud";
const hubClientId = "hub-client.access";
const studioAudience = "automations@prod";

const rsaKeyPair = () =>
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
const jsonPart = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

const signAccess = async (key: CryptoKey, claims: Record<string, unknown>) => {
  const unsigned = `${jsonPart({ alg: "RS256", kid: "k1" })}.${jsonPart(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

const accessClaims = (extra: Record<string, unknown>) => ({
  iss: `https://${accessTeamDomain}`,
  aud: [audience],
  exp: nowSeconds() + 300,
  ...extra,
});

/** An identity token signed with the shared test key, fresh now, for `aud`. */
const hubToken = (aud = studioAudience, email = "owner@just-be.dev") =>
  signWithTestKey({
    ...testClaims,
    aud,
    sub: email,
    email,
    iat: nowSeconds(),
    exp: nowSeconds() + 120,
  });

describe("the hub's identity", async () => {
  const team = await rsaKeyPair();
  const other = await rsaKeyPair();
  const keys = async (kid: string) => (kid === "k1" ? team.publicKey : undefined);
  const hub: HubAccess = {
    check: { teamDomain: accessTeamDomain, audience, clientId: hubClientId },
    keys,
    verifyIdentity: hubIdentityVerifier({
      publicKeyPem: testPublicKeyPem,
      audience: studioAudience,
    }),
  };
  const hubJwt = await signAccess(team.privateKey, accessClaims({ common_name: hubClientId }));
  const testTokenJwt = await signAccess(
    team.privateKey,
    accessClaims({ common_name: "test-client.access" }),
  );
  const personJwt = await signAccess(team.privateKey, accessClaims({ email: "ada@just-be.dev" }));

  const identity = (
    headers: Record<string, string>,
    access: HubAccess | null = hub,
    localUser: Option.Option<string> = Option.none(),
  ) =>
    Effect.runPromise(
      RequestIdentity.pipe(
        Effect.map((found) => found.email),
        Effect.provide(accessIdentity(localUser, access ?? undefined)),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("https://automations.just-be.dev/api/overview", { headers }),
          ),
        ),
      ),
    );

  test("acts for the person the hub vouches for, with hub prod's token", async () => {
    expect(
      await identity({ "cf-access-jwt-assertion": hubJwt, "x-hub-identity": await hubToken() }),
    ).toBe("owner@just-be.dev");
  });

  test("acts for no one when the identity token doesn't verify for this stage", async () => {
    for (const token of [
      await hubToken("automations@b-preview-123456"),
      await hubToken("desk@prod"),
      testJwt,
      "not a token",
      "",
    ]) {
      expect(await identity({ "cf-access-jwt-assertion": hubJwt, "x-hub-identity": token })).toBe(
        undefined,
      );
    }
    expect(await identity({ "cf-access-jwt-assertion": hubJwt })).toBe(undefined);
  });

  test("ignores the identity token beside another service token, or a JWT that doesn't verify", async () => {
    const token = await hubToken();
    expect(
      await identity({ "cf-access-jwt-assertion": testTokenJwt, "x-hub-identity": token }),
    ).toBe(undefined);
    const forged = await signAccess(other.privateKey, accessClaims({ common_name: hubClientId }));
    expect(await identity({ "cf-access-jwt-assertion": forged, "x-hub-identity": token })).toBe(
      undefined,
    );
    const otherApp = await signAccess(
      team.privateKey,
      accessClaims({ common_name: hubClientId, aud: ["another-aud"] }),
    );
    expect(await identity({ "cf-access-jwt-assertion": otherApp, "x-hub-identity": token })).toBe(
      undefined,
    );
    const expired = await signAccess(
      team.privateKey,
      accessClaims({ common_name: hubClientId, exp: nowSeconds() - 120 }),
    );
    expect(await identity({ "cf-access-jwt-assertion": expired, "x-hub-identity": token })).toBe(
      undefined,
    );
    // Without the hub bound (alchemy dev), nobody is vouched for.
    expect(
      await identity({ "cf-access-jwt-assertion": hubJwt, "x-hub-identity": token }, null),
    ).toBe(undefined);
  });

  test("never takes a service token's email header", async () => {
    const forgedEmail = { "cf-access-authenticated-user-email": "ada@just-be.dev" };
    expect(await identity({ ...forgedEmail, "cf-access-jwt-assertion": testTokenJwt })).toBe(
      undefined,
    );
    expect(await identity({ ...forgedEmail, "cf-access-jwt-assertion": hubJwt })).toBe(undefined);
    expect(
      await identity({
        ...forgedEmail,
        "cf-access-jwt-assertion": hubJwt,
        "x-hub-identity": await hubToken(studioAudience, "owner@just-be.dev"),
      }),
    ).toBe("owner@just-be.dev");
  });

  test("a person's own sign-in wins over the hub's identity token", async () => {
    expect(
      await identity({
        "cf-access-jwt-assertion": personJwt,
        "cf-access-authenticated-user-email": "ada@just-be.dev",
        "x-hub-identity": await hubToken(),
      }),
    ).toBe("ada@just-be.dev");
  });

  test("without an Access JWT, the header and the local user behave as before", async () => {
    expect(await identity({ "cf-access-authenticated-user-email": "sam@example.com" })).toBe(
      "sam@example.com",
    );
    expect(await identity({}, null, Option.some("you@example.com"))).toBe("you@example.com");
    expect(await identity({ "x-hub-identity": await hubToken() })).toBe(undefined);
  });
});
