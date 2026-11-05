---
status: accepted
---

# Ending a share: stop sharing and leave

Completes the shared-note lifecycle of
[ADR 0079](./0079-shared-spaces.md).

## Product contract

- **Stop sharing (owner only).** "Stop sharing…" in the Share dialog, after a
  confirmation, brings the note back into the owner's outline and ends the
  share: everyone else loses access at once, and the space, with its comments
  ([ADR 0081](./0081-comments.md)), is deleted. The note returns **in place**:
  the link bullet sharing left takes the note's top bullet back, at the same
  position, with everything under it, including what collaborators added. If
  the link bullet is gone (the owner deleted it), the note is appended at the
  end of the outline instead.
- **Leave (anyone shared with by email).** "Leave" in the banner removes the
  grant to your own email. If you still have access through a workspace
  group, you're told so; otherwise you're taken back to your outline and the
  note is unavailable to you. Owners don't leave; they stop sharing.

## Decisions

**Write back first, wipe second.** `POST /api/spaces/:id/unshare` reads the
space and the owner's outline, plans the return (`planUnshare` in
`worker/share-plan.ts`, pure), writes it to the owner's outline, and only then
closes the space's sockets, wipes its Durable Object, and deletes its D1 rows.
A failed write-back changes nothing and the note stays shared.

**Ids come home.** The returned bullets keep their space ids, so mirrors
inside the note keep pointing at the right bullets (a mirror of the top bullet
now points at the link bullet, which took its place). When that can't work
(no single top bullet, or an id already used in the owner's outline, e.g.
after a copy out), the note is appended as a plain copy
([ADR 0083](./0083-copy-and-move-between-outlines.md)) instead.

**Leaving is narrow.** A non-admin's grant removal is accepted only for the
grant to their own verified email; anything else stays admin-only. The answer
says whether access remains through a group.

**Only the owner stops sharing.** Admins manage access but can't delete the
note for everyone; ownership is the authority over the content's existence.

## Tests

`worker/share-plan.test.ts` (the return in place, mirrors remapped, the
fallbacks), `worker/spaces.test.ts` (owner-only unshare writing back before
wiping, leaving only your own grant), and
`e2e/worker-browser/lifecycle.spec.ts` (a collaborator leaves; the owner
stops sharing and gets the note back in place with the collaborator's
addition, and the space is unreachable and wiped).
