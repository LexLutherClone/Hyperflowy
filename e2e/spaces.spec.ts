import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Shared-note pages (ADR 0079) with the outline mocked: the gate, the banner,
// view-only editing, staying inside the space when zooming, and the Share
// dialog. The real Worker path is e2e/worker-browser/spaces-*.spec.ts.

const TREE: SeedNode[] = [
  { id: "plan", parentId: null, prevSiblingId: null, text: "Launch plan" },
  { id: "copy", parentId: "plan", prevSiblingId: null, text: "Write copy" },
  { id: "ads", parentId: "plan", prevSiblingId: "copy", text: "Buy ads" },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function openSpace(
  page: Page,
  role: "viewer" | "editor" | "admin" | null,
  path = "/s/sp1",
) {
  await seedOutline(page, TREE);
  await page.route(
    (url) => url.pathname === "/api/spaces/sp1",
    (route) =>
      role === null
        ? route.fulfill({ status: 404, json: { error: "not_found" } })
        : route.fulfill({
            json: {
              space: { id: "sp1", name: "Launch plan", ownerId: "ann" },
              role,
              grants:
                role === "admin"
                  ? [
                      {
                        granteeType: "email",
                        granteeId: "bo@example.com",
                        role: "editor",
                        label: "bo@example.com",
                      },
                    ]
                  : [],
            },
          }),
  );
  await page.route(
    (url) => url.pathname === "/api/workspaces",
    (route) => route.fulfill({ json: { workspaces: [], invites: [] } }),
  );
  await page.goto(path);
}

test("an editor's space: banner, rows editable, zoom stays inside the space", async ({
  page,
}) => {
  await openSpace(page, "editor");
  const banner = page.getByRole("region", { name: "Shared note" });
  await expect(banner).toContainText("Launch plan");
  await expect(banner).toContainText("Can edit");
  await expect(banner.getByRole("button", { name: "Share" })).toHaveCount(0);
  await expect(text(page, "copy")).toHaveAttribute("contenteditable", "true");

  await page.locator('li[data-node-id="copy"] .bullet').first().click();
  await expect(page).toHaveURL(/\/s\/sp1\/copy$/);
});

test("a viewer's space is read-only", async ({ page }) => {
  await openSpace(page, "viewer");
  await expect(page.getByRole("region", { name: "Shared note" })).toContainText(
    "view only",
  );
  await expect(text(page, "copy")).toHaveAttribute("contenteditable", "false");
  // The role makes it read-only, not an owner lock: no padlock on every row.
  await expect(page.getByLabel("Locked subtree")).toHaveCount(0);
});

test("a space you can't reach says so and offers a way back", async ({
  page,
}) => {
  await openSpace(page, null);
  await expect(
    page.getByText("This shared note isn't available"),
  ).toBeVisible();
  await expect(text(page, "copy")).toHaveCount(0);
});

test("deep links into a space open the zoomed node", async ({ page }) => {
  await openSpace(page, "editor", "/s/sp1/ads");
  await expect(page.locator("h2").first()).toContainText("Buy ads");
});

test("an admin's Share dialog lists access and opens from the banner", async ({
  page,
}) => {
  await openSpace(page, "admin", "/s/sp1?share=1");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Share Launch plan")).toBeVisible();
  await expect(dialog.locator('[data-grant="bo@example.com"]')).toContainText(
    "bo@example.com",
  );
  await expect(
    dialog.getByRole("combobox", { name: "Role for bo@example.com" }),
  ).toHaveValue("editor");
  await page.keyboard.press("Escape");
  await page
    .getByRole("region", { name: "Shared note" })
    .getByRole("button", { name: "Share" })
    .click();
  await expect(dialog).toBeVisible();
});

test("sharing a page from your outline opens the new space", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  let posted: { nodeId: string } | null = null;
  await page.route(
    (url) => url.pathname === "/api/spaces",
    async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        json: {
          space: { id: "sp9", name: "Launch plan", url: "/s/sp9" },
          replaced: true,
        },
      });
    },
  );
  await page.goto("/plan");
  await expect(text(page, "copy")).toBeVisible();
  await page.getByRole("button", { name: "View options" }).click();
  await page.getByRole("menuitem", { name: "Share this page…" }).click();
  await expect(page).toHaveURL(/\/s\/sp9\?share=1$/);
  expect(posted).toEqual({ nodeId: "plan" });
});
