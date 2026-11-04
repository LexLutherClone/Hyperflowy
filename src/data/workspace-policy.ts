/**
 * Who may do what inside a workspace (ADR 0078). Pure: the handler reads the
 * actor's and target's roles from D1, asks here, and only then writes.
 *
 * Roles rank owner > admin > member. The rules:
 *
 * - Every member can see the workspace: its members, groups, and name.
 * - Admins and the owner manage it: rename, invite, remove, change roles, and
 *   manage groups.
 * - You can only act on someone ranked BELOW you, and only grant a role at
 *   most your own. So admins manage members and can make admins; only the
 *   owner can demote or remove an admin.
 * - Nobody can grant "owner", and the owner can't be removed or demoted. (An
 *   explicit ownership transfer is a later, separate action.)
 * - Anyone except the owner may leave. The owner deletes the workspace
 *   instead, or (later) transfers it.
 * - Only the owner deletes the workspace.
 */

export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
/** The roles an invitation or a role change may grant. */
export type GrantableRole = Exclude<WorkspaceRole, "owner">;

const RANK = { owner: 3, admin: 2, member: 1 } satisfies Record<
  WorkspaceRole,
  number
>;

export const canView = (actor: WorkspaceRole | null): boolean => actor !== null;

export const canManage = (actor: WorkspaceRole | null): boolean =>
  actor !== null && RANK[actor] >= RANK.admin;

export const canDelete = (actor: WorkspaceRole | null): boolean =>
  actor === "owner";

export function canInvite(
  actor: WorkspaceRole | null,
  role: GrantableRole,
): boolean {
  return canManage(actor) && actor !== null && RANK[role] <= RANK[actor];
}

export function canChangeRole(
  actor: WorkspaceRole | null,
  target: WorkspaceRole,
  role: GrantableRole,
): boolean {
  if (!canManage(actor) || actor === null) return false;
  return RANK[target] < RANK[actor] && RANK[role] <= RANK[actor];
}

/** Remove `target` from the workspace. `self` = the actor is leaving. */
export function canRemove(
  actor: WorkspaceRole | null,
  target: WorkspaceRole,
  self: boolean,
): boolean {
  if (actor === null) return false;
  if (self) return target !== "owner";
  return canManage(actor) && RANK[target] < RANK[actor];
}

export const WORKSPACE_NAME_MAX = 80;
export const GROUP_NAME_MAX = 60;

/** A trimmed, non-empty name within `max` characters, or null. */
export function cleanName(name: string, max: number): string | null {
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}
