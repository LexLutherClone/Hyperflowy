import { beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type {
  PendingInvite,
  WorkspaceDetail,
  WorkspaceGroup,
  WorkspaceInvite,
  WorkspaceSummary,
} from "./workspaces-store";

import { sqliteD1 } from "./testing/d1-sqlite";
import { handleWorkspaces, type WorkspaceActor } from "./workspaces";

const ORIGIN = "https://app.example";

/** Every field any of these routes returns; each response fills a subset. */
interface ApiBody extends Partial<WorkspaceDetail> {
  workspace?: WorkspaceDetail["workspace"] & Partial<WorkspaceSummary>;
  workspaces?: WorkspaceSummary[];
  invites?: (PendingInvite & WorkspaceInvite)[];
  invite?: WorkspaceInvite;
  group?: WorkspaceGroup;
  error?: string;
  message?: string;
}
let env: ReturnType<typeof sqliteD1>;
let allow = true;

const actor = (userId: string, verified = true): WorkspaceActor => ({
  userId,
  verifiedEmail: verified ? `${userId}@example.com` : null,
});

async function call(
  who: WorkspaceActor,
  method: string,
  path: string,
  input?: Readonly<Record<string, string | readonly string[]>>,
  origin = ORIGIN,
) {
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers:
      input === undefined
        ? { origin }
        : { origin, "content-type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const response = await Effect.runPromise(
    handleWorkspaces(
      request,
      {
        DB: env.db,
        WORKSPACE_LIMIT: { limit: async () => ({ success: allow }) },
      },
      who,
    ),
  );
  // SAFETY: these routes only ever answer with JSON shaped like ApiBody.
  const body = (await response.json()) as ApiBody;
  return { status: response.status, body };
}

beforeEach(() => {
  allow = true;
  env = sqliteD1([
    "migrations/0015_create_workspaces.sql",
    "migrations/0016_create_spaces.sql",
  ]);
  env.sqlite.exec(
    `CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT)`,
  );
  for (const id of ["ann", "bo", "cy"])
    env.sqlite
      .query(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`)
      .run(id, id.toUpperCase(), `${id}@example.com`);
});

/** ann owns "Team"; bo is an admin; cy is a member. */
async function team(): Promise<string> {
  const created = await call(actor("ann"), "POST", "/api/workspaces", {
    name: "Team",
  });
  const id = created.body.workspace!.id;
  for (const [who, role] of [
    ["bo", "admin"],
    ["cy", "member"],
  ] as const) {
    const invite = await call(
      actor("ann"),
      "POST",
      `/api/workspaces/${id}/invites`,
      { email: `${who}@example.com`, role },
    );
    expect(invite.status).toBe(201);
    const accepted = await call(
      actor(who),
      "POST",
      `/api/workspace-invites/${invite.body.invite!.id}/accept`,
    );
    expect(accepted.status).toBe(200);
  }
  return id;
}

describe("/api/workspaces", () => {
  test("create, list, and read as a member", async () => {
    const id = await team();
    const list = await call(actor("cy"), "GET", "/api/workspaces");
    expect(list.body.workspaces).toEqual([
      { id, name: "Team", role: "member", memberCount: 3 },
    ]);
    const detail = await call(actor("cy"), "GET", `/api/workspaces/${id}`);
    const body = detail.body;
    expect(body.members!.map((m) => [m.userId, m.role])).toEqual([
      ["ann", "owner"],
      ["bo", "admin"],
      ["cy", "member"],
    ]);
    expect(body.invites).toEqual([]);
  });

  test("a workspace you're not in is a 404, for reads and writes", async () => {
    const id = await team();
    const stranger = actor("dee");
    expect((await call(stranger, "GET", `/api/workspaces/${id}`)).status).toBe(
      404,
    );
    expect(
      (await call(stranger, "PATCH", `/api/workspaces/${id}`, { name: "x" }))
        .status,
    ).toBe(404);
  });

  test("writes need a same-origin request and pass the rate limit", async () => {
    const elsewhere = await call(
      actor("ann"),
      "POST",
      "/api/workspaces",
      { name: "X" },
      "https://evil.example",
    );
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.error).toBe("invalid_origin");
    allow = false;
    expect(
      (await call(actor("ann"), "POST", "/api/workspaces", { name: "X" }))
        .status,
    ).toBe(429);
  });

  test("bad input is a 400, extra fields included", async () => {
    expect(
      (await call(actor("ann"), "POST", "/api/workspaces", { name: "  " }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(actor("ann"), "POST", "/api/workspaces", {
          name: "ok",
          owner: "someone-else",
        })
      ).status,
    ).toBe(400);
    const id = await team();
    expect(
      (
        await call(actor("ann"), "POST", `/api/workspaces/${id}/invites`, {
          email: "not-an-email",
          role: "member",
        })
      ).status,
    ).toBe(400);
  });

  test("members can't invite; admins can't invite owners", async () => {
    const id = await team();
    const asMember = await call(
      actor("cy"),
      "POST",
      `/api/workspaces/${id}/invites`,
      { email: "dee@example.com", role: "member" },
    );
    expect(asMember.status).toBe(403);
    const asOwnerRole = await call(
      actor("bo"),
      "POST",
      `/api/workspaces/${id}/invites`,
      { email: "dee@example.com", role: "owner" },
    );
    expect(asOwnerRole.status).toBe(400);
  });

  test("only a verified matching address can accept an invitation", async () => {
    const id = await team();
    const invite = await call(
      actor("ann"),
      "POST",
      `/api/workspaces/${id}/invites`,
      { email: "dee@example.com", role: "member" },
    );
    const inviteId = invite.body.invite!.id;
    const unverified = await call(
      actor("dee", false),
      "POST",
      `/api/workspace-invites/${inviteId}/accept`,
    );
    expect(unverified.status).toBe(403);
    const wrongPerson = await call(
      actor("cy"),
      "POST",
      `/api/workspace-invites/${inviteId}/accept`,
    );
    expect(wrongPerson.status).toBe(404);
    const pending = await call(actor("dee"), "GET", "/api/workspaces");
    expect(pending.body.invites!.map((i) => i.id)).toEqual([inviteId]);
    expect(
      (
        await call(
          actor("dee"),
          "POST",
          `/api/workspace-invites/${inviteId}/accept`,
        )
      ).status,
    ).toBe(200);
  });

  test("role changes and removals respect rank", async () => {
    const id = await team();
    const path = (who: string) => `/api/workspaces/${id}/members/${who}`;
    // An admin can promote a member, but not touch another admin or the owner.
    expect(
      (await call(actor("bo"), "PATCH", path("cy"), { role: "admin" })).status,
    ).toBe(200);
    expect(
      (await call(actor("bo"), "PATCH", path("cy"), { role: "member" })).status,
    ).toBe(403);
    expect((await call(actor("bo"), "DELETE", path("ann"))).status).toBe(403);
    // The owner can demote and remove admins, but can't leave.
    expect(
      (await call(actor("ann"), "PATCH", path("cy"), { role: "member" }))
        .status,
    ).toBe(200);
    expect((await call(actor("ann"), "DELETE", path("ann"))).status).toBe(403);
    // Anyone else can leave.
    expect((await call(actor("cy"), "DELETE", path("cy"))).status).toBe(200);
    expect(
      (await call(actor("cy"), "GET", `/api/workspaces/${id}`)).status,
    ).toBe(404);
  });

  test("admins manage groups; group members must be workspace members", async () => {
    const id = await team();
    expect(
      (
        await call(actor("cy"), "POST", `/api/workspaces/${id}/groups`, {
          name: "Leads",
        })
      ).status,
    ).toBe(403);
    const created = await call(
      actor("bo"),
      "POST",
      `/api/workspaces/${id}/groups`,
      { name: "Leads" },
    );
    expect(created.status).toBe(201);
    const groupId = created.body.group!.id;
    await call(
      actor("bo"),
      "PUT",
      `/api/workspaces/${id}/groups/${groupId}/members`,
      {
        userIds: ["ann", "cy", "dee"],
      },
    );
    const detail = await call(actor("cy"), "GET", `/api/workspaces/${id}`);
    expect(detail.body.groups).toEqual([
      { id: groupId, name: "Leads", memberIds: ["ann", "cy"] },
    ]);
  });

  test("only the owner deletes the workspace", async () => {
    const id = await team();
    expect(
      (await call(actor("bo"), "DELETE", `/api/workspaces/${id}`)).status,
    ).toBe(403);
    expect(
      (await call(actor("ann"), "DELETE", `/api/workspaces/${id}`)).status,
    ).toBe(200);
    expect(
      (await call(actor("bo"), "GET", "/api/workspaces")).body.workspaces,
    ).toEqual([]);
  });
});
