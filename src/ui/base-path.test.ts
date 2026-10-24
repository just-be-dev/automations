/** Checks how the studio strips and adds the base path the hub serves it under. */
import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import type { Url } from "foldkit/url";
import { appBase, stripBase, stripUrl, withAppBase, withBase } from "./base-path.ts";

const base = "/automations@b-preview-123456/";
const origin = "https://hub.example.workers.dev";

describe("stripBase", () => {
  test("drops the base from paths under it", () => {
    expect(stripBase(base, `${base}templates`)).toBe("/templates");
    expect(stripBase(base, `${base}traces`)).toBe("/traces");
    expect(stripBase(base, base)).toBe("/");
    expect(stripBase(base, "/automations@b-preview-123456")).toBe("/");
    expect(stripBase("/automations/", "/automations/templates")).toBe("/templates");
  });

  test("leaves other paths alone", () => {
    expect(stripBase(base, "/templates")).toBe("/templates");
    expect(stripBase(base, "/automations@b-preview-123456x/templates")).toBe(
      "/automations@b-preview-123456x/templates",
    );
    expect(stripBase("/automations/", "/automations@x/templates")).toBe("/automations@x/templates");
    expect(stripBase("/", "/templates")).toBe("/templates");
    expect(stripBase("/", "/")).toBe("/");
  });
});

describe("withBase", () => {
  test("prefixes root-relative paths, keeping the query and hash", () => {
    expect(withBase(base, "/", origin)).toBe(base);
    expect(withBase(base, "/templates", origin)).toBe(`${base}templates`);
    expect(withBase(base, "/?automation=a1", origin)).toBe(`${base}?automation=a1`);
    expect(withBase(base, "/api/automations", origin)).toBe(`${base}api/automations`);
    expect(withBase(base, "/traces?run=r1#c", origin)).toBe(`${base}traces?run=r1#c`);
  });

  test("prefixes same-origin full URLs and keeps the origin", () => {
    expect(withBase(base, `${origin}/templates?x=1`, origin)).toBe(`${origin}${base}templates?x=1`);
    expect(withBase(base, `${origin}/`, origin)).toBe(`${origin}${base}`);
  });

  test("leaves other origins, protocol-relative and relative URLs alone", () => {
    expect(withBase(base, "https://example.com/templates", origin)).toBe(
      "https://example.com/templates",
    );
    expect(withBase(base, "//example.com/x", origin)).toBe("//example.com/x");
    expect(withBase(base, "templates", origin)).toBe("templates");
    expect(withBase(base, "?automation=a1", origin)).toBe("?automation=a1");
    expect(withBase(base, "mailto:me@example.com", origin)).toBe("mailto:me@example.com");
  });

  test("is idempotent", () => {
    for (const href of [
      "/",
      "/templates",
      "/?automation=a1",
      `${origin}/templates`,
      "https://x.dev/a",
    ]) {
      const once = withBase(base, href, origin);
      expect(withBase(base, once, origin)).toBe(once);
    }
    expect(withBase(base, "/automations@b-preview-123456", origin)).toBe(
      "/automations@b-preview-123456",
    );
    expect(withBase(base, "/automations@b-preview-123456?x", origin)).toBe(
      "/automations@b-preview-123456?x",
    );
  });

  test("changes nothing at the root", () => {
    expect(withBase("/", "/templates", origin)).toBe("/templates");
    expect(withBase("/", `${origin}/templates`, origin)).toBe(`${origin}/templates`);
  });
});

test("stripUrl strips a Foldkit Url's pathname", () => {
  const url: Url = {
    protocol: "https:",
    host: "hub.example.workers.dev",
    port: Option.none(),
    pathname: `${base}templates`,
    search: Option.some("x=1"),
    hash: Option.none(),
  };
  expect(stripUrl(url, base)).toEqual({ ...url, pathname: "/templates" });
  expect(stripUrl(url, "/")).toEqual(url);
});

test("without a document, the base is the root and URLs are unchanged", () => {
  expect(appBase()).toBe("/");
  expect(withAppBase("/templates")).toBe("/templates");
});

test("the base is the first <base>'s pathname", () => {
  const withDocument = (href: string | undefined) => {
    const previous = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { querySelector: () => (href === undefined ? null : { href }) },
    });
    try {
      return appBase();
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: previous });
    }
  };
  expect(withDocument(`${origin}${base}`)).toBe(base);
  expect(withDocument(`${origin}/automations`)).toBe("/automations/");
  expect(withDocument(`${origin}/`)).toBe("/");
  expect(withDocument(undefined)).toBe("/");
});
