/// <reference types="@cloudflare/workers-types" />

import { highestRole, type SpaceRole } from "../src/data/space-policy";
import { normalizeEmail } from "./invites";

/**
 * D1 reads and writes for shared spaces and their grants (ADR 0079). No
 * authorization here: `worker/spaces.ts` checks `space-policy` first.
 */

export interface Space {
  id: string;
  name: string;
  ownerId: string;
  createdAt: number;
}

export interface SpaceSummary {
  id: string;
  name: string;
  role: SpaceRole;
  ownerId: string;
  ownerName: string | null;
}

export type GranteeType = "email" | "group";

export interface SpaceGrant {
  granteeType: GranteeType;
  granteeId: string;
  role: SpaceRole;
  /** The email, or "Group · Workspace". */
  label: string;
}

/** The Durable Object name of a space (same class as personal outlines;
 *  Better Auth ids never contain a colon, so the names can't collide). */
export const spaceObjectName = (spaceId: string) => `space:${spaceId}`;

export async function createSpace(db: D1Database, space: Space): Promise<void> {
  await db
    .prepare(
      "INSERT INTO spaces (id, name, ownerId, createdAt) VALUES (?, ?, ?, ?)",
    )
    .bind(space.id, space.name, space.ownerId, space.createdAt)
    .run();
}

export async function getSpace(
  db: D1Database,
  spaceId: string,
): Promise<Space | null> {
  return db
    .prepare("SELECT id, name, ownerId, createdAt FROM spaces WHERE id = ?")
    .bind(spaceId)
    .first<Space>();
}

/** The roles reaching a user on spaces: owner, email grant, group grants.
 *  `spaceFilter` narrows to one space. One row per path to the space. */
function reachSql(spaceFilter: boolean) {
  const one = spaceFilter ? "AND s.id = ?4" : "";
  return `
    SELECT s.id, s.name, s.ownerId, 'admin' AS role FROM spaces s
      WHERE s.ownerId = ?1 ${one}
    UNION ALL
    SELECT s.id, s.name, s.ownerId, g.role FROM space_grants g
      JOIN spaces s ON s.id = g.spaceId
      WHERE g.granteeType = 'email' AND g.granteeId = ?2 ${one}
    UNION ALL
    SELECT s.id, s.name, s.ownerId, g.role FROM space_grants g
      JOIN workspace_group_members gm ON gm.groupId = g.granteeId
      JOIN spaces s ON s.id = g.spaceId
      WHERE g.granteeType = 'group' AND gm.userId = ?3 ${one}`;
}

type ReachRow = { id: string; name: string; ownerId: string; role: SpaceRole };

export async function roleFor(
  db: D1Database,
  spaceId: string,
  userId: string,
  verifiedEmail: string | null,
): Promise<SpaceRole | null> {
  const { results } = await db
    .prepare(reachSql(true))
    // An unverified account matches no email grant: "" is never stored.
    .bind(
      userId,
      verifiedEmail ? normalizeEmail(verifiedEmail) : "",
      userId,
      spaceId,
    )
    .all<ReachRow>();
  return highestRole(results.map((r) => r.role));
}

export async function listSpacesFor(
  db: D1Database,
  userId: string,
  verifiedEmail: string | null,
): Promise<SpaceSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.name, r.ownerId, r.role, u.name AS ownerName
       FROM (${reachSql(false)}) r LEFT JOIN "user" u ON u.id = r.ownerId`,
    )
    .bind(userId, verifiedEmail ? normalizeEmail(verifiedEmail) : "", userId)
    .all<ReachRow & { ownerName: string | null }>();
  const byId = new Map<string, SpaceSummary>();
  for (const row of results) {
    const prev = byId.get(row.id);
    const role = highestRole(prev ? [prev.role, row.role] : [row.role])!;
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      ownerId: row.ownerId,
      ownerName: row.ownerName,
      role,
    });
  }
  return [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

export async function listGrants(
  db: D1Database,
  spaceId: string,
): Promise<SpaceGrant[]> {
  const { results } = await db
    .prepare(
      `SELECT g.granteeType, g.granteeId, g.role,
         CASE g.granteeType
           WHEN 'email' THEN g.granteeId
           ELSE COALESCE(wg.name || ' · ' || w.name, 'Deleted group')
         END AS label
       FROM space_grants g
       LEFT JOIN workspace_groups wg
         ON g.granteeType = 'group' AND wg.id = g.granteeId
       LEFT JOIN workspaces w ON w.id = wg.workspaceId
       WHERE g.spaceId = ?
       ORDER BY g.granteeType DESC, label COLLATE NOCASE`,
    )
    .bind(spaceId)
    .all<SpaceGrant>();
  return results;
}

/** Grant or re-grant; true when the grant is new (not a role change). */
export async function putGrant(
  db: D1Database,
  spaceId: string,
  granteeType: GranteeType,
  granteeId: string,
  role: SpaceRole,
  createdBy: string,
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO space_grants (spaceId, granteeType, granteeId, role, createdBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (spaceId, granteeType, granteeId) DO UPDATE SET role = excluded.role
       RETURNING createdAt`,
    )
    .bind(
      spaceId,
      granteeType,
      granteeType === "email" ? normalizeEmail(granteeId) : granteeId,
      role,
      createdBy,
      now,
    )
    .first<{ createdAt: number }>();
  // An update keeps the original createdAt.
  return row?.createdAt === now;
}

