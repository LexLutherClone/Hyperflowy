import type { Node } from "./schema";

import { orderSiblings } from "./sibling-chain";

/**
 * Inline shared-note previews (ADR 0080). Pure helpers: which bullets are
 * links to a shared note, and how a shared note's outline reads as preview
 * lines.
 */

const LINK = /^\[([^\]]*)\]\(([^)\s]+)\)$/;
const SPACE_PATH = /^\/s\/([^/]+)\/?$/;

/**
 * The space a bullet links to, when its whole text is one markdown link to a
 * same-origin `/s/<id>` address (what sharing leaves behind, ADR 0079).
 * Anything else, including a link to another site, is not a space link.
 */
export function spaceLinkId(text: string, origin: string): string | null {
  const m = LINK.exec(text.trim());
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(m[2]!, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const path = SPACE_PATH.exec(url.pathname);
  return path ? decodeURIComponent(path[1]!) : null;
}

export interface PreviewLine {
  id: string;
  text: string;
  depth: number;
  isTask: boolean;
  completed: boolean;
  /** Children hidden because this node is collapsed in the space. */
  hiddenChildren: number;
}

export interface Preview {
  lines: PreviewLine[];
  /** Lines left out past the cap. */
  more: number;
}

/**
 * The space's outline as preview lines, depth-first in sibling order. With a
 * single top-level node (a shared bullet), its children are the lines: the
 * bullet itself is already the link in your outline. Collapsed nodes keep
 * their children folded, as they are in the space.
 */
export function previewLines(nodes: readonly Node[], cap = 40): Preview {
  const children = new Map<string | null, Node[]>();
  for (const n of nodes) {
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  const ordered = (parent: string | null) =>
    orderSiblings(children.get(parent) ?? []);
  const roots = ordered(null);
  const start = roots.length === 1 ? ordered(roots[0]!.id) : roots;

  const lines: PreviewLine[] = [];
  let total = 0;
  const walk = (list: Node[], depth: number) => {
    for (const n of list) {
      total += 1;
      const kids = children.get(n.id)?.length ?? 0;
      if (lines.length < cap)
        lines.push({
          id: n.id,
          text: n.text,
          depth,
          isTask: n.kind === null && n.isTask,
          completed: n.completed,
          hiddenChildren: n.collapsed ? kids : 0,
        });
      if (!n.collapsed) walk(ordered(n.id), depth + 1);
    }
  };
  walk(start, 0);
  return { lines, more: Math.max(0, total - lines.length) };
}
