import { beforeEach, describe, expect, test } from "bun:test";

import { sqliteD1 } from "./testing/d1-sqlite";
import {
  acceptInvite,
  createGroup,
  createWorkspace,
  declineInvite,
  deleteGroup,
  deleteWorkspace,
  getWorkspaceDetail,
  inviteToWorkspace,
  listWorkspaces,
  removeMember,
  roleOf,
  setGroupMembers,
  setMemberRole,
  workspaceDeletionStatements,
} from "./workspaces-store";

let env: ReturnType<typeof sqliteD1>;

beforeEach(() => {
  env = sqliteD1([
    "migrations/0015_create_workspaces.sql",
    "migrations/0016_create_spaces.sql",
  ]);
  // The slice of Better Auth's user table the store joins for names/emails.
  env.sqlite.exec(
    `CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT)`,
  );
  for (const [id, name] of [
    ["ann", "Ann"],
    ["bo", "Bo"],
    ["cy", "Cy"],
  ] as const)
    env.sqlite
      .query(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`)
      .run(id, name, `${id}@example.com`);
});

async function workspaceWith(...members: [string, "admin" | "member"][]) {
  const ws = await createWorkspace(env.db, "ann", "Team", 1);
  let t = 2;
  for (const [user, role] of members) {
    const invite = await inviteToWorkspace(
      env.db,
      ws.id,
      `${user}@example.com`,
      role,
      "ann",
      t,
    );
    await acceptInvite(env.db, invite.id, user, `${user}@example.com`, t++);
  }
  return ws.id;
}

describe("workspaces store", () => {
  test("the creator owns the new workspace", async () => {
    const ws = await createWorkspace(env.db, "ann", "Design", 1);
    expect(await roleOf(env.db, ws.id, "ann")).toBe("owner");
    const { workspaces } = await listWorkspaces(env.db, "ann", null);
    expect(workspaces).toEqual([
      { id: ws.id, name: "Design", role: "owner", memberCount: 1 },
    ]);
  });

  test("an invitation is only visible to, and accepted by, its address", async () => {
    const ws = await createWorkspace(env.db, "ann", "Design", 1);
    const invite = await inviteToWorkspace(
      env.db,
      ws.id,
      " Bo@Example.com ",
      "member",
      "ann",
      2,
    );
    expect(invite.email).toBe("bo@example.com");

    expect(
      (await listWorkspaces(env.db, "cy", "cy@example.com")).invites,
    ).toEqual([]);
    expect(
      await acceptInvite(env.db, invite.id, "cy", "cy@example.com", 3),
    ).toBeNull();

    const pending = (await listWorkspaces(env.db, "bo", "bo@example.com"))
      .invites;
    expect(pending.map((p) => [p.workspaceName, p.invitedByName])).toEqual([
      ["Design", "Ann"],
    ]);
    expect(
      await acceptInvite(env.db, invite.id, "bo", "BO@example.com", 3),
    ).toBe(ws.id);
    expect(await roleOf(env.db, ws.id, "bo")).toBe("member");
    expect(
      (await listWorkspaces(env.db, "bo", "bo@example.com")).invites,
    ).toEqual([]);
  });

  test("re-inviting an address updates its role instead of duplicating", async () => {
    const ws = await createWorkspace(env.db, "ann", "Design", 1);
    await inviteToWorkspace(
      env.db,
      ws.id,
      "bo@example.com",
      "member",
      "ann",
      2,
    );
    await inviteToWorkspace(env.db, ws.id, "bo@example.com", "admin", "ann", 3);
    const detail = await getWorkspaceDetail(env.db, ws.id, "owner", true);
    expect(detail!.invites.map((i) => i.role)).toEqual(["admin"]);
  });

  test("declining removes the invitation", async () => {
    const ws = await createWorkspace(env.db, "ann", "Design", 1);
    const invite = await inviteToWorkspace(
      env.db,
      ws.id,
      "bo@example.com",
      "member",
      "ann",
      2,
    );
    expect(await declineInvite(env.db, invite.id, "cy@example.com")).toBe(
      false,
    );
    expect(await declineInvite(env.db, invite.id, "bo@example.com")).toBe(true);
    expect(
      (await listWorkspaces(env.db, "bo", "bo@example.com")).invites,
    ).toEqual([]);
  });

  test("detail lists members owner-first, groups with members, and invites for admins only", async () => {
    const id = await workspaceWith(["bo", "admin"], ["cy", "member"]);
    const group = await createGroup(env.db, id, "Leads", 9);
    await setGroupMembers(env.db, id, group.id, ["bo", "cy", "stranger"]);
    await inviteToWorkspace(env.db, id, "dee@example.com", "member", "ann", 10);

    const asOwner = await getWorkspaceDetail(env.db, id, "owner", true);
    expect(asOwner!.members.map((m) => [m.userId, m.role, m.email])).toEqual([
      ["ann", "owner", "ann@example.com"],
      ["bo", "admin", "bo@example.com"],
      ["cy", "member", "cy@example.com"],
    ]);
    expect(asOwner!.groups).toEqual([
      { id: group.id, name: "Leads", memberIds: ["bo", "cy"] },
    ]);
    expect(asOwner!.invites.map((i) => i.email)).toEqual(["dee@example.com"]);

    const asMember = await getWorkspaceDetail(env.db, id, "member", false);
    expect(asMember!.invites).toEqual([]);
  });

  test("removing a member also removes them from the workspace's groups; the owner can't be removed", async () => {
    const id = await workspaceWith(["bo", "member"]);
    const group = await createGroup(env.db, id, "Leads", 9);
    await setGroupMembers(env.db, id, group.id, ["ann", "bo"]);
    await removeMember(env.db, id, "bo");
    await removeMember(env.db, id, "ann");
    expect(await roleOf(env.db, id, "bo")).toBeNull();
    expect(await roleOf(env.db, id, "ann")).toBe("owner");
    const detail = await getWorkspaceDetail(env.db, id, "owner", true);
    expect(detail!.groups[0]!.memberIds).toEqual(["ann"]);
  });

  test("a role change never touches the owner", async () => {
    const id = await workspaceWith(["bo", "member"]);
    await setMemberRole(env.db, id, "bo", "admin");
    await setMemberRole(env.db, id, "ann", "member");
    expect(await roleOf(env.db, id, "bo")).toBe("admin");
    expect(await roleOf(env.db, id, "ann")).toBe("owner");
  });

  test("deleting a group or a workspace removes everything under it", async () => {
    const id = await workspaceWith(["bo", "member"]);
    const group = await createGroup(env.db, id, "Leads", 9);
    await setGroupMembers(env.db, id, group.id, ["bo"]);
    expect(await deleteGroup(env.db, "other-workspace", group.id)).toBe(false);
    expect(await deleteGroup(env.db, id, group.id)).toBe(true);
    await createGroup(env.db, id, "Again", 10);
    await deleteWorkspace(env.db, id);
    for (const table of [
      "workspaces",
      "workspace_members",
      "workspace_groups",
      "workspace_group_members",
      "workspace_invites",
    ])
      expect(
        env.sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
      ).toEqual({ n: 0 });
  });
});

describe("account deletion", () => {
  const run = (userId: string, email: string) =>
    env.db.batch(workspaceDeletionStatements(env.db, userId, email));

  test("an owner's workspace passes to the longest-standing admin", async () => {
    const id = await workspaceWith(["bo", "member"], ["cy", "admin"]);
    await run("ann", "ann@example.com");
    expect(await roleOf(env.db, id, "ann")).toBeNull();
    expect(await roleOf(env.db, id, "cy")).toBe("owner");
    expect(await roleOf(env.db, id, "bo")).toBe("member");
  });

  test("with no admins, the longest-standing member becomes owner", async () => {
    const id = await workspaceWith(["bo", "member"], ["cy", "member"]);
    await run("ann", "ann@example.com");
    expect(await roleOf(env.db, id, "bo")).toBe("owner");
  });

  test("a workspace the user was alone in is deleted", async () => {
    const solo = await createWorkspace(env.db, "ann", "Solo", 1);
    await createGroup(env.db, solo.id, "Me", 2);
    await inviteToWorkspace(
      env.db,
      solo.id,
      "x@example.com",
      "member",
      "ann",
      3,
    );
    await run("ann", "ann@example.com");
    expect(
      env.sqlite.query("SELECT COUNT(*) AS n FROM workspaces").get(),
    ).toEqual({
      n: 0,
    });
    expect(
      env.sqlite.query("SELECT COUNT(*) AS n FROM workspace_groups").get(),
    ).toEqual({ n: 0 });
  });

  test("a member's rows and invitations to their address are removed; others are untouched", async () => {
    const id = await workspaceWith(["bo", "member"]);
    const group = await createGroup(env.db, id, "Leads", 9);
    await setGroupMembers(env.db, id, group.id, ["ann", "bo"]);
    const other = await createWorkspace(env.db, "cy", "Other", 1);
    await inviteToWorkspace(
      env.db,
      other.id,
      "bo@example.com",
      "member",
      "cy",
      2,
    );
    await run("bo", "bo@example.com");
    expect(await roleOf(env.db, id, "bo")).toBeNull();
    expect(await roleOf(env.db, id, "ann")).toBe("owner");
    const detail = await getWorkspaceDetail(env.db, id, "owner", true);
    expect(detail!.groups[0]!.memberIds).toEqual(["ann"]);
    expect(
      env.sqlite.query("SELECT COUNT(*) AS n FROM workspace_invites").get(),
    ).toEqual({ n: 0 });
    expect(await roleOf(env.db, other.id, "cy")).toBe("owner");
  });
});
