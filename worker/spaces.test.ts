import { beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { SpaceRole } from "../src/data/space-policy";
import type { ChangeOp, Node } from "../src/data/wire-schema";
import type { UserOutlineDO } from "./outline-do";
import type { SpaceGrant, SpaceSummary } from "./spaces-store";

import { createNode } from "../src/data/tree";
import { notifyMentions } from "./mentions";
import { handleSpaces, releaseOwnedSpaces } from "./spaces";
import { putGrant, roleFor } from "./spaces-store";
import { sqliteD1, type SqliteD1 } from "./testing/d1-sqlite";
import {
  createGroup,
  createWorkspace,
  inviteToWorkspace,
  acceptInvite,
} from "./workspaces-store";

const ORIGIN = "https://app.example";

/** An in-memory stand-in for one outline Durable Object. */
class FakeOutline {
  nodes: Node[] = [];
  kv: Record<string, { key: string; nodeId: string }[]> = {};
  batches: ChangeOp[][] = [];
  disconnects = 0;
  wiped = false;
  failUpsert = false;
  async getNodes() {
    return this.nodes;
  }
  async getKv(collection: string) {
    return this.kv[collection] ?? [];
  }
  async upsertNodes(nodes: Node[]) {
    if (this.failUpsert) throw new Error("boom");
    this.nodes.push(...nodes);
  }
  async applyBatch(ops: ChangeOp[]) {
    this.batches.push(ops);
    return 1;
  }
  async disconnectAll() {
    return ++this.disconnects;
  }
  async wipe() {
    this.wiped = true;
    this.nodes = [];
  }
}

let env: SqliteD1;
let sent: { to: string; subject: string }[] = [];
let deferred: Promise<unknown>[] = [];
// SAFETY: the fake implements `send`, the only method sendEmail calls.
const EMAIL = Object.assign({} as SendEmail, {
  send: async (message: { to: string; subject: string }) => {
    sent.push({ to: message.to, subject: message.subject });
  },
});
let objects: Map<string, FakeOutline>;
let failSpaceCopies = false;
const outline = (name: string) => {
  let o = objects.get(name);
  if (!o) objects.set(name, (o = new FakeOutline()));
  if (name.startsWith("space:")) o.failUpsert = failSpaceCopies;
  return o;
};

/** Every field these routes return; each response fills a subset. */
interface SpacesBody {
  unshared?: boolean;
  left?: boolean;
  stillHasAccess?: boolean;
  count?: number;
  removed?: boolean;
  people?: { name: string | null; email: string }[];
  space?: { id: string; name: string; url: string; ownerId: string };
  replaced?: boolean;
  role?: SpaceRole;
  grants?: SpaceGrant[];
  spaces?: SpaceSummary[];
  error?: string;
  message?: string;
}
// SAFETY: the fake namespace implements idFromName/get, all the handler calls.
const namespace = Object.assign({} as DurableObjectNamespace<UserOutlineDO>, {
  idFromName: (name: string) => name,
  get: (name: string) => outline(name),
});

const personal = () => [
  createNode({ id: "a", text: "Inbox" }),
  createNode({ id: "p", text: "**Launch** plan", prevSiblingId: "a" }),
  createNode({ id: "p1", parentId: "p", text: "Copy" }),
  createNode({ id: "p2", parentId: "p", prevSiblingId: "p1", text: "Ads" }),
];

async function call(
  userId: string,
  method: string,
  path: string,
  input?: Readonly<Record<string, string | readonly string[]>>,
) {
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers:
      input === undefined
        ? { origin: ORIGIN }
        : { origin: ORIGIN, "content-type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const response = await Effect.runPromise(
    handleSpaces(
      request,
      {
        DB: env.db,
        USER_OUTLINE: namespace,
        WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
        EMAIL,
      },
      {
        userId,
        name: userId.toUpperCase(),
        verifiedEmail: `${userId}@example.com`,
        outline: outline(userId),
        defer: (work) => deferred.push(work),
      },
    ),
  );
  // SAFETY: these routes only ever answer with JSON shaped like SpacesBody.
  const body = (await response.json()) as SpacesBody;
  return { status: response.status, body };
}

beforeEach(() => {
  sent = [];
  deferred = [];
  objects = new Map();
  failSpaceCopies = false;
  env = sqliteD1([
    "migrations/0015_create_workspaces.sql",
    "migrations/0016_create_spaces.sql",
  ]);
  env.sqlite.exec(
    `CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER)`,
  );
  for (const id of ["ann", "bo"])
    env.sqlite
      .query(`INSERT INTO "user" VALUES (?, ?, ?, 1)`)
      .run(id, id.toUpperCase(), `${id}@example.com`);
  outline("ann").nodes = personal();
});

async function share(nodeId = "p") {
  const res = await call("ann", "POST", "/api/spaces", { nodeId });
  return res;
}

describe("sharing a node", () => {
  test("copies the subtree into the space, then leaves a link in its place", async () => {
    const res = await share();
    expect(res.status).toBe(201);
    const space = res.body.space!;
    expect(space.name).toBe("Launch plan");
    expect(space.url).toBe(`${ORIGIN}/s/${space.id}`);
    expect(res.body.replaced).toBe(true);

    const copy = outline(`space:${space.id}`).nodes;
    expect(copy.map((n) => n.id).sort()).toEqual(["p", "p1", "p2"]);
    expect(copy.find((n) => n.id === "p")!.parentId).toBeNull();

    const [ops] = outline("ann").batches;
    expect(ops![0]).toMatchObject({
      op: "update",
      value: { id: "p", text: `[Launch plan](${space.url})` },
    });
    expect(
      ops!
        .slice(1)
        .map((o) => o.op === "delete" && o.key)
        .sort(),
    ).toEqual(["p1", "p2"]);
    expect(await roleFor(env.db, space.id, "ann", "ann@example.com")).toBe(
      "admin",
    );
  });

  test("a failed copy changes nothing", async () => {
    failSpaceCopies = true;
    const res = await share();
    expect(res.status).toBe(500);
    expect(outline("ann").batches).toEqual([]);
    expect(env.sqlite.query("SELECT COUNT(*) AS n FROM spaces").get()).toEqual({
      n: 0,
    });
  });

  test("a refusal explains itself and writes nothing", async () => {
    outline("ann").nodes = personal().map((n) =>
      n.id === "p2" ? { ...n, locked: true } : n,
    );
    const res = await share();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("share_locked");
    expect(outline("ann").batches).toEqual([]);
  });

  test("daily-note pages can't be shared", async () => {
    outline("ann").kv["daily-index"] = [{ key: "2026-11-05", nodeId: "p1" }];
    expect((await share()).body.error).toBe("share_daily");
  });
});

describe("access", () => {
  async function shared() {
    const res = await share();
    return res.body.space!.id;
  }

  test("a space you have no role on is a 404", async () => {
    const id = await shared();
    expect((await call("bo", "GET", `/api/spaces/${id}`)).status).toBe(404);
  });

  test("admins grant by email; the grantee sees it; non-admins can't manage", async () => {
    const id = await shared();
    const granted = await call("ann", "PUT", `/api/spaces/${id}/grants`, {
      granteeType: "email",
      email: "Bo@Example.com",
      role: "editor",
    });
    expect(granted.status).toBe(200);
    const bo = await call("bo", "GET", `/api/spaces/${id}`);
    expect(bo.body.role).toBe("editor");
    expect(bo.body.grants).toEqual([]);
    const list = await call("bo", "GET", "/api/spaces");
    expect(list.body.spaces!.map((s) => s.id)).toEqual([id]);
    expect(
      (
        await call("bo", "PUT", `/api/spaces/${id}/grants`, {
          granteeType: "email",
          email: "x@example.com",
          role: "viewer",
        })
      ).status,
    ).toBe(403);
  });

  test("revoking removes access and resets the space's connections", async () => {
    const id = await shared();
    await call("ann", "PUT", `/api/spaces/${id}/grants`, {
      granteeType: "email",
      email: "bo@example.com",
      role: "viewer",
    });
    const revoked = await call("ann", "DELETE", `/api/spaces/${id}/grants`, {
      granteeType: "email",
      granteeId: "BO@example.com",
    });
    expect(revoked.status).toBe(200);
    expect(outline(`space:${id}`).disconnects).toBe(1);
    expect((await call("bo", "GET", `/api/spaces/${id}`)).status).toBe(404);
  });

  test("you can only share with groups of a workspace you're in", async () => {
    const id = await shared();
    const theirs = await createWorkspace(env.db, "bo", "Bo's team", 1);
    const theirGroup = await createGroup(env.db, theirs.id, "Crew", 2);
    expect(
      (
        await call("ann", "PUT", `/api/spaces/${id}/grants`, {
          granteeType: "group",
          groupId: theirGroup.id,
          role: "viewer",
        })
      ).status,
    ).toBe(404);
    const invite = await inviteToWorkspace(
      env.db,
      theirs.id,
      "ann@example.com",
      "member",
      "bo",
      3,
    );
    await acceptInvite(env.db, invite.id, "ann", "ann@example.com", 4);
    expect(
      (
        await call("ann", "PUT", `/api/spaces/${id}/grants`, {
          granteeType: "group",
          groupId: theirGroup.id,
          role: "viewer",
        })
      ).status,
    ).toBe(200);
  });
});

describe("account deletion", () => {
  test("an owned space passes to a collaborator, or is wiped when nobody can inherit it", async () => {
    const kept = (await share("p")).body.space!.id;
    await putGrant(env.db, kept, "email", "bo@example.com", "editor", "ann", 5);
    outline("ann").nodes.push(
      createNode({ id: "q", text: "Solo", prevSiblingId: "p" }),
    );
    const solo = (await share("q")).body.space!.id;

    await releaseOwnedSpaces({ DB: env.db, USER_OUTLINE: namespace }, "ann");

    expect(await roleFor(env.db, kept, "bo", "bo@example.com")).toBe("admin");
    expect(outline(`space:${solo}`).wiped).toBe(true);
    expect(env.sqlite.query("SELECT id FROM spaces ORDER BY id").all()).toEqual(
      [{ id: kept }],
    );
  });
});

describe("notifications", () => {
  test("a new email grant emails the person once; a role change doesn't", async () => {
    const id = (await share()).body.space!.id;
    const grant = (role: string) =>
      call("ann", "PUT", `/api/spaces/${id}/grants`, {
        granteeType: "email",
        email: "Bo@Example.com",
        role,
      });
    await grant("viewer");
    await grant("editor");
    await Promise.all(deferred);
    expect(sent).toEqual([
      { to: "Bo@Example.com", subject: "ANN shared “Launch plan” with you" },
    ]);
  });

  test("anyone with access lists who else has it, emails only for grants", async () => {
    const id = (await share()).body.space!.id;
    await call("ann", "PUT", `/api/spaces/${id}/grants`, {
      granteeType: "email",
      email: "bo@example.com",
      role: "commenter",
    });
    const people = await call("bo", "GET", `/api/spaces/${id}/people`);
    expect(people.body.people).toEqual([
      { name: "ANN", email: "ann@example.com" },
      // The grant shows its address only: no hint whether an account exists.
      { name: null, email: "bo@example.com" },
    ]);
    expect((await call("cy", "GET", `/api/spaces/${id}/people`)).status).toBe(
      404,
    );
  });

  test("mentions email only verified people with access, never the author", async () => {
    const id = (await share()).body.space!.id;
    await call("ann", "PUT", `/api/spaces/${id}/grants`, {
      granteeType: "email",
      email: "bo@example.com",
      role: "viewer",
    });
    await Promise.all(deferred);
    sent = [];
    const count = await notifyMentions(
      { DB: env.db, EMAIL },
      {
        comment: {
          id: "c1",
          nodeId: "p",
          authorId: "ann",
          authorName: "Ann",
          body: "@bo@example.com @ann@example.com @stranger@example.com see this",
          createdAt: 1,
          editedAt: null,
        },
        spaceId: id,
        noteName: "Launch plan",
        authorId: "ann",
        origin: ORIGIN,
      },
    );
    expect(count).toBe(1);
    expect(sent).toEqual([
      { to: "bo@example.com", subject: "Ann mentioned you in “Launch plan”" },
    ]);
  });
});

describe("copy and move between outlines", () => {
  async function sharedWith(role: string) {
    const id = (await share()).body.space!.id;
    await call("ann", "PUT", `/api/spaces/${id}/grants`, {
      granteeType: "email",
      email: "bo@example.com",
      role,
    });
    // The space's DO holds what sharing copied into it.
    outline(`space:${id}`).batches = [];
    return id;
  }
  const insertedIds = (batch: ChangeOp[] | undefined) =>
    (batch ?? []).flatMap((o) => (o.op === "insert" ? [o.value.text] : []));

  test("an editor copies from their outline, leaving out unticked branches", async () => {
    const id = await sharedWith("editor");
    outline("bo").nodes = [
      createNode({ id: "x", text: "Mine" }),
      createNode({ id: "x1", parentId: "x", text: "Keep" }),
      createNode({
        id: "x2",
        parentId: "x",
        prevSiblingId: "x1",
        text: "Skip",
      }),
    ];
    const res = await call("bo", "POST", `/api/spaces/${id}/copy-in`, {
      rootId: "x",
      exclude: ["x2"],
      mode: "copy",
    });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(insertedIds(outline(`space:${id}`).batches[0])).toEqual([
      "Mine",
      "Keep",
    ]);
    // A copy leaves the original alone.
    expect(outline("bo").batches).toEqual([]);
  });

  test("viewers and commenters can't add to the note", async () => {
    const id = await sharedWith("commenter");
    outline("bo").nodes = [createNode({ id: "x", text: "Mine" })];
    const res = await call("bo", "POST", `/api/spaces/${id}/copy-in`, {
      rootId: "x",
      exclude: [],
      mode: "copy",
    });
    expect(res.status).toBe(403);
    expect(outline(`space:${id}`).batches).toEqual([]);
  });

  test("a move writes the copy, then removes the originals", async () => {
    const id = await sharedWith("editor");
    outline("bo").nodes = [
      createNode({ id: "x", text: "Mine" }),
      createNode({ id: "x1", parentId: "x", text: "Child" }),
    ];
    const res = await call("bo", "POST", `/api/spaces/${id}/copy-in`, {
      rootId: "x",
      exclude: [],
      mode: "move",
    });
    expect(res.body).toMatchObject({ count: 2, removed: true });
    const removed = outline("bo").batches[0]!.flatMap((o) =>
      o.op === "delete" ? [o.key] : [],
    );
    expect(removed.sort()).toEqual(["x", "x1"]);
  });

  test("anyone who can read the note copies from it into their outline", async () => {
    const id = await sharedWith("viewer");
    const res = await call("bo", "POST", `/api/spaces/${id}/copy-out`, {
      rootId: "p1",
      exclude: [],
    });
    expect(res.status).toBe(200);
    expect(insertedIds(outline("bo").batches[0])).toEqual(["Copy"]);
    expect(
      (
        await call("cy", "POST", `/api/spaces/${id}/copy-out`, {
          rootId: "p1",
          exclude: [],
        })
      ).status,
    ).toBe(404);
  });
});

describe("ending a share", () => {
  test("the owner stops sharing: the note comes back into the link bullet, then the space is gone", async () => {
    const res = await share();
    const id = res.body.space!.id;
    // The personal outline as the share left it: the link bullet in place.
    const [linkOp] = outline("ann").batches[0]!;
    outline("ann").nodes = [
      createNode({ id: "a", text: "Inbox" }),
      linkOp!.op === "delete" ? createNode({ id: "x" }) : linkOp!.value,
    ];
    outline("ann").batches = [];
    await call("ann", "PUT", `/api/spaces/${id}/grants`, {
      granteeType: "email",
      email: "bo@example.com",
      role: "admin",
    });
    // Another admin can't end the share; only the owner can.
    expect((await call("bo", "POST", `/api/spaces/${id}/unshare`)).status).toBe(
      403,
    );
    const done = await call("ann", "POST", `/api/spaces/${id}/unshare`);
    expect(done.body.unshared).toBe(true);
    const restored = outline("ann").batches[0]!;
    expect(restored[0]).toMatchObject({
      op: "update",
      value: { id: "p", text: "**Launch** plan" },
    });
    expect(
      restored
        .slice(1)
        .flatMap((o) => (o.op === "insert" ? [o.value.id] : []))
        .sort(),
    ).toEqual(["p1", "p2"]);
    expect(outline(`space:${id}`).wiped).toBe(true);
    expect(outline(`space:${id}`).disconnects).toBeGreaterThan(0);
    expect((await call("bo", "GET", `/api/spaces/${id}`)).status).toBe(404);
  });

  test("someone shared by email can leave; they can't remove anyone else", async () => {
    const id = (await share()).body.space!.id;
    for (const email of ["bo@example.com", "cy@example.com"])
      await call("ann", "PUT", `/api/spaces/${id}/grants`, {
        granteeType: "email",
        email,
        role: "viewer",
      });
    const other = await call("bo", "DELETE", `/api/spaces/${id}/grants`, {
      granteeType: "email",
      granteeId: "cy@example.com",
    });
    expect(other.status).toBe(403);
    const left = await call("bo", "DELETE", `/api/spaces/${id}/grants`, {
      granteeType: "email",
      granteeId: "BO@example.com",
    });
    expect(left.body).toEqual({ left: true, stillHasAccess: false });
    expect((await call("bo", "GET", `/api/spaces/${id}`)).status).toBe(404);
  });
});
