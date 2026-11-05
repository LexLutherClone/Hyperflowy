import { describe, expect, test } from "bun:test";

import type { Node } from "../src/data/wire-schema";

import { createNode } from "../src/data/tree";
import { planShare, spaceLinkText } from "./share-plan";

// a
// b            <- shared
//   b1
//     b1x
//   b2
// c
const outline = (extra: Partial<Record<string, Partial<Node>>> = {}): Node[] =>
  [
    createNode({ id: "a" }),
    createNode({ id: "b", prevSiblingId: "a", text: "Project", isTask: true }),
    createNode({ id: "b1", parentId: "b" }),
    createNode({ id: "b1x", parentId: "b1" }),
    createNode({ id: "b2", parentId: "b", prevSiblingId: "b1" }),
    createNode({ id: "c", prevSiblingId: "b" }),
  ].map((n) => ({ ...n, ...extra[n.id] }));

const none = new Set<string>();
const LINK = "[Project](https://app.example/s/x)";

describe("planShare", () => {
  test("the subtree moves; the root stays in place as a link", () => {
    const plan = planShare(outline(), "b", none, LINK, 5);
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.spaceNodes.map((n) => n.id).sort()).toEqual([
      "b",
      "b1",
      "b1x",
      "b2",
    ]);
    const root = plan.spaceNodes.find((n) => n.id === "b")!;
    expect([root.parentId, root.prevSiblingId, root.text]).toEqual([
      null,
      null,
      "Project",
    ]);
    // The space keeps the subtree's own structure.
    expect(plan.spaceNodes.find((n) => n.id === "b2")!.prevSiblingId).toBe(
      "b1",
    );

    const [update, ...deletes] = plan.personalOps;
    expect(update).toMatchObject({
      op: "update",
      value: {
        id: "b",
        parentId: null,
        prevSiblingId: "a",
        text: LINK,
        isTask: false,
        updatedAt: 5,
      },
    });
    expect(deletes.map((d) => d.op === "delete" && d.key).sort()).toEqual([
      "b1",
      "b1x",
      "b2",
    ]);
  });

  test("an unknown node is not found", () => {
    expect(planShare(outline(), "zzz", none, LINK, 5)).toEqual({
      error: "not-found",
    });
  });

  test("a lock inside, or on an ancestor, refuses", () => {
    expect(
      planShare(outline({ b1x: { locked: true } }), "b", none, LINK, 5),
    ).toEqual({ error: "locked" });
    expect(
      planShare(outline({ b: { locked: true } }), "b1", none, LINK, 5),
    ).toEqual({ error: "locked" });
  });

  test("daily-note pages refuse", () => {
    expect(planShare(outline(), "b", new Set(["b1"]), LINK, 5)).toEqual({
      error: "daily",
    });
  });

  test("mirrors may not cross the boundary in either direction", () => {
    // Inside mirrors outside: private content would ride into the share.
    expect(
      planShare(outline({ b2: { mirrorOf: "a" } }), "b", none, LINK, 5),
    ).toEqual({ error: "mirror-out" });
    // Outside mirrors inside: that mirror would be orphaned.
    expect(
      planShare(outline({ c: { mirrorOf: "b1" } }), "b", none, LINK, 5),
    ).toEqual({ error: "mirror-in" });
    // A mirror wholly inside is fine.
    expect(
      "error" in
        planShare(outline({ b2: { mirrorOf: "b1x" } }), "b", none, LINK, 5),
    ).toBe(false);
  });
});

test("link text is a markdown link with a safe label", () => {
  expect(spaceLinkText("Plan [v2]", "https://x/s/1")).toBe(
    "[Plan v2](https://x/s/1)",
  );
  expect(spaceLinkText("  ", "https://x/s/1")).toBe(
    "[Shared note](https://x/s/1)",
  );
});
