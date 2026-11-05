---
status: accepted
---

# Comments on shared notes

Milestone 4 of [ADR 0076](./0076-collaboration-workspaces-and-shared-spaces.md):
the **commenter** role gets something to do. People with access to a shared
note ([ADR 0079](./0079-shared-spaces.md)) discuss its bullets in threads.

## Product contract

- **One thread per bullet.** Its comments in order, with author and time, and
  "edited" once changed.
- **Who does what** (`src/data/comments.ts`, shared by the DO, the Worker, and
  the app):
  - anyone with access **reads** comments;
  - commenters, editors, and admins **write** comments and **resolve** or
    **reopen** threads;
  - only the **author edits** a comment (while they can still comment);
  - the **author or an admin deletes** one.
- **Resolving** marks a thread done; it stays readable, and a new comment
  reopens it.
- **In the note:** a bullet with comments shows a count after its text (a
  check when resolved); clicking it opens the thread in the side panel.
  Commenters start a thread from a quiet comment button that appears on the
  row they point at or focus (always faintly visible on touch screens), since
  a read-only note blocks `/`. Editors can also type `/comment`.
- **Only shared notes** have comments. Your own outline doesn't.
- Comments are plain text, up to 4000 characters.

## Decisions

**Stored in the space's Durable Object.** Migration v7 adds `comments` and
`comment_threads` (one row per resolved thread) to `UserOutlineDO`. Comments
then live, and are restored, with the content they're about: PITR covers them
like everything else in the DO, and the nightly R2 snapshot carries them in
optional `comments` / `commentThreads` fields (older snapshots have neither,
and restoring one leaves current comments alone). Comments on a deleted bullet
stay stored; nothing shows them.

**Behind the same role check, with comment rules.** `/api/spaces/:id/comments`
runs through `worker/index.ts`'s space gate (any role or 404), then
`worker/comments.ts` applies the comment rules instead of the content rule
(writes need editor): commenters write. Writes are same-origin and share the
per-user `WORKSPACE_LIMIT`.

**Polling, not the sync socket.** Counts refresh every 30 seconds while the
page is visible and right after you act; an open thread refreshes every 10
seconds. Adding a frame type to the outline sync protocol would make every
older tab warn on each comment, and comments don't need sub-second latency.
Pushing them on the socket is a follow-up once the protocol has an extension
point.

**A plugin.** `src/plugins/comments` uses the `row:after-text` slot (the
budgeted trailing zone), a `/comment` command, and the side panel host
(`ctx.openPanel`). The editor core is unchanged.

## Not yet

Comments on your own outline, and a list of open threads across a note.
Mentions and notifications: [ADR 0082](./0082-collaboration-notifications.md).

## Tests

`src/data/comments.test.ts` (the rules), `worker/comments.test.ts` (the HTTP
handler against an in-memory store: reading, writing, authorship, admin
delete, resolve and reopen, origin), and `e2e/worker-browser/comments.spec.ts`
(three real accounts against the real Worker and DO: a commenter starts a
thread from the row, the owner sees and resolves it, a viewer reads without
controls, the owner deletes).
