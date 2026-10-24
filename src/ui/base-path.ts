/**
 * The path the studio is served under. It runs at `/` on its own host, and under a base path when
 * the hub frames it (`/automations/` or `/automations@<stage>/` on hub.just-be.dev,
 * hub-frame-spike.md §2). The same build serves both: the hub injects
 * `<base href="/automations@…/">` ahead of the studio's own `<base href="/">`, and the studio reads
 * it at runtime. Routes see paths without the base (`stripBase`, `stripUrl`); every URL the studio
 * hands the browser (history, fetch, links, the hub's nav) goes through `withBase`. A copy of
 * Desk's.
 */
import type { Url } from "foldkit/url";

/** The path the studio is served under: the first `<base>`'s pathname, always ending in `/`. */
export const appBase = (): string => {
  if (typeof document === "undefined") return "/";
  const href = document.querySelector("base")?.href;
  const pathname = href === undefined ? "/" : (URL.parse(href)?.pathname ?? "/");
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
};

/** The base without its trailing slash: `/automations@x` for `/automations@x/`, `""` for `/`. */
const baseRoot = (base: string) => base.slice(0, -1);

const isUnder = (base: string, path: string): boolean => {
  const root = baseRoot(base);
  return (
    path === root ||
    path.startsWith(base) ||
    path.startsWith(`${root}?`) ||
    path.startsWith(`${root}#`)
  );
};

/** The app's own path for a browser pathname: `/automations@x/traces` → `/traces`, `/automations@x` → `/`. */
export const stripBase = (base: string, pathname: string): string => {
  if (base === "/") return pathname;
  if (pathname === baseRoot(base) || pathname === base) return "/";
  return pathname.startsWith(base) ? pathname.slice(base.length - 1) : pathname;
};

/**
 * The browser's URL for one of the app's: a root-relative path gets the base in front, a full URL
 * on `origin` keeps its origin and gets it too. Other origins, relative paths and URLs already
 * under the base are unchanged, so applying it twice changes nothing.
 */
export const withBase = (base: string, href: string, origin: string): string => {
  if (base === "/") return href;
  if (href.startsWith("/") && !href.startsWith("//")) {
    return isUnder(base, href) ? href : `${base}${href.slice(1)}`;
  }
  const url = URL.parse(href);
  if (url === null || url.origin !== origin || !/^https?:$/u.test(url.protocol)) return href;
  return `${url.origin}${withBase(base, `${url.pathname}${url.search}${url.hash}`, origin)}`;
};

/** {@link withBase} for this page's base and origin. */
export const withAppBase = (href: string): string => {
  const base = appBase();
  return base === "/" ? href : withBase(base, href, window.location.origin);
};

/** A Foldkit `Url` as the app's routes see it: its pathname without the base. */
export const stripUrl = (url: Url, base: string = appBase()): Url => ({
  ...url,
  pathname: stripBase(base, url.pathname),
});
