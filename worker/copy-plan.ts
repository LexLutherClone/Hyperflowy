import type { ChangeOp, Node } from "../src/data/wire-schema";

import { orderSiblings } from "../src/data/sibling-chain";
import { createId } from "../src/data/tree";

/**
 * Copying and moving bullets between outlines (ADR 0083): from your outline
 * into a shared note, and from a shared note into your outline. Pure: the
 * Worker reads both outlines, asks here, writes the copy, and (for a move)
 * only then removes the originals.
 *
 * - **Copy** takes the root and its subtree minus the branches you unticked:
 *   `exclude` names their roots, and each drops with everything under it.
 * - Copies get **fresh ids** (never reusing ids across outlines), keep their
 *   text, task state, completion, kind, and collapse, and append after the
 *   target's last bullet in their original order.
 * - A **mirror becomes a plain bullet** with the text it mirrors: a copy is
 *   content, never a live window into the outline it came from (ADR 0076: no
 *   private content rides into a share, and a copy out isn't tied to the note).
 * - Owner locks and bookmarks are personal and aren't copied.
 * - **Move** takes the whole subtree, refuses what sharing refuses (locks,
 *   daily pages, mirrors elsewhere pointing in), and, once the copy is
 *   written, deletes the originals and relinks the sibling chain around them.
 */

export type CopyPlanError = "not-found" | "locked" | "daily" | "mirror-in";

export interface CopyPlan {
  /** Insert ops for the target outline. */
  targetOps: ChangeOp[];
  /** Move only: the source outline's batch removing the originals. */
  sourceOps: ChangeOp[];
  /** How many bullets were copied. */
  count: number;
}

export interface CopyRequest {
  source: readonly Node[];
  rootId: string;
  /** Copy: roots of the branches to leave out (the root itself can't be).
   *  Move ignores it and takes the whole subtree. */
  exclude: ReadonlySet<string>;
  mode: "copy" | "move";
  target: readonly Node[];
  dailyNodeIds: ReadonlySet<string>;
  now: number;
  newId?: () => string;
}

/** Where copies land: after the last bullet under the target's single root
 *  (a shared page), or at the end of its top level. */
interface Landing {
  parentId: string | null;
  afterId: string | null;
}

function landing(target: readonly Node[]): Landing {
  const roots = orderSiblings(target.filter((n) => n.parentId === null));
  const parentId = roots.length === 1 ? roots[0]!.id : null;
  const siblings = orderSiblings(target.filter((n) => n.parentId === parentId));
  return { parentId, afterId: siblings.at(-1)?.id ?? null };
}

export function planCopy(
  req: CopyRequest,
): CopyPlan | { error: CopyPlanError } {
  const byId = new Map(req.source.map((n) => [n.id, n]));
  const root = byId.get(req.rootId);
  if (!root) return { error: "not-found" };
  const children = new Map<string, Node[]>();
  for (const n of req.source) {
    if (n.parentId === null) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }

  // The bullets that come along, parents before children, siblings in order.
  const take = (n: Node) =>
    n.id === req.rootId || req.mode === "move" || !req.exclude.has(n.id);
  const picked: Node[] = [];
  const walk = (n: Node) => {
    picked.push(n);
    for (const c of orderSiblings(children.get(n.id) ?? []))
      if (take(c)) walk(c);
  };
  walk(root);
  const inside = new Set(picked.map((n) => n.id));

  if (req.mode === "move") {
    let up = root.parentId ? byId.get(root.parentId) : undefined;
    while (up) {
      if (up.locked) return { error: "locked" };
      up = up.parentId ? byId.get(up.parentId) : undefined;
    }
    if (picked.some((n) => n.locked)) return { error: "locked" };
    if (picked.some((n) => req.dailyNodeIds.has(n.id)))
      return { error: "daily" };
    if (
      req.source.some(
        (n) =>
          !inside.has(n.id) && n.mirrorOf !== null && inside.has(n.mirrorOf),
      )
    )
      return { error: "mirror-in" };
  }

  const newId = req.newId ?? createId;
  const ids = new Map(picked.map((n) => [n.id, newId()]));
  const { parentId: landParent, afterId: landAfter } = landing(req.target);
  const prevInCopy = new Map<string, string | null>();
  for (const n of picked) {
    if (n.id === req.rootId) continue;
    const kept = orderSiblings(children.get(n.parentId!) ?? []).filter((c) =>
      inside.has(c.id),
    );
    const i = kept.findIndex((c) => c.id === n.id);
    prevInCopy.set(n.id, i > 0 ? ids.get(kept[i - 1]!.id)! : null);
  }

  const targetOps: ChangeOp[] = picked.map((n) => {
    const source = n.mirrorOf ? byId.get(n.mirrorOf) : undefined;
    return {
      op: "insert",
      value: {
        ...n,
        id: ids.get(n.id)!,
        parentId: n.id === req.rootId ? landParent : ids.get(n.parentId!)!,
        prevSiblingId:
          n.id === req.rootId ? landAfter : (prevInCopy.get(n.id) ?? null),
        text: source?.text ?? n.text,
        mirrorOf: null,
        locked: false,
        bookmarkedAt: null,
        origin: null,
        createdAt: req.now,
        updatedAt: req.now,
      },
    };
  });

  let sourceOps: ChangeOp[] = [];
  if (req.mode === "move") {
    sourceOps = picked.map((n) => ({ op: "delete" as const, key: n.id }));
    const next = req.source.find(
      (n) => n.parentId === root.parentId && n.prevSiblingId === root.id,
    );
    if (next)
      sourceOps.push({
        op: "update",
        value: {
          ...next,
          prevSiblingId: root.prevSiblingId,
          updatedAt: req.now,
        },
      });
  }
  return { targetOps, sourceOps, count: picked.length };
}
