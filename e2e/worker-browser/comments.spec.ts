import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { createNode } from "../../src/data/tree";
import { startBackend } from "./backend";

// Comments on a shared note (ADR 0081) against the real Worker, DO, and D1,
// with three accounts: Ann owns the note, Bo can comment, Cy can view.

let backend: Awaited<ReturnType<typeof startBackend>>;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  backend = await startBackend();
});
test.afterAll(async () => {
  await backend?.dispose();
});

async function account(
  browser: Browser,
  email: string,
  name: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const { origin } = backend;
  const context = await browser.newContext({ baseURL: origin });
  const password = "disposable-browser-password";
  const signup = await context.request.post(
    `${origin}/api/auth/sign-up/email`,
    { headers: { origin }, data: { email, name, password } },
  );
  expect(signup.status()).toBe(200);
  const { user }: { user: { id: string } } = await signup.json();
  await backend.db
    .prepare('UPDATE "user" SET emailVerified=1 WHERE id=?')
    .bind(user.id)
    .run();
  expect(
    (
      await context.request.post(`${origin}/api/auth/sign-in/email`, {
        headers: { origin },
        data: { email, password },
      })
    ).status(),
  ).toBe(200);
  return { context, page: await context.newPage() };
}

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row`);

test("comment, read, resolve, and moderate by role", async ({ browser }) => {
  const { origin } = backend;
  const ann = await account(browser, "ann@comments.test", "Ann");
  const bo = await account(browser, "bo@comments.test", "Bo");
  const cy = await account(browser, "cy@comments.test", "Cy");
  const post = (
    path: string,
    data: NonNullable<
      Parameters<BrowserContext["request"]["fetch"]>[1]
    >["data"],
    method = "POST",
  ) =>
    ann.context.request.fetch(`${origin}${path}`, {
      method,
      headers: { origin },
      data,
    });

  await post("/api/nodes", {
    nodes: [
      createNode({ id: "plan", text: "Launch plan" }),
      createNode({ id: "copy", parentId: "plan", text: "Write copy" }),
    ],
  });
  const shared = await post("/api/spaces", { nodeId: "plan" });
  const { space }: { space: { id: string } } = await shared.json();
  const grants = `/api/spaces/${space.id}/grants`;
  await post(
    grants,
    { granteeType: "email", email: "bo@comments.test", role: "commenter" },
    "PUT",
  );
  await post(
    grants,
    { granteeType: "email", email: "cy@comments.test", role: "viewer" },
    "PUT",
  );
  const url = `${origin}/s/${space.id}`;

  // Bo can't edit the note, but can start a thread from the row's affordance.
  await bo.page.goto(url);
  await expect(row(bo.page, "copy").locator(".node-text")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await row(bo.page, "copy").hover();
  await row(bo.page, "copy")
    .getByRole("button", { name: "Add a comment" })
    .click();
  const boPanel = bo.page.locator('[data-comments-panel="copy"]');
  await boPanel
    .getByRole("textbox", { name: "Write a comment" })
    .fill("Can we shorten this?");
  await boPanel.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(boPanel.locator("[data-comment]")).toHaveCount(1);
  await expect(boPanel).toContainText("Can we shorten this?");
  await expect(boPanel.getByRole("button", { name: "Edit" })).toBeVisible();
  await bo.page.keyboard.press("Escape");
  await expect(row(bo.page, "copy").locator("[data-comment-badge]")).toHaveText(
    "1",
  );

  // Ann sees the badge, opens the thread, and resolves it.
  await ann.page.goto(url);
  const badge = row(ann.page, "copy").locator("[data-comment-badge]");
  await expect(badge).toHaveText("1");
  await badge.click();
  const annPanel = ann.page.locator('[data-comments-panel="copy"]');
  await expect(annPanel).toContainText("Bo");
  await expect(annPanel).toContainText("Can we shorten this?");
  // Admins can delete any comment, but only the author edits.
  await expect(annPanel.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await annPanel.getByRole("button", { name: "Resolve" }).click();
  await expect(annPanel).toContainText("Resolved.");
  await ann.page.keyboard.press("Escape");
  await expect(badge).toHaveAttribute("aria-label", /resolved/);

  // Cy reads the thread but has no way to comment, edit, or delete.
  await cy.page.goto(url);
  await row(cy.page, "copy").locator("[data-comment-badge]").click();
  const cyPanel = cy.page.locator('[data-comments-panel="copy"]');
  await expect(cyPanel).toContainText("Can we shorten this?");
  await expect(cyPanel).toContainText("You can read comments here");
  await expect(cyPanel.getByRole("textbox")).toHaveCount(0);
  await expect(cyPanel.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(cyPanel.getByRole("button", { name: "Resolve" })).toHaveCount(0);

  // Ann deletes the comment; the badge goes.
  await badge.click();
  await annPanel.getByRole("button", { name: "Delete" }).click();
  await expect(annPanel.locator("[data-comment]")).toHaveCount(0);
  await ann.page.keyboard.press("Escape");
  await expect(badge).toHaveCount(0);

  for (const a of [ann, bo, cy]) await a.context.close();
});
