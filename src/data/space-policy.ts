/**
 * Roles on a shared space (ADR 0079; product decision in ADR 0076). Pure, and
 * shared by the Worker (enforcement) and the app (which controls to offer).
 *
 * Each role includes the one before it:
 * - **viewer** reads the subtree;
 * - **commenter** reads and comments (ADR 0081), but can't change content;
 * - **editor** changes content and structure;
 * - **admin** also manages who has access. The owner is always an admin.
 *
 * A person's role is the highest of every grant that reaches them: one to
 * their verified email, and one to each group they're in.
 */

export const SPACE_ROLES = ["viewer", "commenter", "editor", "admin"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

const RANK = { viewer: 1, commenter: 2, editor: 3, admin: 4 } satisfies Record<
  SpaceRole,
  number
>;

export const highestRole = (roles: readonly SpaceRole[]): SpaceRole | null =>
  roles.reduce<SpaceRole | null>(
    (best, r) => (best === null || RANK[r] > RANK[best] ? r : best),
    null,
  );

export const canRead = (role: SpaceRole | null): boolean => role !== null;
export const canEdit = (role: SpaceRole | null): boolean =>
  role !== null && RANK[role] >= RANK.editor;
export const canShare = (role: SpaceRole | null): boolean => role === "admin";

export const SPACE_NAME_MAX = 80;
