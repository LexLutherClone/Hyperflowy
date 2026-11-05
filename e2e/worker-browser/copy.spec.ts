import {
  expect,
  test,
  type Browser,
  type BrowserContext,
} from "@playwright/test";

import type { OutlineSnapshot } from "../../worker/backup";

import { createNode } from "../../src/data/tree";
import { startBackend } from "./backend";

// Copy and move between your outline and a shared note (ADR 0083) against the
// real Worker, DOs, and D1.

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
  return { context, page: await context.newPage(), userId: user.id };
}

const texts = (snapshot: OutlineSnapshot) => snapshot.nodes.map((n) => n.text);
/** A DO's snapshot: a user's outline (their id) or a space (`space:<id>`). */
const inspect = async (name: string): Promise<OutlineSnapshot> =>
  backend.control("inspect", name);

test("copy with children unticked, move, and copy back out", async ({
  browser,
}) => {
  const { origin } = backend;
  const ann = await account(browser, "ann@copy.test", "Ann");
  const bo = await account(browser, "bo@copy.test", "Bo");
  await ann.context.request.post(`${origin}/api/nodes`, {
    headers: { origin },
    data: {
      nodes: [
        createNode({ id: "plan", text: "Launch plan" }),
        createNode({
          id: "secret",
          text: "Private salary note",
          prevSiblingId: "plan",
        }),
        createNode({ id: "ideas", text: "Ideas", prevSiblingId: "secret" }),
        createNode({ id: "i1", parentId: "ideas", text: "Podcast" }),
        createNode({
          id: "i2",
          parentId: "ideas",
          prevSiblingId: "i1",
          text: "Not this one",
        }),
        createNode({
          id: "i3",
          parentId: "ideas",
          prevSiblingId: "i2",
          text: "Private salary note",
          mirrorOf: "secret",
        }),
        createNode({ id: "todo", text: "Errands", prevSiblingId: "ideas" }),
        createNode({ id: "t1", parentId: "todo", text: "Buy stamps" }),
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
    data: { granteeType: "email", email: "bo@copy.test", role: "viewer" },
  });
  const spaceDo = `space:${space.id}`;

  // Ann copies "Ideas" into the shared note, leaving one branch out.
  await ann.page.goto(`${origin}/ideas`);
  await ann.page.getByRole("button", { name: "View options" }).click();
  await ann.page
    .getByRole("menuitem", { name: "Copy or move to a shared note…" })
    .click();
  const dialog = ann.page.getByRole("dialog");
  await expect(
    dialog.getByRole("combobox", { name: "Shared note" }),
  ).toHaveValue(space.id);
  await dialog
    .getByRole("checkbox", { name: "Bring along Not this one" })
    .click();
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(
    ann.page.getByText(/Copied 3 bullets to Launch plan/),
  ).toBeVisible();

  const afterCopy = await inspect(spaceDo);
  expect(texts(afterCopy)).toEqual(
    expect.arrayContaining(["Ideas", "Podcast", "Private salary note"]),
  );
  expect(texts(afterCopy)).not.toContain("Not this one");
  // The mirror arrived as a plain bullet: nothing links back to Ann's outline.
  expect(afterCopy.nodes.every((n) => n.mirrorOf === null)).toBe(true);
  // A copy leaves the original in place.
  const annOutline = await inspect(ann.userId);
  expect(texts(annOutline)).toContain("Not this one");

  // Ann moves "Errands" in: it leaves her outline.
  await ann.page.goto(`${origin}/todo`);
  await ann.page.getByRole("button", { name: "View options" }).click();
  await ann.page
    .getByRole("menuitem", { name: "Copy or move to a shared note…" })
    .click();
  await dialog.getByRole("radio", { name: /Move/ }).check();
  await expect(dialog.getByText("Moving takes “Errands”")).toBeVisible();
  await dialog.getByRole("button", { name: "Move", exact: true }).click();
  await expect(
    ann.page.getByText(/Moved 2 bullets to Launch plan/),
  ).toBeVisible();
  const afterMove = await inspect(ann.userId);
  expect(texts(afterMove)).not.toContain("Errands");
  expect(texts(afterMove)).not.toContain("Buy stamps");
  expect(texts(await inspect(spaceDo))).toEqual(
    expect.arrayContaining(["Errands", "Buy stamps"]),
  );

  // Bo can only view the note, but can copy from it into his own outline.
  const podcast = afterCopy.nodes.find((n) => n.text === "Podcast")!;
  await bo.page.goto(`${origin}/s/${space.id}/${podcast.id}`);
  await bo.page.getByRole("button", { name: "View options" }).click();
  await bo.page.getByRole("menuitem", { name: "Copy to my outline…" }).click();
  await bo.page
    .getByRole("dialog")
    .getByRole("button", { name: "Copy", exact: true })
    .click();
  await expect(
    bo.page.getByText(/Copied 1 bullet to your outline/),
  ).toBeVisible();
  expect(texts(await inspect(bo.userId))).toContain("Podcast");

  await ann.context.close();
  await bo.context.close();
});
