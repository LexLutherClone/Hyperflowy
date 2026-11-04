import { describe, expect, test } from "bun:test";

import type { Node } from "./schema";

import { buildBoard, lastChildId, planBoardDrop } from "./board";
import { buildTreeIndex, createNode } from "./tree";

// root
//   todo   -> a, b(done), c
//   doing  -> d
//   done   (empty)
function fixture(extra: Node[] = []) {
  return buildTreeIndex([
    createNode({ id: "root" }),
    createNode({ id: "todo", parentId: "root" }),
    createNode({ id: "doing", parentId: "root", prevSiblingId: "todo" }),
    createNode({ id: "done", parentId: "root", prevSiblingId: "doing" }),
    createNode({ id: "a", parentId: "todo" }),
    createNode({
      id: "b",
      parentId: "todo",
      prevSiblingId: "a",
      completed: true,
    }),
    createNode({ id: "c", parentId: "todo", prevSiblingId: "b" }),
    createNode({ id: "d", parentId: "doing" }),
    ...extra,
  ]);
}
const showAll = () => false;
const hideCompleted = (n: Node) => n.completed;

describe("buildBoard", () => {
  test("columns are the root's children, cards their children, in sibling order", () => {
    const board = buildBoard(fixture(), "root", showAll);
    expect(board.map((c) => c.id)).toEqual(["todo", "doing", "done"]);
    expect(board[0]!.cards.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(board[1]!.cards.map((c) => c.id)).toEqual(["d"]);
    expect(board[2]!.cards).toEqual([]);
  });

  test("the view's prune hides cards without touching them", () => {
    const board = buildBoard(fixture(), "root", hideCompleted);
    expect(board[0]!.cards.map((c) => c.id)).toEqual(["a", "c"]);
  });

  test("a mirrored column reads its cards from the source", () => {
    const index = fixture([
      createNode({ id: "src", parentId: null, prevSiblingId: "root" }),
      createNode({ id: "s1", parentId: "src" }),
      createNode({
        id: "m",
        parentId: "root",
        prevSiblingId: "done",
        mirrorOf: "src",
      }),
    ]);
    const board = buildBoard(index, "root", showAll, (n) => n.mirrorOf ?? n.id);
    const mirrored = board.find((c) => c.id === "m")!;
    expect(mirrored.contentId).toBe("src");
    expect(mirrored.cards.map((c) => c.id)).toEqual(["s1"]);
  });
});

describe("planBoardDrop", () => {
  test("into an empty column lands as its first child", () => {
    const index = fixture();
    const [, , done] = buildBoard(index, "root", showAll);
    expect(planBoardDrop(index, done!, "a", 0)).toEqual({
      parentId: "done",
      afterSiblingId: null,
    });
  });

  test("into another column's end lands after its last visible card", () => {
    const index = fixture();
    const [, doing] = buildBoard(index, "root", showAll);
    expect(planBoardDrop(index, doing!, "a", 1)).toEqual({
      parentId: "doing",
      afterSiblingId: "d",
    });
  });

  test("reordering down within a column accounts for the card leaving its slot", () => {
    const index = fixture();
    const [todo] = buildBoard(index, "root", showAll);
    // Drag a (index 0) to below c (visible index 3, the end).
    expect(planBoardDrop(index, todo!, "a", 3)).toEqual({
      parentId: "todo",
      afterSiblingId: "c",
    });
  });

  test("dropping onto its own slot is a no-op", () => {
    const index = fixture();
    const [todo] = buildBoard(index, "root", showAll);
    expect(planBoardDrop(index, todo!, "a", 0)).toBeNull();
    expect(planBoardDrop(index, todo!, "a", 1)).toBeNull();
  });

  test("a hidden card keeps its place: the predecessor is a visible real sibling", () => {
    const index = fixture();
    const [todo, doing] = buildBoard(index, "root", hideCompleted);
    // Visible todo = [a, c]; b (completed) is hidden between them.
    expect(planBoardDrop(index, todo!, "d", 1)).toEqual({
      parentId: "todo",
      afterSiblingId: "a",
    });
    expect(doing!.cards.map((c) => c.id)).toEqual(["d"]);
  });

  test("a card dropped into a mirrored column lands under the source", () => {
    const index = fixture([
      createNode({ id: "src", parentId: null, prevSiblingId: "root" }),
      createNode({
        id: "m",
        parentId: "root",
        prevSiblingId: "done",
        mirrorOf: "src",
      }),
    ]);
    const board = buildBoard(index, "root", showAll, (n) => n.mirrorOf ?? n.id);
    const mirrored = board.find((c) => c.id === "m")!;
    expect(planBoardDrop(index, mirrored, "a", 0)).toEqual({
      parentId: "src",
      afterSiblingId: null,
    });
  });
});

test("lastChildId counts hidden children so appends never split the chain", () => {
  expect(lastChildId(fixture(), "todo")).toBe("c");
  expect(lastChildId(fixture(), "done")).toBeNull();
});
