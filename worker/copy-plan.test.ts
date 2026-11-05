import { describe, expect, test } from "bun:test";

import type { ChangeOp, Node } from "../src/data/wire-schema";

import { createNode } from "../src/data/tree";
import { planCopy } from "./copy-plan";

// Source (a personal outline):
// a
// p          <- copied
//   p1
//     p1x
//   p2 (mirror of a)
//   p3
// c
const source = (extra: Partial<Record<string, Partial<Node>>> = {}): Node[] =>
  [
    createNode({ id: "a", text: "Private A" }),
    createNode({ id: "p", prevSiblingId: "a", text: "Plan", locked: false }),
    createNode({ id: "p1", parentId: "p", text: "One" }),
    createNode({ id: "p1x", parentId: "p1", text: "One deep" }),
    createNode({
      id: "p2",
      parentId: "p",
      prevSiblingId: "p1",
      text: "stale snapshot",
      mirrorOf: "a",
    }),
    createNode({ id: "p3", parentId: "p", prevSiblingId: "p2", text: "Three" }),
    createNode({ id: "c", prevSiblingId: "p" }),
  ].map((n) => ({ ...n, ...extra[n.id] }));

// Target (a shared page): one root with one child.
const target = [
  createNode({ id: "r", text: "Shared" }),
  createNode({ id: "r1", parentId: "r", text: "Existing" }),
];

let n = 0;
const base = {
  target,
  dailyNodeIds: new Set<string>(),
  now: 9,
  newId: () => `new${++n}`,
};
const values = (ops: ChangeOp[]) =>
  ops.flatMap((o) => (o.op === "delete" ? [] : [o.value]));

describe("copy", () => {
  test("selected descendants come along with fresh ids, appended after the target's last bullet", () => {
    n = 0;
    const plan = planCopy({
      ...base,
      source: source(),
      rootId: "p",
      exclude: new Set(["p2"]),
      mode: "copy",
    });
    if ("error" in plan) throw new Error(plan.error);
    const copied = values(plan.targetOps);
    expect(
      copied.map((v) => [v.id, v.parentId, v.prevSiblingId, v.text]),
    ).toEqual([
      ["new1", "r", "r1", "Plan"],
      ["new2", "new1", null, "One"],
      ["new3", "new2", null, "One deep"],
      // p2 was left out, so p3 follows p1 directly.
      ["new4", "new1", "new2", "Three"],
    ]);
    expect(plan.sourceOps).toEqual([]);
    expect(plan.count).toBe(4);
  });

  test("unticking a bullet drops its whole branch", () => {
    const plan = planCopy({
      ...base,
      source: source(),
      rootId: "p",
      exclude: new Set(["p1", "p2"]),
      mode: "copy",
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(values(plan.targetOps).map((v) => v.text)).toEqual([
      "Plan",
      "Three",
    ]);
  });

  test("a mirror becomes a plain bullet with the text it mirrors; locks and bookmarks stay behind", () => {
    const plan = planCopy({
      ...base,
      source: source({ p: { locked: true, bookmarkedAt: 5 } }),
      rootId: "p",
      exclude: new Set(),
      mode: "copy",
    });
    if ("error" in plan) throw new Error(plan.error);
    const copied = values(plan.targetOps);
    const mirror = copied.find((v) => v.text === "Private A")!;
    expect(mirror.mirrorOf).toBeNull();
    expect(copied.every((v) => !v.locked && v.bookmarkedAt === null)).toBe(
      true,
    );
  });

  test("into an empty or multi-root outline, copies land at the top level", () => {
    const plan = planCopy({
      ...base,
      source: source(),
      rootId: "p1",
      exclude: new Set(),
      mode: "copy",
      target: [],
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(values(plan.targetOps)[0]).toMatchObject({
      parentId: null,
      prevSiblingId: null,
    });
  });
});

describe("move", () => {
  test("takes the whole subtree, then removes the originals and relinks the chain", () => {
    const plan = planCopy({
      ...base,
      source: source({ p2: { mirrorOf: null } }),
      rootId: "p",
      exclude: new Set(["p1"]),
      mode: "move",
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.count).toBe(5);
    const deletes = plan.sourceOps.flatMap((o) =>
      o.op === "delete" ? [o.key] : [],
    );
    expect(deletes.sort()).toEqual(["p", "p1", "p1x", "p2", "p3"]);
    expect(values(plan.sourceOps)).toEqual([
      expect.objectContaining({ id: "c", prevSiblingId: "a" }),
    ]);
  });

  test("refuses locks, daily pages, and mirrors pointing in", () => {
    const move = (src: Node[], daily = new Set<string>()) =>
      planCopy({
        ...base,
        source: src,
        rootId: "p",
        exclude: new Set(),
        mode: "move",
        dailyNodeIds: daily,
      });
    expect(move(source({ p3: { locked: true } }))).toEqual({ error: "locked" });
    expect(move(source(), new Set(["p1"]))).toEqual({ error: "daily" });
    expect(move(source({ c: { mirrorOf: "p1" } }))).toEqual({
      error: "mirror-in",
    });
  });

  test("an unknown root is not found", () => {
    expect(
      planCopy({
        ...base,
        source: source(),
        rootId: "zz",
        exclude: new Set(),
        mode: "copy",
      }),
    ).toEqual({ error: "not-found" });
  });
});
