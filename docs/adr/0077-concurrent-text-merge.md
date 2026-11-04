---
status: accepted
---

# Concurrent text merge

Two writers editing one node's text at once used to lose one writer's edit. A
field PATCH carried only the new text, and the Durable Object applied it
last-write-wins (ADR 0010). Single-user multi-device use rarely hit that;
sharing (ADR 0076) makes it ordinary. A text write now says what it was derived
from, and the DO merges instead of overwriting when that base is stale.

This is milestone 0 of ADR 0076. It needs no CRDT and changes no storage: the
DO's single writer thread stays the referee (ADR 0008), and node text stays a
plain string.

## Contract

- **`baseText` on the PATCH.** Each update in `PATCH /api/nodes` may carry
  `baseText`, the text its `changes.text` was derived from (`worker/wire.ts`).
- **The DO merges a stale base.** In the same storage transaction as the write,
  `rebaseTextPatches` (`worker/text-patch.ts`) compares the stored text with
  the base. Equal (nobody else wrote): the write applies verbatim. Different:
  the writer's change (base → new text) is re-applied to the stored text with
  diff-match-patch patches, which find each hunk by its surrounding context
  (`src/data/text-merge.ts`). The merged row is what is stored and broadcast.
- **Conflicts keep both sides' intent where possible.** A hunk whose context is
  gone (both writers rewrote the same words) is dropped, and the other writer's
  text stands for that region. Every hunk that fits is still applied.
- **No base, no merge.** An update without `baseText` (an older client, a
  non-text field) is last-write-wins exactly as before. MCP, the CLI, undo
  snapshots, and structural batches are unchanged by this ADR.

## The client: what an edit was derived from

The base must be exactly the server text the local edit started from, or the
merge duplicates or reverts text. `src/data/text-shadow.ts` holds that per
node, as a "shadow" in the sense of differential synchronization:

- **Edit start.** When a node's editor gains focus (an outline row or zoomed
  title, `data-history-node-id`; a board card editor, `data-text-shadow-id`),
  the stored text it shows becomes the shadow.
- **Send.** A sent text becomes the shadow. The server holds a merge containing
  it, so the next write's change is only what was typed since.
- **Release.** While the node is focused, the shadow outlives server echoes.
  The focused editor ignores echoes (ADR 0010), so its DOM is still derived
  from the shadow, not the newer server text. Once nothing is pending or in
  flight for the node and it is not being edited, the shadow is dropped, and
  the next edit's base is the mutation's original store value, by then server
  text. A failed write drops it with the rollback.

`updateNodes` (`src/data/api.ts`) keeps the first base of each coalesced
generation, since later keystrokes in that generation build on it, and a
generation sealed by a structural write still counts as pending.

## Consequences

- **A remote edit to the bullet you are typing in appears when you leave it**,
  not live: the focused DOM still ignores echoes (ADR 0010). Neither edit is
  lost. Rebasing the focused DOM live (merge the incoming server text into the
  DOM, transform the caret) is a follow-up that needs care on the hot path.
- **Undo restores a snapshot** with a structural batch, so undoing your edit
  after someone else edited the same node can overwrite their edit. Unchanged
  by this ADR; a merge-aware undo is a follow-up.
- `diff-match-patch` (Apache-2.0, no dependencies) is a new runtime dependency
  of both the app and the Worker.

## Tests

`src/data/text-merge.test.ts` and `worker/text-patch.test.ts` cover the merge
and the DO's decision. `src/data/text-shadow.test.ts` covers base selection,
including an end-to-end typing race. `e2e/worker-browser/concurrent-text.spec.ts`
runs two tabs against the real Worker and DO: one keeps typing in a bullet while
the other prefixes it, and both edits must survive. With the merge disabled the
spec fails with the prefix erased.
