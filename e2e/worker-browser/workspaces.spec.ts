import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { startBackend } from "./backend";

// Workspaces, invitations, and groups (ADR 0078) through the real Settings UI,
// Worker, D1, and auth, with two separate accounts in separate browsers.

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
  const signIn = await context.request.post(
    `${origin}/api/auth/sign-in/email`,
    { headers: { origin }, data: { email, password } },
  );
  expect(signIn.status()).toBe(200);
  const page = await context.newPage();
  await page.goto(`${origin}/settings`);
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  return { context, page };
}

test("create a workspace, invite someone, they join, groups and leaving work", async ({
  browser,
}) => {
  const ann = await account(browser, "ann@worker-browser.test", "Ann");
  const bo = await account(browser, "bo@worker-browser.test", "Bo");

  // Ann creates "Design" and lands in its dialog.
  await ann.page.getByRole("button", { name: "New workspace" }).click();
  await ann.page
    .getByRole("textbox", { name: "Workspace name" })
    .fill("Design");
  await ann.page.getByRole("button", { name: "Create" }).click();
  const annDialog = ann.page.getByRole("dialog");
  await expect(
    annDialog.getByRole("heading", { name: "Design" }),
  ).toBeVisible();

  // She invites Bo by email, as a member.
  await annDialog
    .getByRole("textbox", { name: "Email to invite" })
    .fill("Bo@Worker-Browser.test");
  await annDialog.getByRole("button", { name: "Invite" }).click();
  await expect(annDialog.getByText("bo@worker-browser.test")).toBeVisible();

  // Bo sees the invitation in his Settings and joins.
  await bo.page.reload();
  await expect(bo.page.getByText("Join Design")).toBeVisible();
  await expect(bo.page.getByText("Ann invited you as member.")).toBeVisible();
  await bo.page.getByRole("button", { name: "Join" }).click();
  await expect(bo.page.getByText("Member · 2 people")).toBeVisible();

  // Ann now sees Bo, makes a group, and puts Bo in it.
  await ann.page.keyboard.press("Escape");
  await ann.page.reload();
  await ann.page.getByRole("button", { name: "Manage Design" }).click();
  await expect(annDialog.getByText("Bo", { exact: true })).toBeVisible();
  await expect(annDialog.getByText("Pending invitations")).toHaveCount(0);
  await annDialog
    .getByRole("textbox", { name: "New group name" })
    .fill("Leads");
  await annDialog.getByRole("button", { name: "Add group" }).click();
  const leads = annDialog.locator("[data-group]", { hasText: "Leads" });
  await leads.getByRole("checkbox").nth(1).click(); // Ann, then Bo
  await expect(leads.getByRole("checkbox").nth(1)).toBeChecked();

  // Bo, a member, sees the group read-only and no management controls.
  await bo.page.getByRole("button", { name: "Manage Design" }).click();
  const boDialog = bo.page.getByRole("dialog");
  await expect(boDialog.getByText("You're a member.")).toBeVisible();
  await expect(boDialog.locator("[data-group]")).toContainText("Bo");
  await expect(boDialog.getByText("Invite someone")).toHaveCount(0);
  await expect(boDialog.getByRole("checkbox")).toHaveCount(0);

  // Ann promotes Bo to admin; Bo's next look shows management controls.
  await annDialog
    .getByRole("combobox", { name: "Role for Bo" })
    .selectOption("admin");
  await expect(
    annDialog.getByRole("combobox", { name: "Role for Bo" }),
  ).toHaveValue("admin");
  await bo.page.keyboard.press("Escape");
  await bo.page.getByRole("button", { name: "Manage Design" }).click();
  await expect(boDialog.getByText("You're an admin.")).toBeVisible();
  await expect(boDialog.getByText("Invite someone")).toBeVisible();

  // Bo leaves; Design disappears from his list and he's gone from Ann's.
  await boDialog.getByRole("button", { name: "Leave workspace" }).click();
  await expect(
    bo.page.getByText("You're not in any workspace yet"),
  ).toBeVisible();
  await ann.page.keyboard.press("Escape");
  await ann.page.reload();
  await expect(ann.page.getByText("Owner · 1 person")).toBeVisible();

  await ann.context.close();
  await bo.context.close();
});
