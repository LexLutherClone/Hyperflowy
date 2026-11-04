import type { Node } from "./schema";

import { childrenOf, type TreeIndex } from "./tree";

/**
 * Board view (ADR 0075): a zoomed node read as a kanban board. The board is a
 * VIEW of the outline, never a second copy of it -- columns are the zoom
 * root's children, cards are each column's children, and a card's own
 * children stay inside the card (opened by zooming). Because every column and
 * card IS a node, a change on either side shows on the other with no sync
 * code: dragging a card is the same `moveNode` a row drag runs, and an outline
 * edit re-renders the board through the tree store.
 *
 * Pure: no collection, no DOM. The component feeds it the live index and the
 * view's composed `isHidden` predicate (Seam G), so hidden completed cards
 * vanish from the board exactly as they do from the list.
 *
 * Mirrors (ADR 0022): a column or card may be a mirror. Its POSITION is the
 * instance node (what moves); its TEXT and CHILDREN are read from its source.
 * `resolveContent` is the caller's `contentId` rule so this module stays
 * independent of the session-fixed mirrors flag.
 */

export interface BoardCard {
  /** Instance id -- the node that sits in the column and moves on drop. */
  id: string;
  /** Content id -- where text, task state, and children are read. */
  contentId: string;
}

export interface BoardColumn {
  /** Instance id of the column node (a child of the board root). */
  id: string;
  /** Content id of the column; cards are this node's children. */
  contentId: string;
  cards: BoardCard[];
}

export type ResolveContent = (node: Node) => string;

/** The default content rule with mirrors off: every node is its own source. */
export const ownContent: ResolveContent = (node) => node.id;

/** Columns and cards for the board rooted at `rootContentId`. Hidden columns
 *  and hidden cards (per the view's prune) are omitted; their nodes are
 *  untouched. */
export function buildBoard(
  index: TreeIndex,
  rootContentId: string,
  isHidden: (node: Node) => boolean,
  resolveContent: ResolveContent = ownContent,
): BoardColumn[] {
  const columns: BoardColumn[] = [];
  for (const column of childrenOf(index, rootContentId)) {
    if (isHidden(column)) continue;
    const contentId = resolveContent(column);
    const cards: BoardCard[] = [];
    for (const card of childrenOf(index, contentId)) {
      if (isHidden(card)) continue;
      cards.push({ id: card.id, contentId: resolveContent(card) });
    }
    columns.push({ id: column.id, contentId, cards });
  }
  return columns;
}

/** Where a dropped card lands, in `moveNode` terms. */
export interface BoardDrop {
  /** The node the card becomes a child of: the column's CONTENT id, so a card
   *  dropped into a mirrored column lands under its source and shows in every
   *  instance (the same field split the outline drag applies). */
  parentId: string;
  /** The card's new previous sibling, or null to become the first child. */
  afterSiblingId: string | null;
}

/**
 * Plan dropping `cardId` into `column` so it renders at visible position
 * `targetIndex` (0 = top). Positions count only the column's VISIBLE cards,
 * which is what the user sees; the predecessor is always a real sibling, so a
 * hidden completed card above the drop point keeps its place.
 *
 * Returns null when the drop changes nothing (dropped onto its own slot).
 */
export function planBoardDrop(
  index: TreeIndex,
  column: BoardColumn,
  cardId: string,
  targetIndex: number,
): BoardDrop | null {
  const card = index.byId.get(cardId);
  if (!card) return null;
  // Remove the dragged card from the visible order first: in its own column,
  // indices after it shift up by one once it leaves its slot.
  const visible = column.cards.map((c) => c.id);
  const from = visible.indexOf(cardId);
  let at = Math.max(0, Math.min(targetIndex, visible.length));
  if (from !== -1) {
    visible.splice(from, 1);
    if (from < at) at -= 1;
  }
  const afterSiblingId = at === 0 ? null : (visible[at - 1] ?? null);
  const parentId = column.contentId;
  if (
    card.parentId === parentId &&
    (card.prevSiblingId ?? null) === afterSiblingId
  )
    return null;
  // Landing first in a column whose first visible card is not the first real
  // child (hidden cards above it) still means "first": null puts it at the head.
  return { parentId, afterSiblingId };
}

/** The last child (visible or not) of `parentId`, the predecessor a new card
 *  or column appends after. */
export function lastChildId(index: TreeIndex, parentId: string): string | null {
  const kids = childrenOf(index, parentId);
  return kids.length ? kids[kids.length - 1]!.id : null;
}
