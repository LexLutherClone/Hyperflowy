---
status: accepted
---

# Board view

A **Board** is a way of reading a zoomed node: its children are columns and
their children are cards, kanban-style. It is a view of the outline, never a
second copy of it, so the board and the outline cannot disagree. The
motivating case: a project whose children are `To do` / `Doing` / `Done`,
worked as a board and still outlined, searched, mirrored, and exported as
bullets.

## Product contract

- **Turn it on per page.** "Board view" in the View menu's _This view_ section
  is a checkbox on the current zoom root. Home has no board (it has no node to
  remember the choice on). Turning it off returns the same page to the list.
- **Columns and cards.** Columns are the zoom root's children in sibling order;
  cards are each column's children. A card's own children stay inside it: the
  card shows a count and opens the node (zoom) to edit them, exactly like a
  row's zoom. Columns open the same way from their title.
- **Two-way by construction.** Dragging a card between or within columns, or
  choosing "Move to" in its menu, is the outline's own `moveNode` inside one
  atomic structural write (ADR 0009) with one `"move"` undo point. "Add card"
  and "Add column" append a child with `appendChild`. Checking off a task card
  runs the editor's completion command. Every outline change — local, from
  another device, from MCP or the CLI — re-renders the board through the tree
  store. There is no board state to reconcile.
- **Same visibility as the list.** The board takes the view's composed Seam-G
  prune, so Show completed hides and shows done cards the same way it hides
  rows. A drop computes its predecessor from the visible cards, and the
  predecessor is always a real sibling, so a hidden card keeps its place.
- **A filter or a view stream wins.** With `?q=` active, or on a page a plugin
  reads as a view stream (the Day stream, ADR 0070), the list renders. Both are
  ways of reading rows; half-applying them to a board would be a third
  behavior to learn.
- **Locks hold.** A locked column accepts no drops and offers no "Add card";
  a locked root offers no "Add column". `moveNode` already refuses moves out of
  or into a locked parent (ADR 0067).
- **Mirrors (ADR 0022).** A column or card may be a mirror. Its position is the
  instance (what moves); its text and children are read from the source, and a
  card dropped into a mirrored column lands under the source, the same field
  split the row drag applies.

## Decisions

**Storage: a `node-views` kv side-collection, not a `Node` field.** A view mode
is presentation, not content. A side-collection needs no DO column, no wire
schema change, no MCP or CLI surface, no Lunora retirement-schema update, and
the R2 snapshot already round-trips kv rows byte-for-byte (ADR 0008 Seam E,
`worker/backup.ts`). It still follows the account across devices, reconciling
on tab focus like tag colors and saved queries. Only non-default modes are
stored; switching back to the list deletes the row. Rejected: a `view` field on
`Node` (seven-plus touch points for state no agent needs), and localStorage
(a board set up on the laptop would be a list on the phone).

**Core, not a plugin.** The board replaces the editor body. No seam lets a
plugin do that, and adding one for a single consumer would be a seam designed
around one feature (ADR 0001). The board lives beside Spotlight as a core view
mode: `src/components/board-view.tsx`, with the pure layout and drop planning
in `src/data/board.ts`.

**Cards are not a fourth editable text surface.** "A node renders in three
places" (docs/plugins.md) — each with its own keymap, decoration, caret, and
echo handling (ADR 0010). A fourth would have to repeat all of it. Cards render
the node's flattened text read-only; editing happens where it already works,
one click away in the zoomed node. Revisit if in-place card editing becomes the
main complaint, by reusing `MiniNodeEditor` rather than writing a new surface.

**Native drag and drop plus a "Move to" menu.** The outline's row drag
(`use-drag-reorder.ts`) is a pointer-driven vertical list projection; a 2-D
board does not fit it. HTML drag and drop handles desktop with no new
dependency. Native drag does not reach touch, the keyboard, or screen readers,
so every card has a "Move to" menu listing the other columns; it appends to
the end of the chosen column.

## Not in v1

- Reordering columns on the board (reorder the column rows in the list).
- Touch dragging (use "Move to").
- A board at Home, or a board of a filter's matches.
- In-place card editing (see above).

## Tests

`src/data/board.test.ts` covers layout, prune, mirrors, and drop planning.
`e2e/board-view.spec.ts` covers the menu toggle, a stored board, Move to,
drag between columns, one-step undo, an external change arriving on the board,
add card, task completion, and opening a card.
