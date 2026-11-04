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
  await card(page, "a")
    .getByRole("button", { name: /Card actions/ })
    .click();
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
  await card(page, "a")
    .getByRole("button", { name: /Card actions/ })
    .click();
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

test("a card opens its node from its menu", async ({ page }) => {
  await openBoard(page);
  await card(page, "c")
    .getByRole("button", { name: /Card actions/ })
    .click();
  await page.getByRole("menuitem", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/c$/);
});

async function storedText(page: Page, id: string) {
  const stored: ApiNode[] = await page.evaluate(async () =>
    (await fetch("/api/nodes")).json(),
  );
  return stored.find((n) => n.id === id)!.text;
}

test("clicking a card's text edits it in place; Enter saves the node", async ({
  page,
}) => {
  await openBoard(page);
  await card(page, "a")
    .getByRole("button", { name: "Edit “Write spec”" })
    .click();
  const editor = card(page, "a").getByRole("textbox", { name: "Card text" });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Write spec");
  await page.keyboard.type(" v2");
  await page.keyboard.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect(card(page, "a")).toContainText("Write spec v2");
  await expect.poll(() => storedText(page, "a")).toBe("Write spec v2");

  // One edit session is one undo step.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => storedText(page, "a")).toBe("Write spec");
});

test("Escape discards a card edit; blur keeps it", async ({ page }) => {
  await openBoard(page);
  const editButton = card(page, "c").getByRole("button", {
    name: "Edit “Review”",
  });
  await editButton.click();
  await page.keyboard.type(" nope");
  await page.keyboard.press("Escape");
  await expect(card(page, "c")).toContainText("Review");
  await expect(card(page, "c")).not.toContainText("nope");
  expect(await storedText(page, "c")).toBe("Review");

  await editButton.click();
  await page.keyboard.type(" kept");
  await column(page, "done")
    .locator("header")
    .click({ position: { x: 200, y: 5 } });
  await expect.poll(() => storedText(page, "c")).toBe("Review kept");
});

test("a mouse drag does not also start an edit", async ({ page }) => {
  await openBoard(page);
  await card(page, "a").dragTo(column(page, "done"));
  await expect.poll(() => cardIds(page, "done")).toEqual(["a"]);
  await expect(page.getByRole("textbox", { name: "Card text" })).toHaveCount(0);
});

test.describe("touch", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  async function center(page: Page, selector: string) {
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(`no box for ${selector}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  test("a held touch drags a card to another column", async ({ page }) => {
    await openBoard(page);
    const from = await center(page, '[data-board-card="a"]');
    // At phone width only the left edge of "Doing" is on screen: drop there,
    // just above its first card.
    const review = await page.locator('[data-board-card="c"]').boundingBox();
    if (!review) throw new Error("no box for Review");
    const to = { x: Math.min(review.x + 40, 380), y: review.y + 4 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [from],
    });
    // Gesture duration, not a rendering wait: hold before moving the finger.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(page.locator(".board-drag-ghost")).toBeVisible();
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * step) / 8,
            y: from.y + ((to.y - from.y) * step) / 8,
          },
        ],
      });
    }
    await expect(page.locator("[data-board-drop-line]")).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect.poll(() => cardIds(page, "doing")).toEqual(["a", "c"]);
    expect(await cardIds(page, "todo")).toEqual(["b"]);
    await expect(page.locator(".board-drag-ghost")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Card text" })).toHaveCount(
      0,
    );
  });

  test("a quick tap edits the card instead of dragging it", async ({
    page,
  }) => {
    await openBoard(page);
    await card(page, "a")
      .getByRole("button", { name: "Edit “Write spec”" })
      .tap();
    await expect(
      card(page, "a").getByRole("textbox", { name: "Card text" }),
    ).toBeFocused();
    await expect(page.locator(".board-drag-ghost")).toHaveCount(0);
  });

  test("a swipe on a card scrolls the board and moves nothing", async ({
    page,
  }) => {
    await openBoard(page);
    const board = page.locator("[data-board]");
    const before = await board.evaluate((el) => el.scrollLeft);
    const from = await center(page, '[data-board-card="a"]');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [from],
    });
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x - step * 25, y: from.y }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => board.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(before + 40);
    await expect(page.locator(".board-drag-ghost")).toHaveCount(0);
    expect(await cardIds(page, "todo")).toEqual(["a", "b"]);
    expect(await cardIds(page, "doing")).toEqual(["c"]);
  });
});
