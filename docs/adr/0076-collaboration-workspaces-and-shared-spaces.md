---
status: proposed
---

# Collaboration: workspaces, shared spaces, roles

Hyperflowy grows from one private outline per account into notes shared with
people and teams. This ADR records the product decisions and the architecture
that carries them, and splits the work into milestones. Each milestone gets its
own ADR as it is built; this one is the map.

## Product decisions (owner, 2026-11-04)

- **Private by default.** Everything in a personal outline stays visible only
  to its owner. Sharing is an explicit act on a node.
- **Four roles** on a shared space, each including the one before it:
  - **Viewer:** read the subtree.
  - **Commenter:** read, and comment on nodes.
  - **Editor:** read, comment, and change content and structure.
  - **Admin:** everything an editor can do, plus manage who has access, and
    re-share.
- **Recipients are Hyperflowy accounts.** Shares go to people by the email of
  their account, or to groups of them. No anonymous or public links.
- **Shared team workspaces.** A workspace is a team: it has members, and it
  owns the named groups ("Design", "Leads") that members share with. Groups are
  managed by workspace admins and visible to all members.
- **Mirrors never carry private content into a share.** Mirroring a node the
  space's collaborators can't see into a shared space is refused with an
  explanation, and offers to **copy** it instead, with a choice of which
  children come along. Later: a **swap** that moves the source into the shared
  space and leaves a mirror where it was.

## Architecture

**One Durable Object per shared space.** A shared subtree moves out of its
owner's `UserOutlineDO` into its own `SpaceDO`, the same class shape (SQLite
nodes table, changelog, WebSocket fan-out, PITR, R2 snapshots). The personal
outline keeps a **mount node** where the subtree was; every member's outline
gets one too, placed where they choose. Per-object single-writer ordering,
isolation, and backups all carry over unchanged (ADR 0008), and the permission
boundary is the object boundary: a DO holds exactly one space's content.
Rejected: serving collaborators a filtered view of the owner's DO. Moves across
the private/shared line, search, backlinks, and daily notes would all have to
filter row by row, and one bug leaks private notes.

**Access control in D1.** New tables: `workspaces`, `workspace_members`
(role: owner, admin, member), `groups`, `group_members`, `spaces` (owner, and
optionally the workspace that owns it), and `space_grants` (grantee is a user
or a group, role is one of the four above). A user's role on a space is the
highest of their direct grant and their groups' grants. The Worker resolves it
on connect and on every write and passes it to the `SpaceDO`, which enforces it
per operation; a revoked grant closes the member's socket.

**The client reads several objects as one tree.** Today one socket feeds one
collection. A member's outline becomes their own DO plus one sync stream per
mounted space, merged into the tree store, with each node tagged by the space
that owns it. Writes route to the owning space; a viewer's or commenter's
nodes render read-only.

**Crossing a boundary is copy then delete.** Moving nodes between the personal
outline and a space, or between spaces, can't be one atomic batch across two
objects. It runs as an idempotent operation: write the copy with fresh ids,
verify, then delete the original, resumable if interrupted.

**Mirrors.** Inside one space, mirrors work as today (ADR 0022). Across spaces,
`mirrorOf` becomes a (space, node) reference. A mirror renders only for viewers
who can read its source, and editing through it needs edit rights on the
source. A mirror of private content placed into a shared space is refused (the
product rule above), which keeps backlinks, search, MCP, and export from ever
reaching it.

**Everything that reads content respects the role.** Search, DQL, backlinks,
OPML and markdown export, MCP and the CLI resolve the caller's spaces and role
first. Spoiler redaction for agents (ADR 0043) applies inside spaces too.

**Backups per space.** The nightly R2 sweep and PITR restore include every
`SpaceDO`. Restoring a space affects all its members, so it is an admin action
with an explicit confirmation. The sweep moves onto Queues or Workflows before
the object count outgrows one cron invocation's subrequest budget.

## Milestones

0. **Concurrent text merge.** Done: [ADR 0077](./0077-concurrent-text-merge.md).
1. **Workspaces and groups.** Done:
   [ADR 0078](./0078-workspaces-and-groups.md).
2. **Shared spaces.** Done: [ADR 0079](./0079-shared-spaces.md). A space
   opens at its own address; milestone 3 brings it inline into your outline.
3. **Multi-space client.** First step done: live read-only previews of shared
   notes inside your outline
   ([ADR 0080](./0080-inline-shared-note-previews.md)). Still to do: several
   sync streams in one tree for inline editing, cross-space moves,
   permission-aware search, backlinks, export, MCP, CLI.
4. **Comments and the Commenter role.** Done:
   [ADR 0081](./0081-comments.md). Mentions and notifications are next.
5. **Mirrors across spaces.** (space, node) mirrors, the refusal rule, and the
   selective-copy dialog.
6. **Swap.** Move a mirror's source into a shared space, leaving a mirror
   behind.

## Open questions for the owner

Defaults in effect until the owner decides (2026-11-04, "proceed"):

- **Who may create a workspace, and is it paid?** Any verified account, free.
  A plan check in front of `POST /api/workspaces` changes that without a
  migration.
- **When a member leaves, what happens to spaces they own?** Membership ends;
  the workspace keeps its groups. For spaces (milestone 2), a space owned by a
  workspace stays with the workspace. When an owning account is deleted,
  ownership passes to the longest-standing admin, else member (ADR 0078).
- **Can a space be shared beyond its workspace?** Yes, with any account by
  email; groups only from workspaces the sharer belongs to (ADR 0079).
