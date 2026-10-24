/** Checks which requests on the studio's hostname go to the hub, and where. */
import { describe, expect, test } from "bun:test";
import { hubRedirect, pagePaths, redirectResponse } from "./hub-redirect.ts";
import { templatesPath, tracesPath } from "../../ui/route.ts";

const hubClientId = "hub-client.access";
const prod = { framePrefix: "/automations", hubClientId };
const preview = { framePrefix: "/automations@b-preview-123456", hubClientId };

const navigation = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const jwt = (claims: Record<string, unknown>) =>
  `${base64Url({ alg: "RS256", kid: "k1" })}.${base64Url(claims)}.c2ln`;

const redirect = (
  path: string,
  { method = "GET", headers = navigation as Record<string, string>, config = prod } = {},
) =>
  hubRedirect(
    {
      method,
      url: new URL(`https://automations.just-be.dev${path}`),
      headers: new Headers(headers),
    },
    config,
  );

describe("hubRedirect", () => {
  test("sends a page load to the same page on the hub, query kept", () => {
    expect(redirect("/")).toBe("https://hub.just-be.dev/automations/");
    expect(redirect("/?automation=a1&run=r1")).toBe(
      "https://hub.just-be.dev/automations/?automation=a1&run=r1",
    );
    expect(redirect("/templates?template=welcome")).toBe(
      "https://hub.just-be.dev/automations/templates?template=welcome",
    );
    expect(redirect("/traces", { method: "HEAD" })).toBe(
      "https://hub.just-be.dev/automations/traces",
    );
  });

  test("sends a preview's page load to its stage on the hub", () => {
    expect(redirect("/?automation=a1", { config: preview })).toBe(
      "https://hub.just-be.dev/automations@b-preview-123456/?automation=a1",
    );
  });

  test("leaves everything but a browser's top-level page load alone", () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      expect(redirect("/", { method })).toBeUndefined();
    }
    expect(redirect("/", { headers: {} })).toBeUndefined();
    expect(redirect("/", { headers: { "sec-fetch-dest": "document" } })).toBeUndefined();
    expect(redirect("/", { headers: { "sec-fetch-mode": "navigate" } })).toBeUndefined();
    expect(
      redirect("/", { headers: { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" } }),
    ).toBeUndefined();
    expect(
      redirect("/", { headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "cors" } }),
    ).toBeUndefined();
  });

  test("never redirects APIs, the hub shell, Cloudflare's paths, webhooks or files", () => {
    for (const path of [
      "/api",
      "/api/overview",
      "/api/mcp",
      "/mcp",
      "/mcp/anything",
      "/_hub",
      "/_hub/shell.js",
      "/_hub/api/threads",
      "/.well-known/oauth-protected-resource",
      "/cdn-cgi/access/logout",
      "/integrations/slack/webhook",
      "/integrations/slack/interactivity",
      "/theme.js",
      "/assets/index-abc123.js",
      "/favicon.ico",
      "/templates/x.json",
    ]) {
      expect(redirect(path)).toBeUndefined();
    }
    // Page paths that only look like exclusions are pages.
    expect(redirect("/apis")).toBe("https://hub.just-be.dev/automations/apis");
    expect(redirect("/?automation=a.b")).toBe(
      "https://hub.just-be.dev/automations/?automation=a.b",
    );
  });

  test("leaves the hub's own requests here, whatever they ask for", () => {
    const hub = { ...navigation, "cf-access-jwt-assertion": jwt({ common_name: hubClientId }) };
    expect(redirect("/", { headers: hub })).toBeUndefined();
    const other = {
      ...navigation,
      "cf-access-jwt-assertion": jwt({ common_name: "test-client.access" }),
    };
    expect(redirect("/", { headers: other })).toBe("https://hub.just-be.dev/automations/");
    const person = {
      ...navigation,
      "cf-access-jwt-assertion": jwt({ email: "ada@just-be.dev" }),
    };
    expect(redirect("/", { headers: person })).toBe("https://hub.just-be.dev/automations/");
    const broken = { ...navigation, "cf-access-jwt-assertion": "not a jwt" };
    expect(redirect("/", { headers: broken })).toBe("https://hub.just-be.dev/automations/");
  });

  test("never redirects without a frame prefix, as under alchemy dev", () => {
    expect(redirect("/", { config: { framePrefix: "", hubClientId: "" } })).toBeUndefined();
    // No hub token bound: nothing is the hub's, but pages still go there.
    const anyToken = { ...navigation, "cf-access-jwt-assertion": jwt({ common_name: "" }) };
    expect(
      redirect("/", {
        headers: anyToken,
        config: { framePrefix: "/automations", hubClientId: "" },
      }),
    ).toBe("https://hub.just-be.dev/automations/");
  });

  test("the redirect is a 302 nothing caches", () => {
    const response = redirectResponse("https://hub.just-be.dev/automations/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://hub.just-be.dev/automations/");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

test("the Worker runs first for exactly the studio's pages", () => {
  expect(pagePaths).toEqual(["/", templatesPath, tracesPath]);
});
