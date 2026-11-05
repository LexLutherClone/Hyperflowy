---
status: accepted
---

# Shared spaces

Milestone 2 of [ADR 0076](./0076-collaboration-workspaces-and-shared-spaces.md).
A **space** is one shared subtree with its own Durable Object, shared with
people (by their account's email) and with workspace groups
([ADR 0078](./0078-workspaces-and-groups.md)), each as viewer, commenter,
editor, or admin.

## Product contract

- **Share a bullet.** Sharing moves the bullet and everything under it into a
  new space. In the owner's outline the bullet stays exactly where it was and
  becomes a link to the space (`[Name](https://…/s/<id>)`); its children now
  live in the space.
- **Refused shares explain themselves:** a locked bullet or descendant
  (ADR 0067), a daily-note page or container (ADR 0052), or a mirror crossing
  the boundary in either direction (ADR 0076's rule: nothing private rides into
  a share, and no mirror is orphaned). Copying instead of mirroring is
  ADR 0076 milestone 5.
- **Roles** (`src/data/space-policy.ts`): viewer reads; commenter reads (and
  comments, once ADR 0076 milestone 4 exists); editor changes content and
  structure; admin also manages access. The owner is always an admin. A
  person's role is the highest of the grants reaching them: one to their
  verified email, one per group they're in.
- **Who can be granted:** any account, by email (only a signed-in account with
  that verified email holds the grant, so granting never reveals whether an
  account exists), and any group of a workspace the granting admin belongs to.
  Default for ADR 0076's open question "beyond its workspace?": yes, by email.
- **Revoking is immediate.** Removing a grant, or anything that takes someone
  out of a group (removed from the workspace, the group edited or deleted, the
  workspace deleted), closes every live connection to the affected spaces.
  Clients reconnect and pass the role check again; whoever lost access is
  refused.
- **When the owner's account is deleted,** the space passes to the
  highest-ranked, longest-standing email grant held by an existing verified
  account. A space nobody can inherit is wiped with its Durable Object.

## In the app

- **"Share this page…"** in the View menu (on a zoomed page of your own
  outline) shares it and opens the new space with its Share dialog.
- **A space opens at `/s/<id>`**, with a banner naming it and your role, a
  Share button for admins, and a way back to your outline. Everything in the
  editor works there: zoom (`/s/<id>/<nodeId>`), board view, mirrors within
  the space, undo, search, filters. Daily notes are off in a space, and an
  empty space is never seeded with the welcome outline.
- **The Share dialog** renames the space, shares with a person by email or a
  group from your workspaces, changes a grant's role, and removes it.
- **Settings → Shared notes** lists the spaces you own or that are shared
  with you.
- **View-only roles** (viewer, commenter) get a read-only editor: every node
  reads as locked, so every editing affordance the lock already disables is
  disabled. The Worker refuses their writes regardless.
- **A space you can't reach** (deleted, never shared with you, or revoked)
  shows a plain message with a way back.

## Decisions

**A space is a `UserOutlineDO` named `space:<id>`.** Same class, same storage,
changelog, sync protocol, PITR, and R2 snapshots as a personal outline, with
no new class and no wrangler migration. Better Auth ids never contain a colon,
so the names can't collide. The nightly backup sweep includes every space
(`worker/index.ts` `runBackupSweep`).

**Same endpoints, behind a role check.** A space's content runs on
`/api/spaces/:id/sync`, `/nodes`, and `/kv`, the personal outline's endpoints
pointed at the space's DO. The Worker resolves the caller's role on every
request: any role reads (and opens the socket), editor or admin writes. The DO
trusts the Worker (ADR 0014), so this check is the boundary. A space's node
limit follows its owner's plan.

**Copy, then delete.** `POST /api/spaces { nodeId }` plans the share
(`worker/share-plan.ts`, pure), writes the D1 row, copies the subtree into the
space's DO, and only then rewrites the personal outline: the root becomes the
link, its descendants are deleted. A failed copy deletes the D1 row and
changes nothing. A failed rewrite leaves the content in both places and says
so (`replaced: false`). The read-to-rewrite window is not transactional across
two objects: an edit to a descendant on another device during it is lost from
the personal outline, which is where the descendant is being deleted anyway.

**Access in D1** (migration `0016_create_spaces.sql`): `spaces` and
`space_grants` (grantee type `email` or `group`). Like migration 0015, no
foreign key to `user`: the ownership handoff runs explicitly, in
`beforeDelete`, while the account still exists (`releaseOwnedSpaces`). Grants
addressed to a deleted account's email are removed with its residual rows;
grants to a deleted group go with the group.

**Revocation by reset, not bookkeeping.** `disconnectAll()` closes the space's
sockets with code 4001. The DO keeps no per-user socket map that could drift
from D1; the Worker's role check on reconnect is the single source of truth.

**Management API** (`worker/spaces.ts`, same-origin writes, the
`WORKSPACE_LIMIT` rate limit, 404 for anyone without a role):

| Route                                       | Who         |
| ------------------------------------------- | ----------- |
| `GET /api/spaces` (mine and shared with me) | any account |
| `POST /api/spaces { nodeId }` (share)       | any account |
| `GET /api/spaces/:id`                       | any role    |
| `PATCH /api/spaces/:id { name }`            | admin       |
| `PUT` / `DELETE /api/spaces/:id/grants`     | admin       |

**One outline per page.** The data layer is module singletons (one
collection, one tree store, one history), so a page edits exactly one outline,
chosen once at load from the address (`src/data/outline-scope.ts`). In a space
the outline endpoints point at `/api/spaces/<id>/…`, the router rewrites
addresses under `/s/<id>` (a `rewrite`, because TanStack Start resets
`basepath` when it hydrates), and moving between your outline and a space is
a full page load. Account data stays personal: preferences, saved filters,
the changelog cursor, the daily index. A space's board views and tag colors
belong to the space. Showing a space inline inside your own outline is
ADR 0076 milestone 3.

**The role arrives before the editor.** `SpaceGate` holds the app until
`GET /api/spaces/:id` answers, so a view-only role makes the outline
read-only from its first render (`setReadOnlyOutline` in `src/data/tree.ts`,
never set in the Worker).

## Tests

`worker/share-plan.test.ts` (the plan and every refusal),
`worker/spaces-store.test.ts` (roles through email and group grants, the
ownership handoff, against the real migrations in SQLite),
`worker/spaces.test.ts` (the HTTP handler with in-memory DOs: copy-then-delete,
a failed copy, refusals, grants, revocation resetting connections, group
grants needing workspace membership, account deletion), and
`e2e/worker-browser/spaces-api.spec.ts` (two real accounts against the real
Worker, DOs, and D1: share, role checks on reads, writes, and the live socket,
revocation closing it, and a refused reconnect). `e2e/worker-browser/spaces-ui.spec.ts` drives the app with two real
accounts: share from the View menu, grant in the Share dialog, open it from
Settings, edit it live, zoom inside the space, downgrade to view-only, and
revoke.
