/// <reference types="@cloudflare/workers-types" />

import type {
  GrantableRole,
  WorkspaceRole,
} from "../src/data/workspace-policy";

import { normalizeEmail } from "./invites";

/**
 * D1 reads and writes for workspaces, members, invitations, and groups
 * (ADR 0078). No authorization here: the handler checks `workspace-policy`
 * first. Every multi-row write is one `db.batch`, which D1 runs as a
 * transaction.
 */

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: WorkspaceRole;
  memberCount: number;
}

export interface PendingInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: GrantableRole;
  invitedByName: string | null;
  createdAt: number;
}

export interface WorkspaceMember {
  userId: string;
  name: string | null;
  email: string | null;
  role: WorkspaceRole;
  joinedAt: number;
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  memberIds: string[];
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: GrantableRole;
  createdAt: number;
}

export interface WorkspaceDetail {
  workspace: { id: string; name: string; role: WorkspaceRole };
  members: WorkspaceMember[];
  groups: WorkspaceGroup[];
  /** Only for admins and the owner; members see none. */
  invites: WorkspaceInvite[];
}

const id = () => crypto.randomUUID();

export async function listWorkspaces(
  db: D1Database,
  userId: string,
  verifiedEmail: string | null,
): Promise<{ workspaces: WorkspaceSummary[]; invites: PendingInvite[] }> {
  const workspaces = await db
    .prepare(
      `SELECT w.id, w.name, m.role,
        (SELECT COUNT(*) FROM workspace_members c WHERE c.workspaceId = w.id) AS memberCount
       FROM workspace_members m JOIN workspaces w ON w.id = m.workspaceId
       WHERE m.userId = ? ORDER BY w.name COLLATE NOCASE, w.id`,
    )
    .bind(userId)
    .all<WorkspaceSummary>();
  const invites = verifiedEmail
    ? await db
        .prepare(
          `SELECT i.id, i.workspaceId, w.name AS workspaceName, i.role,
            u.name AS invitedByName, i.createdAt
           FROM workspace_invites i JOIN workspaces w ON w.id = i.workspaceId
           LEFT JOIN "user" u ON u.id = i.invitedBy
           WHERE i.email = ?
             AND NOT EXISTS (SELECT 1 FROM workspace_members m
                             WHERE m.workspaceId = i.workspaceId AND m.userId = ?)
           ORDER BY i.createdAt`,
        )
        .bind(normalizeEmail(verifiedEmail), userId)
        .all<PendingInvite>()
    : { results: [] };
  return { workspaces: workspaces.results, invites: invites.results };
}

export async function createWorkspace(
  db: D1Database,
  userId: string,
  name: string,
  now: number,
): Promise<WorkspaceSummary> {
  const workspaceId = id();
  await db.batch([
    db
      .prepare(
        "INSERT INTO workspaces (id, name, createdBy, createdAt) VALUES (?, ?, ?, ?)",
      )
      .bind(workspaceId, name, userId, now),
    db
      .prepare(
        "INSERT INTO workspace_members (workspaceId, userId, role, joinedAt) VALUES (?, ?, 'owner', ?)",
      )
      .bind(workspaceId, userId, now),
  ]);
  return { id: workspaceId, name, role: "owner", memberCount: 1 };
}

export async function roleOf(
  db: D1Database,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const row = await db
    .prepare(
      "SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?",
    )
    .bind(workspaceId, userId)
    .first<{ role: WorkspaceRole }>();
  return row?.role ?? null;
}

export async function getWorkspaceDetail(
  db: D1Database,
  workspaceId: string,
  role: WorkspaceRole,
  includeInvites: boolean,
): Promise<WorkspaceDetail | null> {
  const [head, members, groups, groupMembers, invites] = await Promise.all([
    db
      .prepare("SELECT id, name FROM workspaces WHERE id = ?")
      .bind(workspaceId)
      .first<{ id: string; name: string }>(),
    db
      .prepare(
        `SELECT m.userId, u.name, u.email, m.role, m.joinedAt
         FROM workspace_members m LEFT JOIN "user" u ON u.id = m.userId
         WHERE m.workspaceId = ?
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
           u.name COLLATE NOCASE, m.userId`,
      )
      .bind(workspaceId)
      .all<WorkspaceMember>(),
    db
      .prepare(
        "SELECT id, name FROM workspace_groups WHERE workspaceId = ? ORDER BY name COLLATE NOCASE, id",
      )
      .bind(workspaceId)
      .all<{ id: string; name: string }>(),
    db
      .prepare(
        `SELECT gm.groupId, gm.userId FROM workspace_group_members gm
         JOIN workspace_groups g ON g.id = gm.groupId WHERE g.workspaceId = ?`,
      )
      .bind(workspaceId)
      .all<{ groupId: string; userId: string }>(),
    includeInvites
      ? db
          .prepare(
            "SELECT id, email, role, createdAt FROM workspace_invites WHERE workspaceId = ? ORDER BY createdAt",
          )
          .bind(workspaceId)
          .all<WorkspaceInvite>()
      : null,
  ]);
  if (!head) return null;
  const byGroup = new Map<string, string[]>();
  for (const row of groupMembers.results) {
    const list = byGroup.get(row.groupId) ?? [];
    list.push(row.userId);
    byGroup.set(row.groupId, list);
  }
  return {
    workspace: { id: head.id, name: head.name, role },
    members: members.results,
    groups: groups.results.map((g) => ({
      ...g,
      memberIds: byGroup.get(g.id) ?? [],
    })),
    invites: invites?.results ?? [],
  };
}

