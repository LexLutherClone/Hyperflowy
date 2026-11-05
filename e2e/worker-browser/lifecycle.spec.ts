import {
  expect,
  test,
  type Browser,
  type BrowserContext,
} from "@playwright/test";

import type { OutlineSnapshot } from "../../worker/backup";

import { createNode } from "../../src/data/tree";
import { startBackend } from "./backend";

// Ending a share (ADR 0084): leaving, and the owner stopping sharing, against
// the real Worker, DOs, and D1.

let backend: Awaited<ReturnType<typeof startBackend>>;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  backend = await startBackend();
});
test.afterAll(async () => {
  await backend?.dispose();
});

async function account(browser: Browser, email: string, name: string) {
  const { origin } = backend;
  const context: BrowserContext = await browser.newContext({ baseURL: origin });
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
  const page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  return { context, page, userId: user.id };
}

const inspect = async (name: string): Promise<OutlineSnapshot> =>
  backend.control("inspect", name);

test("a collaborator leaves; the owner stops sharing and gets the note back", async ({
  browser,
}) => {
  const { origin } = backend;
  const ann = await account(browser, "ann@lifecycle.test", "Ann");
  const bo = await account(browser, "bo@lifecycle.test", "Bo");
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
  const shared = await ann.context.request.post(`${origin}/api/spaces`, {
    headers: { origin },
    data: { nodeId: "plan" },
  });
  const { space }: { space: { id: string } } = await shared.json();
  await ann.context.request.put(`${origin}/api/spaces/${space.id}/grants`, {
    headers: { origin },
    data: { granteeType: "email", email: "bo@lifecycle.test", role: "editor" },
  });
  const url = `${origin}/s/${space.id}`;

  // Bo adds a bullet, then leaves.
  await bo.page.goto(url);
  const banner = bo.page.getByRole("region", { name: "Shared note" });
  await expect(banner).toContainText("Can edit");
  await bo.context.request.post(`${origin}/api/spaces/${space.id}/nodes`, {
    headers: { origin },
    data: {
      nodes: [
        createNode({
          id: "bos",
          parentId: "plan",
          prevSiblingId: "copy",
          text: "Bo's idea",
        }),
      ],
    },
  });
  await banner.getByRole("button", { name: "Leave" }).click();
  await expect(bo.page).toHaveURL(`${origin}/`);
  await bo.page.goto(url);
  await expect(
    bo.page.getByText("This shared note isn't available"),
  ).toBeVisible();

  // Ann stops sharing: the note returns into her bullet, with Bo's addition.
  await ann.page.goto(`${url}?share=1`);
  const dialog = ann.page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Stop sharing…" }).click();
  await dialog
    .getByRole("button", { name: "Stop sharing", exact: true })
    .click();
  await expect(ann.page).toHaveURL(`${origin}/`);
  const outline = await inspect(ann.userId);
  const plan = outline.nodes.find((n) => n.id === "plan")!;
  expect(plan.text).toBe("Launch plan");
  expect(plan.prevSiblingId).toBe("inbox");
  expect(
    outline.nodes
      .filter((n) => n.parentId === "plan")
      .map((n) => n.text)
      .sort(),
  ).toEqual(["Bo's idea", "Write copy"]);

  // The space is gone: unreachable, and its storage wiped.
  expect(
    (
      await ann.context.request.get(`${origin}/api/spaces/${space.id}`)
    ).status(),
  ).toBe(404);
  // wipe() deletes all storage: the live object either has no tables left to
  // read (the export fails) or, once restarted, an empty outline.
  const leftover = await inspect(`space:${space.id}`).catch(() => null);
  expect(leftover?.nodes ?? []).toEqual([]);

  await ann.context.close();
  await bo.context.close();
});
