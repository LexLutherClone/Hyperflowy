import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { createNode } from "../../src/data/tree";
import { startBackend } from "./backend";

// Shared spaces through the app (ADR 0079): share a page from the View menu,
// grant a person in the Share dialog, open it from their Settings, edit it
// live, then downgrade and revoke, all against the real Worker, DOs, and D1.

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
    {
      headers: { origin },
      data: { email, name, password },
    },
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

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

test("share a page, collaborate live, downgrade, and revoke", async ({
  browser,
}) => {
  const { origin } = backend;
  const ann = await account(browser, "ann@spaces-ui.test", "Ann");
  const bo = await account(browser, "bo@spaces-ui.test", "Bo");
  await ann.context.request.post(`${origin}/api/nodes`, {
    headers: { origin },
    data: {
      nodes: [
        createNode({ id: "inbox", text: "Inbox" }),
        createNode({ id: "plan", text: "Launch plan", prevSiblingId: "inbox" }),
        createNode({ id: "copy", parentId: "plan", text: "Write copy" }),
      ],
    },
  });

  // Ann zooms into "Launch plan" and shares it from the View menu.
  await ann.page.goto(`${origin}/plan`);
  await expect(text(ann.page, "copy")).toHaveText("Write copy");
  await ann.page.getByRole("button", { name: "View options" }).click();
  await ann.page.getByRole("menuitem", { name: "Share this page…" }).click();

  // She lands in the space, with the Share dialog open.
  await expect(ann.page).toHaveURL(/\/s\/[^/?]+\?share=1$/);
  const spaceUrl = ann.page.url().replace(/\?share=1$/, "");
  const dialog = ann.page.getByRole("dialog");
  await expect(dialog.getByText("Share Launch plan")).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Email to share with" })
    .fill("bo@spaces-ui.test");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(
    dialog.locator('[data-grant="bo@spaces-ui.test"]'),
  ).toBeVisible();
  await ann.page.keyboard.press("Escape");
  await expect(
    ann.page.getByRole("region", { name: "Shared note" }),
  ).toContainText("Launch plan");
  await expect(text(ann.page, "copy")).toHaveText("Write copy");

  // Bo finds it in Settings and opens it, able to edit.
  await bo.page.goto(`${origin}/settings`);
  await bo.page.locator('a[aria-label="Open Launch plan"]').click();
  await expect(bo.page).toHaveURL(spaceUrl);
  await expect(
    bo.page.getByRole("region", { name: "Shared note" }),
  ).toContainText("Can edit");
  await text(bo.page, "copy").click();
  await bo.page.keyboard.press("End");
  await bo.page.keyboard.type(" today");

  // Ann sees Bo's edit live.
  await expect(text(ann.page, "copy")).toHaveText("Write copy today");

  // Zooming stays inside the space.
  await ann.page.goto(`${spaceUrl}/copy`);
  await expect(ann.page.locator(".zoomed-title, h2").first()).toContainText(
    "Write copy today",
  );
  await ann.page.goto(`${spaceUrl}?share=1`);

  // Ann makes Bo view-only: after a reload Bo can't type.
  await dialog
    .getByRole("combobox", { name: "Role for bo@spaces-ui.test" })
    .selectOption("viewer");
  await expect(
    dialog.getByRole("combobox", { name: "Role for bo@spaces-ui.test" }),
  ).toHaveValue("viewer");
  await bo.page.reload();
  await expect(
    bo.page.getByRole("region", { name: "Shared note" }),
  ).toContainText("view only");
  await expect(text(bo.page, "copy")).toHaveAttribute(
    "contenteditable",
    "false",
  );

  // Ann removes Bo: his next load says it isn't available.
  await dialog
    .getByRole("button", { name: "Remove bo@spaces-ui.test" })
    .click();
  await expect(dialog.locator('[data-grant="bo@spaces-ui.test"]')).toHaveCount(
    0,
  );
  await bo.page.reload();
  await expect(
    bo.page.getByText("This shared note isn't available"),
  ).toBeVisible();

  // Ann's own outline kept the bullet, now a link to the space.
  await ann.page.goto(`${origin}/`);
  await expect(text(ann.page, "plan")).toContainText("Launch plan");
  await expect(text(ann.page, "copy")).toHaveCount(0);

  await ann.context.close();
  await bo.context.close();
});
