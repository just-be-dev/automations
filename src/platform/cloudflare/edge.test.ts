/** Checks where the Studio's edge sends each request: the Api, the assets, or the hub. */
import { expect, test } from "bun:test";
import edge from "./edge.ts";
import type { EdgeEnv } from "./edge.ts";

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const hubJwt = `${base64Url({ alg: "RS256", kid: "k1" })}.${base64Url({ common_name: "hub-client.access" })}.c2ln`;

const navigation = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

const served = async (
  path: string,
  headers: Record<string, string> = navigation,
  framePrefix = "/automations",
) => {
  const seen: Array<string> = [];
  const fetcher = (name: string) => ({
    fetch: (request: Request) => {
      seen.push(`${name} ${new URL(request.url).pathname}`);
      return Promise.resolve(new Response(name));
    },
  });
  const env: EdgeEnv = {
    API: fetcher("api"),
    ASSETS: fetcher("assets"),
    HUB_EMBED: fetcher("embed"),
    HUB_FRAME_PREFIX: framePrefix,
    HUB_CLIENT_ID: framePrefix === "" ? "" : "hub-client.access",
  };
  const response = await edge.fetch(
    new Request(`https://automations.just-be.dev${path}`, { headers }),
    env,
    {},
  );
  return { status: response.status, location: response.headers.get("location"), seen };
};

test("a page load on a deployed stage goes to the hub", async () => {
  expect(await served("/?automation=a1")).toEqual({
    status: 302,
    location: "https://hub.just-be.dev/automations/?automation=a1",
    seen: [],
  });
});

test("the hub's frame, other requests and alchemy dev get the page from the assets", async () => {
  const assets = { status: 200, location: null, seen: ["assets /templates"] };
  expect(await served("/templates", { ...navigation, "cf-access-jwt-assertion": hubJwt })).toEqual(
    assets,
  );
  expect(await served("/templates", { "sec-fetch-dest": "empty" })).toEqual(assets);
  expect(await served("/templates", navigation, "")).toEqual(assets);
});

test("the API and the hub shell's files are forwarded, never redirected", async () => {
  expect((await served("/api/overview")).seen).toEqual(["api /api/overview"]);
  expect((await served("/_hub/shell.js")).seen).toEqual(["embed /_hub/shell.js"]);
});
