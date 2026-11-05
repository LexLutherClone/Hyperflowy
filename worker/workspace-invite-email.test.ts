import { expect, test } from "bun:test";
import { Effect } from "effect";

import { sqliteD1 } from "./testing/d1-sqlite";
import { handleWorkspaces } from "./workspaces";

const ORIGIN = "https://app.example";

test("a new workspace invitation emails the address once (ADR 0082)", async () => {
  const env = sqliteD1([
    "migrations/0015_create_workspaces.sql",
    "migrations/0016_create_spaces.sql",
  ]);
  env.sqlite.exec(
    `CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER)`,
  );
  const sent: { to: string; subject: string; text: string }[] = [];
  const deferred: Promise<unknown>[] = [];
  // SAFETY: the fake implements `send`, the only method sendEmail calls.
  const EMAIL = Object.assign({} as SendEmail, {
    send: async (m: { to: string; subject: string; text: string }) => {
      sent.push({ to: m.to, subject: m.subject, text: m.text });
    },
  });
  const call = (method: string, path: string, input: Record<string, string>) =>
    Effect.runPromise(
      handleWorkspaces(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
        {
          DB: env.db,
          EMAIL,
          WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
        },
        {
          userId: "ann",
          verifiedEmail: "ann@example.com",
          name: "Ann",
          defer: (work) => deferred.push(work),
        },
      ),
    );
  const created = await call("POST", "/api/workspaces", { name: "Design" });
  const { workspace }: { workspace: { id: string } } = await created.json();
  const invite = { email: "bo@example.com", role: "member" };
  await call("POST", `/api/workspaces/${workspace.id}/invites`, invite);
  await call("POST", `/api/workspaces/${workspace.id}/invites`, {
    ...invite,
    role: "admin",
  });
  await Promise.all(deferred);
  expect(sent.map((m) => [m.to, m.subject])).toEqual([
    ["bo@example.com", "Ann invited you to Design"],
  ]);
  expect(sent[0]!.text).toContain(`${ORIGIN}/settings`);
});
