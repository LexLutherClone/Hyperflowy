import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type ApiNode, type SeedNode } from "./fixtures";

// Board view (ADR 0075). The board is a view of real nodes, so every test here
// proves one direction of the two-way contract: a board gesture changes the
// outline, or an outline change shows on the board.
//
//   Project (project)
//     To do (todo)    -> Write spec (a), Ship it (b, task)
//     Doing (doing)   -> Review (c)
//     Done (done)     (empty)
const TREE: SeedNode[] = [
  { id: "project", parentId: null, prevSiblingId: null, text: "Project" },
  { id: "todo", parentId: "project", prevSiblingId: null, text: "To do" },
  { id: "doing", parentId: "project", prevSiblingId: "todo", text: "Doing" },
  { id: "done", parentId: "project", prevSiblingId: "doing", text: "Done" },
  { id: "a", parentId: "todo", prevSiblingId: null, text: "Write spec" },
  {
    id: "b",
    parentId: "todo",
    prevSiblingId: "a",
    text: "Ship it",
    isTask: true,
  },
  { id: "c", parentId: "doing", prevSiblingId: null, text: "Review" },
];

const BOARD_ROW = { key: "project", value: { id: "project", view: "board" } };

const column = (page: Page, id: string) =>
  page.locator(`[data-board-column="${id}"]`);
const cards = (page: Page, columnId: string) =>
  column(page, columnId).locator("[data-board-card]");
const card = (page: Page, id: string) =>
  page.locator(`[data-board-card="${id}"]`);

async function openBoard(page: Page) {
  const controller = await seedOutline(page, TREE, {
    kv: { "node-views": [BOARD_ROW] },
  });
  await page.goto("/project");
  await column(page, "todo").waitFor({ state: "visible" });
  return controller;
}

async function cardIds(page: Page, columnId: string) {
  return cards(page, columnId).evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-board-card")),
  );
}

test("the View menu turns a page into a board and back into the list", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.goto("/project");
  const row = page.locator('li[data-node-id="todo"] > .outline-row .node-text');
  await row.waitFor({ state: "visible" });

  await page.getByRole("button", { name: "View options" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Board view" }).click();
  await page.keyboard.press("Escape");
  await expect(column(page, "todo")).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(await cardIds(page, "todo")).toEqual(["a", "b"]);
  expect(await cardIds(page, "doing")).toEqual(["c"]);
  expect(await cardIds(page, "done")).toEqual([]);

  await page.getByRole("button", { name: "View options" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Board view" }).click();
  await expect(row).toBeVisible();
  await expect(column(page, "todo")).toHaveCount(0);
});

test("a stored board opens as a board", async ({ page }) => {
  await openBoard(page);
  await expect(column(page, "done")).toBeVisible();
});

test("Move to puts the card under the other column in the outline", async ({
  page,
}) => {
  await openBoard(page);
  await card(page, "a").getByRole("button", { name: /Move/ }).click();
  await page.getByRole("menuitem", { name: "Done" }).click();

  await expect.poll(() => cardIds(page, "done")).toEqual(["a"]);
  expect(await cardIds(page, "todo")).toEqual(["b"]);

  // The outline agrees: the node moved, it wasn't copied.
  const stored: ApiNode[] = await page.evaluate(async () =>
    (await fetch("/api/nodes")).json(),
  );
  const moved = stored.find((n) => n.id === "a")!;
  expect(moved.parentId).toBe("done");
  expect(moved.prevSiblingId).toBeNull();
  expect(stored.find((n) => n.id === "b")!.prevSiblingId).toBeNull();
});

test("dragging a card between columns moves the node to that slot", async ({
  page,
}) => {
  await openBoard(page);
  // Drop onto the top half of "Review" -> lands before it.
  const target = card(page, "c");
  const box = (await target.boundingBox())!;
  await card(page, "b").dragTo(target, {
    targetPosition: { x: box.width / 2, y: 2 },
  });

  await expect.poll(() => cardIds(page, "doing")).toEqual(["b", "c"]);
  expect(await cardIds(page, "todo")).toEqual(["a"]);
  const stored: ApiNode[] = await page.evaluate(async () =>
    (await fetch("/api/nodes")).json(),
  );
  expect(stored.find((n) => n.id === "b")!.parentId).toBe("doing");
  expect(stored.find((n) => n.id === "c")!.prevSiblingId).toBe("b");
});

test("a move is one undo step", async ({ page }) => {
  await openBoard(page);
  await card(page, "a").getByRole("button", { name: /Move/ }).click();
  await page.getByRole("menuitem", { name: "Doing" }).click();
  await expect.poll(() => cardIds(page, "doing")).toEqual(["c", "a"]);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => cardIds(page, "todo")).toEqual(["a", "b"]);
  expect(await cardIds(page, "doing")).toEqual(["c"]);
});

test("an outline change from another device shows on the board", async ({
  page,
}) => {
  const controller = await openBoard(page);
  const stored: ApiNode[] = await page.evaluate(async () =>
    (await fetch("/api/nodes")).json(),
  );
  const byId = new Map(stored.map((n) => [n.id, n]));
  // Another device moves "Review" to Done and renames it.
  await controller.injectExternalChange([
    {
      op: "update",
      value: {
        ...byId.get("c")!,
        parentId: "done",
        prevSiblingId: null,
        text: "Reviewed",
      },
    },
  ]);
  await expect.poll(() => cardIds(page, "done")).toEqual(["c"]);
  await expect(card(page, "c")).toContainText("Reviewed");
  expect(await cardIds(page, "doing")).toEqual([]);
});

test("adding a card appends a child node; a task checks off in place", async ({
  page,
}) => {
  await openBoard(page);
  await column(page, "done").getByRole("button", { name: "Add card" }).click();
  await page.getByRole("textbox", { name: "Add card" }).fill("Celebrate");
  await page.keyboard.press("Enter");
  await expect(cards(page, "done")).toHaveCount(1);
  await expect(cards(page, "done")).toContainText("Celebrate");

  await card(page, "b").getByRole("checkbox").click();
  await expect
    .poll(async () => {
      const stored: ApiNode[] = await page.evaluate(async () =>
        (await fetch("/api/nodes")).json(),
      );
      return stored.find((n) => n.id === "b")!.completed;
    })
    .toBe(true);
});

test("a card opens its node", async ({ page }) => {
  await openBoard(page);
  await card(page, "c")
    .getByRole("button", { name: "Review", exact: true })
    .click();
  await expect(page).toHaveURL(/\/c$/);
});
