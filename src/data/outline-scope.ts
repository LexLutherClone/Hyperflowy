import { hasWindow } from "../env";

/**
 * Which outline this page edits (ADR 0079): the signed-in person's own, or a
 * shared space opened at `/s/<spaceId>`. Decided ONCE, at module load, from
 * the address. The data layer is a set of module singletons (one collection,
 * one tree store, one history), so a page edits exactly one outline, and
 * moving between your outline and a space is a full page load.
 *
 * In a space, the router rewrites addresses under `/s/<spaceId>`, so every in-app link
 * and zoom (`/$nodeId`) stays inside the space, and the outline endpoints
 * (`sync`, `nodes`, and the space's own kv collections) point at the space.
 * Account-level data (preferences, saved filters, the changelog cursor, the
 * daily index) stays personal.
 */

const match = hasWindow()
  ? /^\/s\/([^/]+)/.exec(window.location.pathname)
  : null;

/** The open space's id, or null on the personal outline. */
export const SPACE_ID: string | null = match
  ? decodeURIComponent(match[1]!)
  : null;

export const inSpace = (): boolean => SPACE_ID !== null;

/** The address prefix of the open space: `/s/<id>`, or null. */
const prefix = SPACE_ID === null ? null : `/s/${encodeURIComponent(SPACE_ID)}`;

const SPACE_PATH = /^(\/s\/[^/]+)(\/.*)?$/;

/** A router URL rewrite (TanStack Router's `rewrite` option). */
export interface SpaceRewrite {
  input: (args: { url: URL }) => URL | undefined;
  output: (args: { url: URL }) => URL | undefined;
}

/**
 * The router's URL rewrite for spaces: the router sees `/`, `/<nodeId>`,
 * `/settings`, …, while the address bar shows them under `/s/<id>`.
 *
 * Each router gets its own rewrite, which remembers the prefix it stripped on
 * the way in and adds the same one back on the way out. That matters on the
 * dev server, which builds a router per request and has no `window`: without
 * the round trip it would match `/s/<id>` as `/` and redirect there.
 */
export function spaceRewrite(): SpaceRewrite {
  let current = prefix;
  return {
    input: ({ url }) => {
      const m = SPACE_PATH.exec(url.pathname);
      if (!m) return undefined;
      current = m[1]!;
      const next = new URL(url);
      next.pathname = m[2] || "/";
      return next;
    },
    output: ({ url }) => {
      if (current === null) return undefined;
      if (url.pathname.startsWith(`${current}/`) || url.pathname === current)
        return undefined;
      const next = new URL(url);
      next.pathname =
        url.pathname === "/" ? current : `${current}${url.pathname}`;
      return next;
    },
  };
}

/** Base of this outline's endpoints: `/api` or `/api/spaces/<id>`. */
export const outlineApiBase = (): string =>
  SPACE_ID === null ? "/api" : `/api/spaces/${encodeURIComponent(SPACE_ID)}`;

/** Side-collections that belong to the outline rather than the account: a
 *  space's board views and tag colors are shared with its collaborators. */
const OUTLINE_KV = new Set(["node-views", "tag-colors"]);

/** The kv endpoint for `collection`. */
export const kvEndpoint = (collection: string): string =>
  SPACE_ID !== null && OUTLINE_KV.has(collection)
    ? `${outlineApiBase()}/kv`
    : "/api/kv";