export async function removeGrant(
  db: D1Database,
  spaceId: string,
  granteeType: GranteeType,
  granteeId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "DELETE FROM space_grants WHERE spaceId = ? AND granteeType = ? AND granteeId = ?",
    )
    .bind(
      spaceId,
      granteeType,
      granteeType === "email" ? normalizeEmail(granteeId) : granteeId,
    )
    .run();
  return result.meta.changes > 0;
}

export async function renameSpace(
  db: D1Database,
  spaceId: string,
  name: string,
): Promise<void> {
  await db
    .prepare("UPDATE spaces SET name = ? WHERE id = ?")
    .bind(name, spaceId)
    .run();
}

/** The workspace a group belongs to, for checking a sharer is in it. */
export async function groupWorkspace(
  db: D1Database,
  groupId: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT workspaceId FROM workspace_groups WHERE id = ?")
    .bind(groupId)
    .first<{ workspaceId: string }>();
  return row?.workspaceId ?? null;
}

export async function allSpaceIds(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM spaces ORDER BY id")
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function ownedSpaceIds(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM spaces WHERE ownerId = ? ORDER BY id")
    .bind(userId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Account deletion: who inherits a space whose owner is leaving. The
 * highest-ranked, longest-standing email grant held by an existing account
 * with that verified email. Null when nobody qualifies (the space is then
 * deleted with its Durable Object).
 */
export async function spaceSuccessor(
  db: D1Database,
  spaceId: string,
  leavingUserId: string,
): Promise<{ userId: string; email: string } | null> {
  return db
    .prepare(
      `SELECT u.id AS userId, g.granteeId AS email FROM space_grants g
       JOIN "user" u ON lower(trim(u.email)) = g.granteeId AND u.emailVerified = 1
       WHERE g.spaceId = ? AND g.granteeType = 'email' AND u.id != ?
       ORDER BY CASE g.role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1
                            WHEN 'commenter' THEN 2 ELSE 3 END,
         g.createdAt, u.id
       LIMIT 1`,
    )
    .bind(spaceId, leavingUserId)
    .first<{ userId: string; email: string }>();
}

export async function transferSpace(
  db: D1Database,
  spaceId: string,
  to: { userId: string; email: string },
): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE spaces SET ownerId = ? WHERE id = ?")
      .bind(to.userId, spaceId),
    // The new owner is implicitly an admin; their grant would be redundant.
    db
      .prepare(
        "DELETE FROM space_grants WHERE spaceId = ? AND granteeType = 'email' AND granteeId = ?",
      )
      .bind(spaceId, to.email),
  ]);
}

export async function deleteSpaceRows(
  db: D1Database,
  spaceId: string,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM space_grants WHERE spaceId = ?").bind(spaceId),
    db.prepare("DELETE FROM spaces WHERE id = ?").bind(spaceId),
  ]);
}

/** Account deletion's residual batch: grants addressed to the account. */
export function spaceGrantDeletionStatements(
  db: D1Database,
  email: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "DELETE FROM space_grants WHERE granteeType = 'email' AND granteeId = ?",
      )
      .bind(normalizeEmail(email)),
  ];
}

export interface SpacePerson {
  name: string | null;
  email: string;
}

/**
 * Who has access to a space, for anyone with access (the mention picker):
 * the owner, every email grant, and every member of a granted group. Names
 * appear only for accounts already known to collaborators (the owner and
 * group members); an email grant shows its address alone, so the list never
 * reveals whether an address has an account.
 */
export async function peopleWithAccess(
  db: D1Database,
  spaceId: string,
): Promise<SpacePerson[]> {
  const { results } = await db
    .prepare(
      `SELECT u.name AS name, lower(trim(u.email)) AS email FROM spaces s
         JOIN "user" u ON u.id = s.ownerId WHERE s.id = ?1
       UNION
       SELECT NULL AS name, g.granteeId AS email FROM space_grants g
         WHERE g.spaceId = ?1 AND g.granteeType = 'email'
       UNION
       SELECT u.name AS name, lower(trim(u.email)) AS email FROM space_grants g
         JOIN workspace_group_members gm ON gm.groupId = g.granteeId
         JOIN "user" u ON u.id = gm.userId
         WHERE g.spaceId = ?1 AND g.granteeType = 'group'`,
    )
    .bind(spaceId)
    .all<SpacePerson>();
  const byEmail = new Map<string, SpacePerson>();
  for (const p of results) {
    const prev = byEmail.get(p.email);
    if (!prev || (prev.name === null && p.name !== null))
      byEmail.set(p.email, p);
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

/** The verified account behind `email`, if any. */
export async function verifiedAccount(
  db: D1Database,
  email: string,
): Promise<{ userId: string; email: string } | null> {
  const normalized = normalizeEmail(email);
  const row = await db
    .prepare(
      `SELECT id FROM "user" WHERE lower(trim(email)) = ? AND emailVerified = 1 LIMIT 1`,
    )
    .bind(normalized)
    .first<{ id: string }>();
  return row ? { userId: row.id, email: normalized } : null;
}
