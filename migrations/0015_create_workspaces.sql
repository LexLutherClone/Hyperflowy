-- Team workspaces and their groups (ADR 0078, milestone 1 of ADR 0076).
--
-- A workspace is a team. Members hold a workspace role: owner (exactly one),
-- admin, or member. Groups are named sets of members that later milestones
-- share notes with. Membership rows deliberately carry NO foreign key to
-- "user": account deletion runs after the user row is gone (Better Auth's
-- afterDelete), and the ownership handoff in worker/account-deletion.ts must
-- still see the departing owner's rows to promote a successor. Cleanup is
-- explicit there instead of a cascade.
CREATE TABLE IF NOT EXISTS workspaces (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspaceId TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  userId      TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joinedAt    INTEGER NOT NULL,
  PRIMARY KEY (workspaceId, userId)
);
CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members (userId);
-- Exactly one owner per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_one_owner
  ON workspace_members (workspaceId) WHERE role = 'owner';

-- Invitations are bound to an email address and only ever shown to a signed-in
-- account whose VERIFIED email matches. Creating one never reveals whether an
-- account exists for that address.
CREATE TABLE IF NOT EXISTS workspace_invites (
  id          TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email       TEXT NOT NULL,   -- normalized (trimmed, lowercased)
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  invitedBy   TEXT NOT NULL,
  createdAt   INTEGER NOT NULL,
  UNIQUE (workspaceId, email)
);
CREATE INDEX IF NOT EXISTS workspace_invites_email ON workspace_invites (email);

CREATE TABLE IF NOT EXISTS workspace_groups (
  id          TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  createdAt   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_groups_workspace
  ON workspace_groups (workspaceId);

CREATE TABLE IF NOT EXISTS workspace_group_members (
  groupId TEXT NOT NULL REFERENCES workspace_groups (id) ON DELETE CASCADE,
  userId  TEXT NOT NULL,
  PRIMARY KEY (groupId, userId)
);
CREATE INDEX IF NOT EXISTS workspace_group_members_user
  ON workspace_group_members (userId);
