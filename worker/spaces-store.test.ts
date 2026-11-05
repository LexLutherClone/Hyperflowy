import { beforeEach, describe, expect, test } from "bun:test";

import {
  createSpace,
  deleteSpaceRows,
  listGrants,
  listSpacesFor,
  putGrant,
  removeGrant,
  roleFor,
  spaceSuccessor,
  transferSpace,
} from "./spaces-store";
import { sqliteD1, type SqliteD1 } from "./testing/d1-sqlite";
import {
  createGroup,
  createWorkspace,
  setGroupMembers,
} from "./workspaces-store";

let env: SqliteD1;

beforeEach(() => {
  env = sqliteD1([
    "migrations/0015_create_workspaces.sql",
    "migrations/0016_create_spaces.sql",
  ]);
  env.sqlite.exec(
    `CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER)`,
  );
  for (const id of ["ann", "bo", "cy", "dee"])
    env.sqlite
      .query(`INSERT INTO "user" VALUES (?, ?, ?, ?)`)
      .run(id, id.toUpperCase(), `${id}@example.com`, id === "dee" ? 0 : 1);
});

const space = (id = "s1", ownerId = "ann") =>
  createSpace(env.db, { id, name: `Space ${id}`, ownerId, createdAt: 1 });

describe("roles", () => {
  test("the owner is an admin; strangers have no role", async () => {
    await space();
    expect(await roleFor(env.db, "s1", "ann", "ann@example.com")).toBe("admin");
    expect(await roleFor(env.db, "s1", "bo", "bo@example.com")).toBeNull();
  });

  test("an email grant reaches only a verified matching account", async () => {
    await space();
    await putGrant(
      env.db,
      "s1",
      "email",
      " Bo@Example.com ",
      "editor",
      "ann",
      2,
    );
    expect(await roleFor(env.db, "s1", "bo", "bo@example.com")).toBe("editor");
    expect(await roleFor(env.db, "s1", "bo", null)).toBeNull();
    expect(await roleFor(env.db, "s1", "cy", "cy@example.com")).toBeNull();
  });

  test("group grants reach the group's members; the highest grant wins", async () => {
    await space();
    const ws = await createWorkspace(env.db, "ann", "Team", 1);
    const group = await createGroup(env.db, ws.id, "Leads", 2);
    env.sqlite
      .query(
        "INSERT INTO workspace_members (workspaceId, userId, role, joinedAt) VALUES (?, ?, 'member', 3)",
      )
      .run(ws.id, "bo");
    await setGroupMembers(env.db, ws.id, group.id, ["bo"]);
    await putGrant(env.db, "s1", "group", group.id, "viewer", "ann", 4);
    expect(await roleFor(env.db, "s1", "bo", "bo@example.com")).toBe("viewer");
    await putGrant(env.db, "s1", "email", "bo@example.com", "admin", "ann", 5);
    expect(await roleFor(env.db, "s1", "bo", "bo@example.com")).toBe("admin");

    const listed = await listSpacesFor(env.db, "bo", "bo@example.com");
    expect(listed).toEqual([
      {
        id: "s1",
        name: "Space s1",
        ownerId: "ann",
        ownerName: "ANN",
        role: "admin",
      },
    ]);
    expect(await listGrants(env.db, "s1")).toEqual([
      {
        granteeType: "group",
        granteeId: group.id,
        role: "viewer",
        label: "Leads · Team",
      },
      {
        granteeType: "email",
        granteeId: "bo@example.com",
        role: "admin",
        label: "bo@example.com",
      },
    ]);
  });

  test("re-granting updates the role; removing revokes", async () => {
    await space();
    await putGrant(env.db, "s1", "email", "bo@example.com", "viewer", "ann", 2);
    await putGrant(env.db, "s1", "email", "BO@example.com", "editor", "ann", 3);
    expect((await listGrants(env.db, "s1")).map((g) => g.role)).toEqual([
      "editor",
    ]);
    expect(await removeGrant(env.db, "s1", "email", "Bo@Example.com")).toBe(
      true,
    );
    expect(await roleFor(env.db, "s1", "bo", "bo@example.com")).toBeNull();
  });
});

describe("ownership handoff", () => {
  test("the highest, longest-standing grant held by a verified account inherits", async () => {
    await space();
    await putGrant(env.db, "s1", "email", "cy@example.com", "viewer", "ann", 2);
    await putGrant(env.db, "s1", "email", "bo@example.com", "editor", "ann", 3);
    await putGrant(env.db, "s1", "email", "dee@example.com", "admin", "ann", 4); // unverified
    await putGrant(
      env.db,
      "s1",
      "email",
      "nobody@example.com",
      "admin",
      "ann",
      5,
    );
    const next = await spaceSuccessor(env.db, "s1", "ann");
    expect(next).toEqual({ userId: "bo", email: "bo@example.com" });
    await transferSpace(env.db, "s1", next!);
    expect(await roleFor(env.db, "s1", "bo", "bo@example.com")).toBe("admin");
    expect(await roleFor(env.db, "s1", "ann", "ann@example.com")).toBeNull();
    expect(
      (await listGrants(env.db, "s1")).map((g) => g.granteeId),
    ).not.toContain("bo@example.com");
  });

  test("no qualifying grant means no successor; deleting removes the rows", async () => {
    await space();
    await putGrant(
      env.db,
      "s1",
      "email",
      "nobody@example.com",
      "admin",
      "ann",
      2,
    );
    expect(await spaceSuccessor(env.db, "s1", "ann")).toBeNull();
    await deleteSpaceRows(env.db, "s1");
    expect(
      env.sqlite.query("SELECT COUNT(*) AS n FROM space_grants").get(),
    ).toEqual({
      n: 0,
    });
  });
});
