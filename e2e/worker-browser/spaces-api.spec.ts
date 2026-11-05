import {
  expect,
  test,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from "@playwright/test";

import type { OutlineSnapshot } from "../../worker/backup";

import { createNode } from "../../src/data/tree";
import { startBackend } from "./backend";

// Shared spaces' server half (ADR 0079) against the real Worker, Durable
// Objects, D1, and auth: sharing a node, role checks on reads, writes, and the
// live sync socket, and revocation cutting that socket.

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
  return { context, userId: user.id };
}

// SAFETY: the routes these tests call answer with JSON of the requested shape.
const readJson = async <T>(response: APIResponse): Promise<T> =>
  (await response.json()) as T;

const send = (
  context: BrowserContext,
  method: string,
  path: string,
  data?: NonNullable<Parameters<BrowserContext["request"]["fetch"]>[1]>["data"],
) =>
  context.request.fetch(`${backend.origin}${path}`, {
    method,
    headers: { origin: backend.origin },
    data,
  });

test("share a node, grant, enforce roles on reads, writes, and sync, then revoke", async ({
  browser,
}) => {
  const ann = await account(browser, "ann@spaces.test", "Ann");
  const bo = await account(browser, "bo@spaces.test", "Bo");
  const stranger = await account(browser, "cy@spaces.test", "Cy");

  expect(
    (
      await send(ann.context, "POST", "/api/nodes", {
        nodes: [
          createNode({ id: "inbox", text: "Inbox" }),
          createNode({
            id: "plan",
            text: "Launch plan",
            prevSiblingId: "inbox",
          }),
          createNode({ id: "copy", parentId: "plan", text: "Write copy" }),
        ],
      })
    ).status(),
  ).toBe(200);

  // Ann shares "Launch plan".
  const shared = await send(ann.context, "POST", "/api/spaces", {
    nodeId: "plan",
  });
  expect(shared.status()).toBe(201);
  const {
    space,
    replaced,
  }: { space: { id: string; url: string }; replaced: boolean } =
    await shared.json();
  expect(replaced).toBe(true);

  // Her outline keeps the bullet, now a link; its children moved.
  const personal: OutlineSnapshot = await backend.control(
    "inspect",
    ann.userId,
  );
  expect(personal.nodes.find((n) => n.id === "plan")!.text).toBe(
    `[Launch plan](${space.url})`,
  );
  expect(personal.nodes.some((n) => n.id === "copy")).toBe(false);

  // The space holds the subtree, and only people with a role can read it.
  const nodesPath = `/api/spaces/${space.id}/nodes`;
  const annRead = await send(ann.context, "GET", nodesPath);
  expect(
    (await readJson<{ id: string }[]>(annRead)).map((n) => n.id).sort(),
  ).toEqual(["copy", "plan"]);
  expect((await send(bo.context, "GET", nodesPath)).status()).toBe(404);

  // A viewer reads but can't write.
  await send(ann.context, "PUT", `/api/spaces/${space.id}/grants`, {
    granteeType: "email",
    email: "bo@spaces.test",
    role: "viewer",
  });
  expect((await send(bo.context, "GET", nodesPath)).status()).toBe(200);
  const viewerWrite = await send(bo.context, "PATCH", nodesPath, {
    updates: [{ id: "copy", changes: { text: "Bo was here" } }],
  });
  expect(viewerWrite.status()).toBe(403);

  // An editor writes, and the owner sees it.
  await send(ann.context, "PUT", `/api/spaces/${space.id}/grants`, {
    granteeType: "email",
    email: "bo@spaces.test",
    role: "editor",
  });
  expect(
    (
      await send(bo.context, "PATCH", nodesPath, {
        updates: [{ id: "copy", changes: { text: "Write better copy" } }],
      })
    ).status(),
  ).toBe(200);
  const afterEdit = await readJson<{ id: string; text: string }[]>(
    await send(ann.context, "GET", nodesPath),
  );
  expect(afterEdit.find((n) => n.id === "copy")!.text).toBe(
    "Write better copy",
  );

  // The live socket: Bo connects and receives the snapshot...
  const page = await bo.context.newPage();
  await page.goto(`${backend.origin}/settings`);
  const syncUrl = `${backend.origin.replace("http", "ws")}/api/spaces/${space.id}/sync`;
  const handshake = await page.evaluate(
    (url) =>
      new Promise<{ type: string; ids: string[] }>((resolve, reject) => {
        const ws = new WebSocket(url);
        // SAFETY: a test-only slot on this page's window for the socket.
        (window as Window & { spaceSocket?: WebSocket }).spaceSocket = ws;
        ws.onopen = () =>
          ws.send(JSON.stringify({ type: "hello", since: null }));
        ws.onmessage = (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "snapshot")
            resolve({
              type: frame.type,
              ids: frame.nodes.map((n: { id: string }) => n.id).sort(),
            });
        };
        ws.onerror = () => reject(new Error("socket error"));
      }),
    syncUrl,
  );
  expect(handshake).toEqual({ type: "snapshot", ids: ["copy", "plan"] });

  // ...and revoking closes it; a reconnect is refused.
  const closed = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        // SAFETY: the handshake above stored this page's socket here.
        const ws = (window as Window & { spaceSocket?: WebSocket })
          .spaceSocket!;
        ws.onclose = (event) => resolve(event.code);
      }),
  );
  await send(ann.context, "DELETE", `/api/spaces/${space.id}/grants`, {
    granteeType: "email",
    granteeId: "bo@spaces.test",
  });
  expect(await closed).toBe(4001);
  expect((await send(bo.context, "GET", nodesPath)).status()).toBe(404);
  const reconnect = await page.evaluate(
    (url) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(url);
        ws.onopen = () => resolve("open");
        ws.onerror = () => resolve("refused");
      }),
    syncUrl,
  );
  expect(reconnect).toBe("refused");

  // Someone never granted gets nothing, including the space's existence.
  expect(
    (await send(stranger.context, "GET", `/api/spaces/${space.id}`)).status(),
  ).toBe(404);
  const listed = await readJson<{ spaces: unknown[] }>(
    await send(stranger.context, "GET", "/api/spaces"),
  );
  expect(listed.spaces).toEqual([]);

  for (const c of [ann, bo, stranger]) await c.context.close();
});
