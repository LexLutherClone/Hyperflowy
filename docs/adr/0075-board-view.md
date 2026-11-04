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
  card shows a count, and "Open" in its menu zooms into the node to work on
  them. Columns open from their title.
- **Edit a card in place.** Clicking (or tapping) a card's text edits it.
  Enter saves, Shift+Enter adds a line break, Escape discards, and clicking
  away saves. The edit is the node's text source (the raw markdown), and one
  edit session is one undo step. Locked cards don't open the editor.
- **Drag with mouse or touch.** A mouse press becomes a drag after a few
  pixels of movement. On touch, hold a card still for a moment to pick it up;
  moving sooner scrolls the board or the page instead. The lifted card follows
  the pointer, a line marks the slot, and the board, an overflowing column,
  and the page scroll at their edges.
- **Two-way by construction.** Dragging a card between or within columns, or
  choosing "Move to" in its menu, is the outline's own `moveNode` inside one
  atomic structural write (ADR 0009) with one `"move"` undo point. "Add card"
  and "Add column" append a child with `appendChild`. Checking off a task card
  runs the editor's completion command, and editing card text runs its text
  command (`onTextChange`: lock guard, history, coalesced write). Every
  outline change — local, from
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

**Card editing is a plain textarea over the text source, not a fourth rich
surface.** "A node renders in three places" (docs/plugins.md), each with its
own keymap, decoration, caret, and echo handling (ADR 0010). A fourth
contentEditable would have to repeat all of it, and `MiniNodeEditor` is bound
to quick-add's draft lifecycle. A textarea over the raw markdown needs none of
it. It is uncontrolled while focused, so an echo of another write can't move
the caret (the ADR 0010 hazard). It commits once, through the editor's own
`onTextChange`, so the write gets the same lock guard, history capture, and
serialized, coalesced PATCH as typing in a row. The trade: no `#` tag picker,
`[[` link picker, or `/` menu on a card; "Open" reaches the full editor.

**Pointer-driven drag for mouse and touch, plus a "Move to" menu.**
`use-board-drag.ts` follows the row drag's touch contract
(`use-drag-reorder.ts`): a 5px threshold for the mouse, a 350ms still hold for
touch, a preinstalled non-passive `touchmove` listener that blocks native
panning only once a drag owns the gesture (WebKit bug 185656), multi-touch and
`pointercancel` abort, and the click after a drag is swallowed so a drop never
also opens the editor. It shares no code with the row drag, whose projection is
a 1-D list with depth; a board needs 2-D hit testing (`elementFromPoint` to a
column, then the midpoint rule for the slot). HTML drag and drop was the first
version and was replaced because it never reaches touch. Every card still has
a "Move to" menu, the keyboard and screen-reader path.

## Not in v1

- Reordering columns on the board (reorder the column rows in the list).
- A board at Home, or a board of a filter's matches.
- Tag, link, and `/` pickers while editing a card (use "Open").

## Tests

`src/data/board.test.ts` covers layout, prune, mirrors, and drop planning.
`e2e/board-view.spec.ts` covers the menu toggle, a stored board, Move to,
mouse drag between columns, one-step undo, an external change arriving on the
board, add card, task completion, opening a card, in-place editing (Enter,
Escape, blur, undo), a drag that must not start an edit, and on a touch
device: hold-to-drag, tap-to-edit, and swipe-to-scroll.
