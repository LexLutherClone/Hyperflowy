---
status: accepted
---

# Inline shared-note previews

The first step of milestone 3 in
[ADR 0076](./0076-collaboration-workspaces-and-shared-spaces.md): a shared
note shows up inside your own outline. Under a bullet that links to a shared
note (what sharing leaves behind,
[ADR 0079](./0079-shared-spaces.md)), the note's outline appears live and
read-only, with an **Open** link to edit it.

## Product contract

- **Which bullets.** A bullet whose whole text is one markdown link to a
  same-origin `/s/<id>` address. A link to another site, or a link inside
  other text, is just a link.
- **What it shows.** The shared note's bullets in order, indented, with tasks
  checked or not and done items struck through. With one top-level bullet (a
  shared page), its children are the lines, since the bullet itself is the
  link. Bullets collapsed in the note stay folded (with a `+n` count). Long
  notes stop at 40 lines with "and N more…".
- **Live.** Edits in the shared note, by anyone, appear in the preview as they
  happen.
- **Read-only, always.** The preview has no editor and writes nothing, whatever
  your role. **Open** takes you to the note (`/s/<id>`), where your role
  applies.
- **Access follows the note.** The header shows your role. If the note is no
  longer shared with you, the preview says so; revoking closes the preview's
  connection like any other (ADR 0079).
- **Collapsible** per row, and only on your own outline (never inside a
  shared note).

## Decisions

**A plugin on the reviewed `row:body` slot**, not core editor code
(`src/plugins/shared-notes`). The preview is block content below a bullet's
text, exactly what `row:body` exists for (ADR 0016, ADR 0031), and it leaves
the three editable render paths untouched.

**A separate read-only connection, never the outline's data layer.** The
editor is one outline per page: one collection, tree store, and history
(ADR 0079). Merging a second outline's nodes into that collection means
several sync streams with their own sequence cursors behind the echo-wait
that makes structural writes atomic (ADR 0009), per-node write routing, and
undo across outlines: the full milestone 3 refactor. A preview needs none of
it. `src/data/space-preview.ts` opens one WebSocket per previewed space to
the same role-checked `/api/spaces/<id>/sync` the space's page uses, speaks
the outline sync protocol (`hello`, `snapshot`, `change`, validated against
the shared `ServerMessageSchema`), and keeps its nodes in its own map.

**Connections follow what's on screen.** Every row previewing a space shares
one connection; it opens when the first row has been on screen and closes
when the last unmounts. Windowed rows (ADR 0019) and an intersection check
keep a long outline from connecting to every shared note at once. A dropped
connection looks the space up again before reconnecting, so a revoked share
turns into "not shared with you" instead of a reconnect loop; it gives up
after four tries.

## Not yet

Editing a shared note inline, and moving bullets between your outline and a
shared note: the rest of milestone 3.

## Tests

`src/data/space-link.test.ts` (which bullets are space links; preview lines,
folding, the cap). `e2e/spaces.spec.ts` (a live preview with a change frame
arriving, read-only, collapse, Open, and a revoked note).
`e2e/worker-browser/spaces-ui.spec.ts` shows Bo's edit in Ann's preview
against the real Worker.
