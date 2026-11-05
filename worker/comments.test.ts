import { beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type {
  Comment,
  CommentSummary,
  CommentThread,
  ThreadView,
} from "../src/data/comments";
import type { SpaceRole } from "../src/data/space-policy";
import type { Node } from "../src/data/wire-schema";

import { createNode } from "../src/data/tree";
import { handleComments } from "./comments";

const ORIGIN = "https://app.example";

/** The comment storage of one space's DO, in memory. */
class FakeSpace {
  nodes: Node[] = [createNode({ id: "n1" }), createNode({ id: "n2" })];
  comments: Comment[] = [];
  threads = new Map<string, CommentThread>();
  async getNodes() {
    return this.nodes;
  }
  async listComments(nodeId: string): Promise<ThreadView> {
    return {
      comments: this.comments.filter((c) => c.nodeId === nodeId),
      thread: this.threads.get(nodeId) ?? {
        nodeId,
        resolvedAt: null,
        resolvedBy: null,
      },
    };
  }
  async commentSummary(): Promise<CommentSummary[]> {
    const ids = [...new Set(this.comments.map((c) => c.nodeId))];
    return ids.map((nodeId) => ({
      nodeId,
      count: this.comments.filter((c) => c.nodeId === nodeId).length,
      resolved: this.threads.has(nodeId),
    }));
  }
  async getComment(id: string) {
    return this.comments.find((c) => c.id === id) ?? null;
  }
  async addComment(c: Comment) {
    this.comments.push(c);
    this.threads.delete(c.nodeId);
  }
  async editComment(id: string, body: string, at: number) {
    const c = this.comments.find((x) => x.id === id)!;
    this.comments = this.comments.map((x) =>
      x === c ? { ...x, body, editedAt: at } : x,
    );
  }
  async deleteComment(id: string) {
    this.comments = this.comments.filter((c) => c.id !== id);
  }
  async setThreadResolved(nodeId: string, by: string | null, at: number) {
    if (by === null) this.threads.delete(nodeId);
    else this.threads.set(nodeId, { nodeId, resolvedAt: at, resolvedBy: by });
  }
}

interface Body extends Partial<ThreadView> {
  comment?: Comment;
  summary?: CommentSummary[];
  error?: string;
}

let space: FakeSpace;
beforeEach(() => {
  space = new FakeSpace();
});

async function call(
  userId: string,
  role: SpaceRole,
  method: string,
  path = "",
  input?: Readonly<Record<string, string | boolean>>,
) {
  const url = new URL(`${ORIGIN}/api/spaces/s1/comments${path}`);
  const request = new Request(url, {
    method,
    headers:
      input === undefined
        ? { origin: ORIGIN }
        : { origin: ORIGIN, "content-type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const rest = url.pathname.split("/").slice(5).filter(Boolean);
  const response = await Effect.runPromise(
    handleComments(
      request,
      { WORKSPACE_LIMIT: { limit: async () => ({ success: true }) } },
      {
        userId,
        name: userId.toUpperCase(),
        role,
        space,
      },
      rest,
    ),
  );
  // SAFETY: the handler answers with JSON shaped like Body.
  return { status: response.status, body: (await response.json()) as Body };
}

describe("comments", () => {
  test("a commenter adds; everyone with access reads the thread and counts", async () => {
    const added = await call("bo", "commenter", "POST", "", {
      nodeId: "n1",
      body: "  Typo in the second line  ",
    });
    expect(added.status).toBe(201);
    expect(added.body.comment).toMatchObject({
      nodeId: "n1",
      authorId: "bo",
      authorName: "BO",
      body: "Typo in the second line",
    });
    const read = await call("cy", "viewer", "GET", "?nodeId=n1");
    expect(read.body.comments!.map((c) => c.body)).toEqual([
      "Typo in the second line",
    ]);
    const summary = await call("cy", "viewer", "GET");
    expect(summary.body.summary).toEqual([
      { nodeId: "n1", count: 1, resolved: false },
    ]);
  });

  test("viewers can't comment or resolve; empty or unknown targets are refused", async () => {
    expect(
      (await call("cy", "viewer", "POST", "", { nodeId: "n1", body: "hi" }))
        .status,
    ).toBe(403);
    expect(
      (
        await call("cy", "viewer", "PUT", "/threads/n1", {
          resolved: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("bo", "editor", "POST", "", { nodeId: "n1", body: "  " }))
        .status,
    ).toBe(400);
    expect(
      (await call("bo", "editor", "POST", "", { nodeId: "gone", body: "hi" }))
        .status,
    ).toBe(404);
  });

  test("only the author edits; the author or an admin deletes", async () => {
    const { body } = await call("bo", "commenter", "POST", "", {
      nodeId: "n1",
      body: "first",
    });
    const id = body.comment!.id;
    expect(
      (await call("ann", "admin", "PATCH", `/${id}`, { body: "hijack" }))
        .status,
    ).toBe(403);
    expect(
      (await call("bo", "commenter", "PATCH", `/${id}`, { body: "fixed" }))
        .status,
    ).toBe(200);
    expect(space.comments[0]).toMatchObject({ body: "fixed" });
    expect(space.comments[0]!.editedAt).not.toBeNull();
    expect((await call("cy", "editor", "DELETE", `/${id}`)).status).toBe(403);
    expect((await call("ann", "admin", "DELETE", `/${id}`)).status).toBe(200);
    expect(space.comments).toEqual([]);
  });

  test("resolving, and a new comment reopens", async () => {
    await call("bo", "commenter", "POST", "", { nodeId: "n1", body: "hm" });
    await call("ann", "editor", "PUT", "/threads/n1", { resolved: true });
    expect((await call("cy", "viewer", "GET")).body.summary![0]!.resolved).toBe(
      true,
    );
    await call("bo", "commenter", "POST", "", { nodeId: "n1", body: "again" });
    expect((await call("cy", "viewer", "GET")).body.summary![0]).toEqual({
      nodeId: "n1",
      count: 2,
      resolved: false,
    });
  });

  test("writes need a same-origin request", async () => {
    const request = new Request(`${ORIGIN}/api/spaces/s1/comments`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ nodeId: "n1", body: "x" }),
    });
    const response = await Effect.runPromise(
      handleComments(
        request,
        { WORKSPACE_LIMIT: { limit: async () => ({ success: true }) } },
        {
          userId: "bo",
          name: "Bo",
          role: "editor",
          space,
        },
        [],
      ),
    );
    expect(response.status).toBe(403);
    expect(space.comments).toEqual([]);
  });
});
