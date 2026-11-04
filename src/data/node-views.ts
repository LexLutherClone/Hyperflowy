import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Schema } from "effect";
import { useCallback, useSyncExternalStore } from "react";

import { hasWindow } from "../env";
import { kvDelete, kvFetch, kvPut, toKvKeys, toKvRows } from "./kv-api";
import { queryClient } from "./query-client";

/**
 * Per-node view mode (ADR 0075): which way a zoomed node reads -- as the
 * outline list (the default) or as a Board. A kv side-collection (`node-views`
 * via /api/kv, the saved-queries / tag-colors pattern), NOT a `Node` field:
 * it is presentation, not content, so it needs no DO column, no wire-schema
 * change, and no MCP surface, and the R2 snapshot already round-trips kv rows
 * byte-for-byte. It still follows the account across devices (reconciling on
 * tab focus like every side-collection), because a board is a way you've set
 * a page up, not a per-browser whim.
 *
 * Only non-default modes are stored: a row exists while a node is a Board, and
 * switching back to the list deletes it. A row whose node was deleted is inert.
 */

const NODE_VIEWS = ["board"] as const;
export type NodeView = (typeof NODE_VIEWS)[number] | "list";

const nodeViewSchema = Schema.Struct({
  /** The node id (the getKey). The instance id the user zoomed into. */
  id: Schema.String,
  view: Schema.Literals(NODE_VIEWS),
});
type NodeViewRow = Schema.Schema.Type<typeof nodeViewSchema>;

const KV = "node-views";

export const nodeViewsCollection = createCollection(
  queryCollectionOptions({
    id: "node-views",
    queryKey: ["kv", KV],
    queryClient,
    queryFn: () => kvFetch<NodeViewRow>(KV),
    getKey: (row: NodeViewRow) => row.id,
    schema: Schema.toStandardSchemaV1(nodeViewSchema),
    onInsert: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction));
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction));
      return { refetch: false };
    },
    onDelete: async ({ transaction }) => {
      await kvDelete(KV, toKvKeys(transaction));
      return { refetch: false };
    },
  }),
);

/** Set how `nodeId` reads when zoomed. "list" removes the stored row. */
export function setNodeView(nodeId: string, view: NodeView): void {
  const existing = nodeViewsCollection.get(nodeId);
  if (view === "list") {
    if (existing) nodeViewsCollection.delete(nodeId);
    return;
  }
  if (existing) {
    if (existing.view !== view)
      nodeViewsCollection.update(nodeId, (draft) => void (draft.view = view));
    return;
  }
  nodeViewsCollection.insert({ id: nodeId, view });
}

// --- Reactive read (prerender-safe; mirrors saved-queries.ts) ---------------

let views = new Map<string, NodeView>();
const listeners = new Set<() => void>();
let started = false;

function ensureStarted() {
  if (started || !hasWindow()) return;
  started = true;
  nodeViewsCollection.subscribeChanges(
    () => {
      const next = new Map<string, NodeView>();
      for (const row of nodeViewsCollection.toArray) next.set(row.id, row.view);
      views = next;
      for (const l of listeners) l();
    },
    { includeInitialState: true },
  );
}

function subscribe(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Event-time read for non-React callers. */
export function getNodeView(nodeId: string | null): NodeView {
  ensureStarted();
  return (nodeId && views.get(nodeId)) || "list";
}

/** How `nodeId` reads, reactive. Null (Home) is always the list. */
export function useNodeView(nodeId: string | null): NodeView {
  const getSnapshot = useCallback(() => getNodeView(nodeId), [nodeId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => "list");
}
