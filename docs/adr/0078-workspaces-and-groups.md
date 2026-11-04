---
status: accepted
---

# Workspaces and groups

Milestone 1 of [ADR 0076](./0076-collaboration-workspaces-and-shared-spaces.md).
A **workspace** is a team: people with a workspace role, and named **groups**
of them. It holds no notes yet. Milestone 2 shares notes with a workspace's
people and groups; this one builds who they are.

## Product contract

- **Settings → Workspaces** lists your workspaces with your role and head
  count, any invitations waiting for you (Join / Decline), and "New workspace".
- **Any verified account can create a workspace** and becomes its owner.
  Workspaces are free for now (ADR 0076 open question; a plan gate would sit in
  front of `POST /api/workspaces`).
- **Workspace roles** rank owner > admin > member
  (`src/data/workspace-policy.ts`):
  - Every member sees the workspace's name, people, and groups.
  - Admins and the owner rename it, invite people, revoke invitations, change
    roles, remove people, and manage groups.
  - You act only on people ranked below you, and grant at most your own role,
    so admins manage members (and can make admins); only the owner can demote
    or remove an admin. Nobody can grant "owner".
  - Anyone but the owner can leave. Only the owner deletes the workspace.
- **Invitations go to an email address.** They appear only to a signed-in
  account whose **verified** email matches, which accepts or declines them in
  Settings. Creating one never reveals whether an account exists for the
  address. Re-inviting an address updates the pending role. There is no
  invitation email yet; people find it in Settings.
- **Groups** are named sets of workspace members. Only workspace members can be
  in a group; leaving or being removed takes you out of the workspace's groups.
- **When an account is deleted**, each workspace it owned passes to its
  longest-standing admin, else its longest-standing member; one it was alone in
  is deleted. Its memberships, group memberships, and invitations addressed to
  it are removed.

## Decisions

**D1, not a Durable Object.** Membership is a cross-user directory: "which
workspaces am I in" and "who is in this group" span accounts, which is what D1
is for (ADR 0076). Migration `0015_create_workspaces.sql`: `workspaces`,
`workspace_members` (one owner per workspace by a partial unique index),
`workspace_invites` (unique per workspace and address), `workspace_groups`,
`workspace_group_members`.

**No foreign key from membership to `user`.** Account deletion runs in Better
Auth's `afterDelete`, when the user row is already gone. A cascade would remove
the departing owner's membership before the handoff could see it and leave an
ownerless workspace. `workspaceDeletionStatements` runs the handoff explicitly
in the same batch as the rest of `deleteResidualUserRows`.

**One policy module for both sides.** `src/data/workspace-policy.ts` is pure.
The Worker enforces it on every write; Settings uses it to offer only the
controls that will succeed. The server stays authoritative.

**HTTP surface** (`worker/workspaces.ts`):

| Route                                                    | Who                   |
| -------------------------------------------------------- | --------------------- |
| `GET /api/workspaces` (mine + invitations to me)         | any account           |
| `POST /api/workspaces` (create)                          | any account           |
| `GET /api/workspaces/:id`                                | members               |
| `PATCH` / `DELETE /api/workspaces/:id`                   | admins / owner        |
| `POST /api/workspaces/:id/invites`, `DELETE …/:inviteId` | admins                |
| `PATCH` / `DELETE /api/workspaces/:id/members/:userId`   | by rank; self = leave |
| `POST …/groups`, `PATCH` / `DELETE …/groups/:groupId`    | admins                |
| `PUT …/groups/:groupId/members`                          | admins                |
| `POST /api/workspace-invites/:id/accept` / `decline`     | the invited address   |

A workspace you aren't in is a 404 for reads and writes, so its existence
doesn't leak. Writes require a same-origin request (the capture-keys rule) and
pass a per-user `WORKSPACE_LIMIT` rate limit (60 a minute). Bodies are bounded
and decoded against Effect Schema with excess properties rejected. Membership
is keyed by the Better Auth user id, never the DO-routing id (ADR 0008).

## Not yet

- Ownership transfer, and invitation emails through `worker/email.ts`.
- Anything about notes: sharing with people and groups is milestone 2.

## Tests

`src/data/workspace-policy.test.ts` covers the rules.
`worker/workspaces-store.test.ts` runs the store against the real migration in
SQLite (`worker/testing/d1-sqlite.ts`, a test-only D1 adapter), including every
account-deletion handoff case. `worker/workspaces.test.ts` drives the HTTP
handler: 404s for outsiders, origin and rate limits, input validation, invite
binding, and rank. `e2e/worker-browser/workspaces.spec.ts` uses two real
accounts in two browsers against the real Worker and D1: create, invite, join,
group, promote, and leave.