export async function renameWorkspace(
  db: D1Database,
  workspaceId: string,
  name: string,
): Promise<void> {
  await db
    .prepare("UPDATE workspaces SET name = ? WHERE id = ?")
    .bind(name, workspaceId)
    .run();
}

export async function deleteWorkspace(
  db: D1Database,
  workspaceId: string,
): Promise<void> {
  // Children first, so this holds whether or not D1 enforces the cascades.
  await db.batch([
    db
      .prepare(
        "DELETE FROM workspace_group_members WHERE groupId IN (SELECT id FROM workspace_groups WHERE workspaceId = ?)",
      )
      .bind(workspaceId),
    db
      .prepare("DELETE FROM workspace_groups WHERE workspaceId = ?")
      .bind(workspaceId),
    db
      .prepare("DELETE FROM workspace_invites WHERE workspaceId = ?")
      .bind(workspaceId),
    db
      .prepare("DELETE FROM workspace_members WHERE workspaceId = ?")
      .bind(workspaceId),
    db.prepare("DELETE FROM workspaces WHERE id = ?").bind(workspaceId),
  ]);
}

/** Create or update the invitation for `email`. Never reveals whether an
 *  account exists for it. */
export async function inviteToWorkspace(
  db: D1Database,
  workspaceId: string,
  email: string,
  role: GrantableRole,
  invitedBy: string,
  now: number,
): Promise<WorkspaceInvite> {
  const normalized = normalizeEmail(email);
  const row = await db
    .prepare(
      `INSERT INTO workspace_invites (id, workspaceId, email, role, invitedBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspaceId, email) DO UPDATE SET role = excluded.role
       RETURNING id, email, role, createdAt`,
    )
    .bind(id(), workspaceId, normalized, role, invitedBy, now)
    .first<WorkspaceInvite>();
  // SAFETY: an INSERT ... RETURNING always yields the written row.
  return row!;
}

export async function revokeInvite(
  db: D1Database,
  workspaceId: string,
  inviteId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM workspace_invites WHERE id = ? AND workspaceId = ?")
    .bind(inviteId, workspaceId)
    .run();
  return result.meta.changes > 0;
}

/** Accept an invitation addressed to `verifiedEmail`. Returns the workspace id,
 *  or null when no such invitation exists for that address. */
export async function acceptInvite(
  db: D1Database,
  inviteId: string,
  userId: string,
  verifiedEmail: string,
  now: number,
): Promise<string | null> {
  const invite = await db
    .prepare(
      "SELECT workspaceId, role FROM workspace_invites WHERE id = ? AND email = ?",
    )
    .bind(inviteId, normalizeEmail(verifiedEmail))
    .first<{ workspaceId: string; role: GrantableRole }>();
  if (!invite) return null;
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO workspace_members (workspaceId, userId, role, joinedAt) VALUES (?, ?, ?, ?)",
      )
      .bind(invite.workspaceId, userId, invite.role, now),
    db.prepare("DELETE FROM workspace_invites WHERE id = ?").bind(inviteId),
  ]);
  return invite.workspaceId;
}

export async function declineInvite(
  db: D1Database,
  inviteId: string,
  verifiedEmail: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM workspace_invites WHERE id = ? AND email = ?")
    .bind(inviteId, normalizeEmail(verifiedEmail))
    .run();
  return result.meta.changes > 0;
}

export async function setMemberRole(
  db: D1Database,
  workspaceId: string,
  userId: string,
  role: GrantableRole,
): Promise<void> {
  await db
    .prepare(
      "UPDATE workspace_members SET role = ? WHERE workspaceId = ? AND userId = ? AND role != 'owner'",
    )
    .bind(role, workspaceId, userId)
    .run();
}

