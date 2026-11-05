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

/**
 * The router's URL rewrite in a space: the router sees `/`, `/<nodeId>`,
 * `/settings`, …, while the address bar shows them under `/s/<id>`. Undefined
 * on the personal outline.
 */
export function spaceRewrite():
  | {
      input: (args: { url: URL }) => URL | undefined;
      output: (args: { url: URL }) => URL | undefined;
    }
  | undefined {
  if (prefix === null) return undefined;
  return {
    input: ({ url }) => {
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
        return undefined;
      const next = new URL(url);
      next.pathname = url.pathname.slice(prefix.length) || "/";
      return next;
    },
    output: ({ url }) => {
      if (url.pathname.startsWith(`${prefix}/`) || url.pathname === prefix)
        return undefined;
      const next = new URL(url);
      next.pathname =
        url.pathname === "/" ? prefix : `${prefix}${url.pathname}`;
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
