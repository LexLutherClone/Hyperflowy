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

## Tests

`worker/share-plan.test.ts` (the plan and every refusal),
`worker/spaces-store.test.ts` (roles through email and group grants, the
ownership handoff, against the real migrations in SQLite),
`worker/spaces.test.ts` (the HTTP handler with in-memory DOs: copy-then-delete,
a failed copy, refusals, grants, revocation resetting connections, group
grants needing workspace membership, account deletion), and
`e2e/worker-browser/spaces-api.spec.ts` (two real accounts against the real
Worker, DOs, and D1: share, role checks on reads, writes, and the live socket,
revocation closing it, and a refused reconnect).
