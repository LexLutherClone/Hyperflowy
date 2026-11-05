import type { ChangeOp, Node } from "../src/data/wire-schema";

/**
 * Plan sharing one node of a personal outline as a new space (ADR 0079). Pure:
 * the Worker reads the outline, asks here, then writes the space first and the
 * personal outline second, so an interruption can leave content in both
 * places, never in neither.
 *
 * The shared node becomes the space's top-level root, with its whole subtree.
 * In the personal outline the node keeps its id and its place in the sibling
 * chain and turns into a link to the space; its descendants are removed. Not
 * moving the node itself is what keeps the sibling chain untouched.
 *
 * Refused, with a reason the app explains:
 * - `locked`: a node in the subtree is owner-locked (ADR 0067). Unlock first.
 * - `daily`: the subtree holds a daily-note page or container (ADR 0052),
 *   which the personal calendar points at by id.
 * - `mirror-out`: a node in the subtree mirrors content outside it. Moving it
 *   would carry private content into the share (ADR 0076's rule).
 * - `mirror-in`: a node outside mirrors content inside the subtree. Moving it
 *   would orphan that mirror.
 */

export type SharePlanError =
  | "not-found"
  | "locked"
  | "daily"
  | "mirror-out"
  | "mirror-in";

export interface SharePlan {
  /** The space's initial outline: the subtree, its root made top-level. */
  spaceNodes: Node[];
  /** The personal outline's batch: the root becomes the link, the rest goes. */
  personalOps: ChangeOp[];
}

export function planShare(
  nodes: readonly Node[],
  rootId: string,
  dailyNodeIds: ReadonlySet<string>,
  link: string,
  now: number,
): SharePlan | { error: SharePlanError } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = byId.get(rootId);
  if (!root) return { error: "not-found" };

  const children = new Map<string, Node[]>();
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  const subtree: Node[] = [];
  const inside = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (inside.has(n.id)) continue;
    inside.add(n.id);
    subtree.push(n);
    for (const c of children.get(n.id) ?? []) stack.push(c);
  }

  // A lock on an ancestor locks the root too (effective lock).
  let ancestor = root.parentId ? byId.get(root.parentId) : undefined;
  while (ancestor) {
    if (ancestor.locked) return { error: "locked" };
    ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
  }
  if (subtree.some((n) => n.locked)) return { error: "locked" };
  if (subtree.some((n) => dailyNodeIds.has(n.id))) return { error: "daily" };
  if (subtree.some((n) => n.mirrorOf !== null && !inside.has(n.mirrorOf)))
    return { error: "mirror-out" };
  if (
    nodes.some(
      (n) => !inside.has(n.id) && n.mirrorOf !== null && inside.has(n.mirrorOf),
    )
  )
    return { error: "mirror-in" };

  const spaceNodes = subtree.map((n) =>
    n.id === rootId ? { ...n, parentId: null, prevSiblingId: null } : n,
  );
  const personalOps: ChangeOp[] = [
    {
      op: "update",
      value: {
        ...root,
        text: link,
        isTask: false,
        completed: false,
        collapsed: false,
        kind: null,
        updatedAt: now,
      },
    },
    ...subtree
      .filter((n) => n.id !== rootId)
      .map((n) => ({ op: "delete" as const, key: n.id })),
  ];
  return { spaceNodes, personalOps };
}

/** The personal-outline text for a shared node: a link to its space. */
export function spaceLinkText(name: string, url: string): string {
  const label = name.replace(/[[\]]/g, "").trim() || "Shared note";
  return `[${label}](${url})`;
}