export async function removeMember(
  db: D1Database,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM workspace_group_members WHERE userId = ?1
           AND groupId IN (SELECT id FROM workspace_groups WHERE workspaceId = ?2)
           AND NOT EXISTS (SELECT 1 FROM workspace_members
                           WHERE workspaceId = ?2 AND userId = ?1 AND role = 'owner')`,
      )
      .bind(userId, workspaceId),
    db
      .prepare(
        "DELETE FROM workspace_members WHERE workspaceId = ? AND userId = ? AND role != 'owner'",
      )
      .bind(workspaceId, userId),
  ]);
}

export async function createGroup(
  db: D1Database,
  workspaceId: string,
  name: string,
  now: number,
): Promise<WorkspaceGroup> {
  const groupId = id();
  await db
    .prepare(
      "INSERT INTO workspace_groups (id, workspaceId, name, createdAt) VALUES (?, ?, ?, ?)",
    )
    .bind(groupId, workspaceId, name, now)
    .run();
  return { id: groupId, name, memberIds: [] };
}

export async function renameGroup(
  db: D1Database,
  workspaceId: string,
  groupId: string,
  name: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE workspace_groups SET name = ? WHERE id = ? AND workspaceId = ?",
    )
    .bind(name, groupId, workspaceId)
    .run();
  return result.meta.changes > 0;
}

export async function deleteGroup(
  db: D1Database,
  workspaceId: string,
  groupId: string,
): Promise<boolean> {
  const [, removed] = await db.batch([
    db
      .prepare(
        "DELETE FROM workspace_group_members WHERE groupId IN (SELECT id FROM workspace_groups WHERE id = ? AND workspaceId = ?)",
      )
      .bind(groupId, workspaceId),
    db
      .prepare("DELETE FROM workspace_groups WHERE id = ? AND workspaceId = ?")
      .bind(groupId, workspaceId),
  ]);
  return (removed?.meta.changes ?? 0) > 0;
}

/** Replace a group's members. Ids that aren't members of the workspace are
 *  ignored, so a group can only ever hold workspace members. */
export async function setGroupMembers(
  db: D1Database,
  workspaceId: string,
  groupId: string,
  userIds: readonly string[],
): Promise<boolean> {
  const exists = await db
    .prepare("SELECT 1 FROM workspace_groups WHERE id = ? AND workspaceId = ?")
    .bind(groupId, workspaceId)
    .first();
  if (!exists) return false;
  await db.batch([
    db
      .prepare("DELETE FROM workspace_group_members WHERE groupId = ?")
      .bind(groupId),
    ...[...new Set(userIds)].map((userId) =>
      db
        .prepare(
          `INSERT INTO workspace_group_members (groupId, userId)
           SELECT ?, ? WHERE EXISTS (SELECT 1 FROM workspace_members
                                     WHERE workspaceId = ? AND userId = ?)`,
        )
        .bind(groupId, userId, workspaceId, userId),
    ),
  ]);
  return true;
}

/**
 * Account deletion (worker/account-deletion.ts). A workspace the user owns
 * alone is deleted. Then their memberships, group memberships, and the
 * invitations addressed to them go, and every workspace left without an owner
 * promotes a successor: the longest-standing admin, else the longest-standing
 * member. Ordered statements for one batch (D1 runs a batch as a transaction).
 */
export function workspaceDeletionStatements(
  db: D1Database,
  userId: string,
  email: string,
): D1PreparedStatement[] {
  const alone = `SELECT m.workspaceId FROM workspace_members m
    WHERE m.userId = ?1 AND m.role = 'owner'
      AND NOT EXISTS (SELECT 1 FROM workspace_members o
                      WHERE o.workspaceId = m.workspaceId AND o.userId != ?1)`;
  return [
    ...[
      `DELETE FROM workspace_group_members WHERE groupId IN
         (SELECT id FROM workspace_groups WHERE workspaceId IN (${alone}))`,
      `DELETE FROM workspace_groups WHERE workspaceId IN (${alone})`,
      `DELETE FROM workspace_invites WHERE workspaceId IN (${alone})`,
      `DELETE FROM workspaces WHERE id IN (${alone})`,
      `DELETE FROM workspace_members WHERE workspaceId IN (${alone})`,
      "DELETE FROM workspace_group_members WHERE userId = ?1",
      "DELETE FROM workspace_members WHERE userId = ?1",
      `UPDATE workspace_members SET role = 'owner'
       WHERE rowid IN (
         SELECT (SELECT s.rowid FROM workspace_members s
                 WHERE s.workspaceId = w.id
                 ORDER BY CASE s.role WHEN 'admin' THEN 0 ELSE 1 END,
                   s.joinedAt, s.userId
                 LIMIT 1)
         FROM workspaces w
         WHERE NOT EXISTS (SELECT 1 FROM workspace_members o
                           WHERE o.workspaceId = w.id AND o.role = 'owner'))`,
    ].map((sql) =>
      sql.includes("?1") ? db.prepare(sql).bind(userId) : db.prepare(sql),
    ),
    db
      .prepare("DELETE FROM workspace_invites WHERE email = ?")
      .bind(normalizeEmail(email)),
  ];
}
