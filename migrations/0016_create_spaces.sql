-- Shared spaces (ADR 0079, milestone 2 of ADR 0076).
--
-- A space is one shared subtree living in its own Durable Object (the
-- USER_OUTLINE class, named `space:<id>`). Its owner is implicitly an admin.
-- Everyone else reaches it through a grant: to an account's email address
-- (only a signed-in account with that VERIFIED email holds it, so granting
-- never reveals whether an account exists) or to a workspace group.
-- No foreign key to "user", for the same reason as migration 0015: account
-- deletion hands ownership off explicitly (worker/spaces-store.ts).
CREATE TABLE IF NOT EXISTS spaces (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  ownerId   TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spaces_owner ON spaces (ownerId);

CREATE TABLE IF NOT EXISTS space_grants (
  spaceId     TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  granteeType TEXT NOT NULL CHECK (granteeType IN ('email', 'group')),
  -- normalized email, or a workspace_groups.id
  granteeId   TEXT NOT NULL,
  role        TEXT NOT NULL
              CHECK (role IN ('viewer', 'commenter', 'editor', 'admin')),
  createdBy   TEXT NOT NULL,
  createdAt   INTEGER NOT NULL,
  PRIMARY KEY (spaceId, granteeType, granteeId)
);
CREATE INDEX IF NOT EXISTS space_grants_grantee
  ON space_grants (granteeType, granteeId);
