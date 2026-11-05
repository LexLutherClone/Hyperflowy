---
status: accepted
---

# Copy and move between your outline and shared notes

Milestone 5 of [ADR 0076](./0076-collaboration-workspaces-and-shared-spaces.md),
in the shape the owner decided: private content never reaches a share through
a mirror; instead you **copy** it, choosing which children come along.

## Product contract

- **"Copy or move to a shared note…"** (View menu, on a zoomed page of your
  own outline) picks a shared note you can edit (editor or admin) and:
  - **Copy:** the page and the bullets you leave ticked. Unticking a bullet
    drops it and everything under it.
  - **Move:** the page and everything under it, then it leaves your outline.
    Refused, like sharing, for locked bullets, daily-note pages, or a mirror
    elsewhere in your outline that points into it.
- **"Copy to my outline…"** (View menu, on a shared note you can read, any
  role) copies a bullet and the children you tick to the end of your outline.
- **Copies are independent.** Fresh ids; a mirror becomes a plain bullet with
  the text it mirrors, so nothing in the share stays linked to your private
  outline (and a copy out isn't tied to the note). Owner locks and bookmarks
  are personal and don't travel. Copies land after the target's last bullet
  (under a shared page's top bullet), in their original order.

## Why mirrors can't cross

A mirror windows content in the same outline (ADR 0022), and each outline is
its own Durable Object (ADR 0079). The mirror picker only lists bullets of the
outline you're in, so a mirror of private content can't be placed in a shared
note at all: the refusal ADR 0076 asked for holds by construction, and this
dialog is the alternative it asked for. **Swap** (move a mirror's source into
the share and leave a mirror behind) needs mirrors across outlines and stays a
future step.

## Decisions

**Copy first, delete second.** `POST /api/spaces/:id/copy-in` plans the copy
(`worker/copy-plan.ts`, pure), writes the copies to the space's DO as one
batch, and only for a move then deletes the originals and relinks the sibling
chain around them. A failed copy changes nothing; a move whose originals
couldn't be removed says so (`removed: false`) and leaves both.

**The request names what to leave out.** The dialog sends the roots of the
unticked branches (`exclude`), not every ticked bullet, so a large page stays
within the bounded request body.

**Roles.** Copying in needs edit rights on the target note (the Worker checks
`canEdit`, and the DO's lock validation still applies to the batch). Copying
out needs only read access: anyone who can read a note can already retype it.

## Tests

`worker/copy-plan.test.ts` (selection, ordering, mirrors flattened, locks and
bookmarks dropped, landing, move refusals and chain relink),
`worker/spaces.test.ts` (roles on copy-in and copy-out, move removing
originals), and `e2e/worker-browser/copy.spec.ts` (the dialog with a branch
unticked and a private mirror, a move, and a viewer copying out, against the
real Worker and DOs).
