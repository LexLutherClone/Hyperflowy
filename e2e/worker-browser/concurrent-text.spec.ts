import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import type { OutlineSnapshot } from "../../worker/backup";

import { createNode } from "../../src/data/tree";
import { placeCaret } from "../fixtures";
import { startBackend } from "./backend";

// Concurrent text merge (ADR 0077) against the real Worker, Durable Object, and
// auth. Two tabs of one account stand in for two people: the race is the same,
// two writers editing one node's text while neither has seen the other's edit.

let backend: Awaited<ReturnType<typeof startBackend>>;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  backend = await startBackend();
});
test.afterAll(async () => {
  await backend?.dispose();
});

const editor = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function signUp(context: BrowserContext, email: string) {
  const { origin } = backend;
  const password = "disposable-browser-password";
  const signup = await context.request.post(
    `${origin}/api/auth/sign-up/email`,
    { headers: { origin }, data: { email, name: "Merge test", password } },
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
  return user.id;
}

test("two writers editing one bullet both keep their edits", async ({
  page,
  context,
}) => {
  const { origin } = backend;
  const userId = await signUp(context, "merge@worker-browser.test");
  const seeded = await context.request.post(`${origin}/api/nodes`, {
    data: {
      nodes: [
        createNode({ id: "a", text: "Draft spec" }),
        createNode({ id: "b", text: "Elsewhere", prevSiblingId: "a" }),
      ],
    },
  });
  expect(seeded.status()).toBe(200);
  const inspect = async (): Promise<OutlineSnapshot> =>
    backend.control("inspect", userId);
  const stored = async (id: string) =>
    (await inspect()).nodes.find((n) => n.id === id)?.text;

  await page.goto(origin);
  await expect(editor(page, "a")).toHaveText("Draft spec");
  const peer = await context.newPage();
  await peer.goto(origin);
  await expect(editor(peer, "a")).toHaveText("Draft spec");

  // The writer starts editing at the end and keeps the bullet focused.
  await placeCaret(editor(page, "a"), "Draft spec".length);
  await page.keyboard.type(" v");
  await expect.poll(() => stored("a")).toBe("Draft spec v");

  // Meanwhile the peer prefixes the same bullet and leaves it.
  await placeCaret(editor(peer, "a"), 0);
  await peer.keyboard.type("TODO ");
  await editor(peer, "b").click();
  await expect.poll(() => stored("a")).toBe("TODO Draft spec v");

  // The writer, still focused and not yet showing the peer's edit, keeps
  // typing. Before ADR 0077 this write replaced the text and erased "TODO ".
  await page.keyboard.type("2");
  await expect.poll(() => stored("a")).toBe("TODO Draft spec v2");

  // Both screens converge once the writer leaves the bullet.
  await editor(page, "b").click();
  await expect(editor(page, "a")).toHaveText("TODO Draft spec v2");
  await expect(editor(peer, "a")).toHaveText("TODO Draft spec v2");

  // And a later, unrelated edit from the converged state is a plain write.
  await placeCaret(editor(peer, "a"), "TODO Draft spec v2".length);
  await peer.keyboard.type("!");
  await expect.poll(() => stored("a")).toBe("TODO Draft spec v2!");
  await expect(editor(page, "a")).toHaveText("TODO Draft spec v2!");
});
