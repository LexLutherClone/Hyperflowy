import { describe, expect, test } from "bun:test";

import { previewLines, spaceLinkId } from "./space-link";
import { createNode } from "./tree";

const ORIGIN = "https://app.example";

describe("spaceLinkId", () => {
  test("a bullet that is exactly a same-origin space link", () => {
    expect(spaceLinkId("[Plan](https://app.example/s/abc)", ORIGIN)).toBe(
      "abc",
    );
    expect(spaceLinkId("[Plan](/s/abc)", ORIGIN)).toBe("abc");
    expect(spaceLinkId("  [Plan](/s/abc/)  ", ORIGIN)).toBe("abc");
  });

  test("anything else is not", () => {
    expect(
      spaceLinkId("[Plan](https://evil.example/s/abc)", ORIGIN),
    ).toBeNull();
    expect(spaceLinkId("See [Plan](/s/abc)", ORIGIN)).toBeNull();
    expect(spaceLinkId("[Plan](/s/abc/node)", ORIGIN)).toBeNull();
    expect(spaceLinkId("[Plan](/x/abc)", ORIGIN)).toBeNull();
    expect(spaceLinkId("Plan", ORIGIN)).toBeNull();
  });
});

describe("previewLines", () => {
  // plan
  //   a
  //     a1
  //   b (collapsed) -> b1, b2
  //   c (done task)
  const space = [
    createNode({ id: "plan", text: "Plan" }),
    createNode({ id: "a", parentId: "plan", text: "A" }),
    createNode({ id: "a1", parentId: "a", text: "A1" }),
    createNode({
      id: "b",
      parentId: "plan",
      prevSiblingId: "a",
      text: "B",
      collapsed: true,
    }),
    createNode({ id: "b1", parentId: "b" }),
    createNode({ id: "b2", parentId: "b", prevSiblingId: "b1" }),
    createNode({
      id: "c",
      parentId: "plan",
      prevSiblingId: "b",
      text: "C",
      isTask: true,
      completed: true,
    }),
  ];

  test("a single shared root shows its children, in order, folding collapsed nodes", () => {
    expect(
      previewLines(space).lines.map((l) => [l.id, l.depth, l.hiddenChildren]),
    ).toEqual([
      ["a", 0, 0],
      ["a1", 1, 0],
      ["b", 0, 2],
      ["c", 0, 0],
    ]);
    expect(previewLines(space).lines.at(-1)).toMatchObject({
      isTask: true,
      completed: true,
    });
  });

  test("the cap reports how many lines it left out", () => {
    const preview = previewLines(space, 2);
    expect(preview.lines.map((l) => l.id)).toEqual(["a", "a1"]);
    expect(preview.more).toBe(2);
  });

  test("several top-level nodes are all lines", () => {
    const flat = [
      createNode({ id: "x", text: "X" }),
      createNode({ id: "y", text: "Y", prevSiblingId: "x" }),
    ];
    expect(previewLines(flat).lines.map((l) => l.id)).toEqual(["x", "y"]);
  });
});
