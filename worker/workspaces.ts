/// <reference types="@cloudflare/workers-types" />

import { Data, Effect, Schema } from "effect";

import {
  canChangeRole,
  canDelete,
  canInvite,
  canManage,
  canRemove,
  cleanName,
  GROUP_NAME_MAX,
  WORKSPACE_NAME_MAX,
} from "../src/data/workspace-policy";
import * as store from "./workspaces-store";

/**
 * `/api/workspaces` and `/api/workspace-invites` (ADR 0078): team workspaces,
 * their members and invitations, and named groups. Membership and roles live
 * in D1 (migration 0015); `workspace-policy.ts` decides every write.
 *
 * - Reads need a member. A workspace you aren't in is a 404, never a 403, so
 *   its existence doesn't leak.
 * - Writes need a same-origin request (the capture-keys rule) and pass the
 *   per-user rate limit.
 * - Invitations bind to an email address and are listed and accepted only by
 *   an account whose VERIFIED email matches. Inviting never reveals whether an
 *   account exists.
 */

interface WorkspacesEnv {
  DB: D1Database;
  WORKSPACE_LIMIT: RateLimit;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
}

export interface WorkspaceActor {
  /** The Better Auth user id (stable; never the DO-routing id). */
  userId: string;
  /** The account email, only when verified. */
  verifiedEmail: string | null;
}

class WorkspaceHttpError extends Data.TaggedError("WorkspaceHttpError")<{
  status: number;
  error: string;
  message: string;
}> {}

const fail = (status: number, error: string, message: string) =>
  new WorkspaceHttpError({ status, error, message });
const notFound = () =>
  fail(404, "not_found", "That workspace doesn't exist or you're not in it.");
const forbidden = (message: string) => fail(403, "forbidden", message);

function json<T>(value: T, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

const Grantable = Schema.Literals(["admin", "member"]);
const NameBody = Schema.Struct({ name: Schema.String });
const InviteBody = Schema.Struct({ email: Schema.String, role: Grantable });
const RoleBody = Schema.Struct({ role: Grantable });
const GroupMembersBody = Schema.Struct({
  userIds: Schema.Array(Schema.String),
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY = 16_384;
const MAX_GROUP_MEMBERS = 1000;

const decodeBody = <S extends Schema.Top>(request: Request, schema: S) =>
  Effect.gen(function* () {
    if (
      !/^application\/json(?:;|$)/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      return yield* Effect.fail(
        fail(415, "invalid_content_type", "Send JSON."),
      );
    const text = yield* Effect.tryPromise({
      try: async () => {
        const reader = request.body?.getReader();
        if (!reader) return "";
        let length = 0;
        let text = "";
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_BODY)
              throw fail(413, "input_too_large", "The request is too large.");
            text += decoder.decode(value, { stream: true });
          }
          return text + decoder.decode();
        } finally {
          await reader.cancel();
        }
      },
      catch: (error) =>
        error instanceof WorkspaceHttpError
          ? error
          : fail(400, "invalid_body", "Couldn't read the request."),
    });
    const raw = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: () => fail(400, "invalid_body", "Send a valid JSON body."),
    });
    return yield* Schema.decodeUnknownEffect(schema, {
      onExcessProperty: "error",
    })(raw).pipe(
      Effect.mapError(() =>
        fail(400, "invalid_input", "Check the request and try again."),
      ),
    );
  });

const name = (raw: string, max: number, what: string) =>
  Effect.gen(function* () {
    const clean = cleanName(raw, max);
    if (clean === null)
      return yield* Effect.fail(
        fail(
          400,
          "invalid_name",
          `Give the ${what} a name of up to ${max} characters.`,
        ),
      );
    return clean;
  });

function sameOrigin(request: Request, env: WorkspacesEnv): boolean {
  const origins = new Set([
    new URL(request.url).origin,
    ...(env.BETTER_AUTH_URL ? [new URL(env.BETTER_AUTH_URL).origin] : []),
    ...(env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",").map((o) => o.trim()) ?? []),
  ]);
  return origins.has(request.headers.get("origin") ?? "");
}

/** `/api/workspaces/...` and `/api/workspace-invites/...` path segments. */
function segments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .slice(1)
    .map((s) => decodeURIComponent(s));
}

export const handleWorkspaces = Effect.fn("Workspaces.handle")(
  (request: Request, env: WorkspacesEnv, actor: WorkspaceActor) =>
    Effect.gen(function* () {
      const method = request.method;
      const db = env.DB;
      const now = Date.now();
      const [root, workspaceId, sub, subId, leaf] = segments(
        new URL(request.url).pathname,
      );

      if (method !== "GET") {
        if (!sameOrigin(request, env))
          return yield* Effect.fail(
            fail(
              403,
              "invalid_origin",
              "Open Settings on this server to manage workspaces.",
            ),
          );
        const { success } = yield* Effect.promise(() =>
          env.WORKSPACE_LIMIT.limit({ key: actor.userId }),
        );
        if (!success)
          return yield* Effect.fail(
            fail(
              429,
              "rate_limited",
              "Too many changes. Wait a minute, then retry.",
            ),
          );
      }

      // --- Invitations addressed to me -------------------------------------
      if (root === "workspace-invites") {
        const action = sub;
        if (method !== "POST" || !workspaceId || subId !== undefined)
          return json({ error: "not_found" }, 404);
        if (!actor.verifiedEmail)
          return yield* Effect.fail(
            forbidden("Verify your email before joining a workspace."),
          );
        const inviteId = workspaceId;
        if (action === "accept") {
          const joined = yield* Effect.promise(() =>
            store.acceptInvite(
              db,
              inviteId,
              actor.userId,
              actor.verifiedEmail!,
              now,
            ),
          );
          if (!joined)
            return yield* Effect.fail(
              fail(404, "not_found", "That invitation is no longer open."),
            );
          return json({ workspaceId: joined });
        }
        if (action === "decline") {
          yield* Effect.promise(() =>
            store.declineInvite(db, inviteId, actor.verifiedEmail!),
          );
          return json({ declined: true });
        }
        return json({ error: "not_found" }, 404);
      }

      // --- The collection ------------------------------------------------
      if (!workspaceId) {
        if (method === "GET")
          return json(
            yield* Effect.promise(() =>
              store.listWorkspaces(db, actor.userId, actor.verifiedEmail),
            ),
          );
        if (method === "POST") {
          const input = yield* decodeBody(request, NameBody);
          const clean = yield* name(
            input.name,
            WORKSPACE_NAME_MAX,
            "workspace",
          );
          return json(
            {
              workspace: yield* Effect.promise(() =>
                store.createWorkspace(db, actor.userId, clean, now),
              ),
            },
            201,
          );
        }
        return json({ error: "method_not_allowed" }, 405);
      }

      // Everything below is inside one workspace: members only.
      const role = yield* Effect.promise(() =>
        store.roleOf(db, workspaceId, actor.userId),
      );
      if (role === null) return yield* Effect.fail(notFound());

      if (sub === undefined) {
        if (method === "GET") {
          const detail = yield* Effect.promise(() =>
            store.getWorkspaceDetail(db, workspaceId, role, canManage(role)),
          );
          if (!detail) return yield* Effect.fail(notFound());
          return json(detail);
        }
        if (method === "PATCH") {
          if (!canManage(role))
            return yield* Effect.fail(
              forbidden("Only admins can rename the workspace."),
            );
          const input = yield* decodeBody(request, NameBody);
          const clean = yield* name(
            input.name,
            WORKSPACE_NAME_MAX,
            "workspace",
          );
          yield* Effect.promise(() =>
            store.renameWorkspace(db, workspaceId, clean),
          );
          return json({ name: clean });
        }
        if (method === "DELETE") {
          if (!canDelete(role))
            return yield* Effect.fail(
              forbidden("Only the owner can delete the workspace."),
            );
          yield* Effect.promise(() => store.deleteWorkspace(db, workspaceId));
          return json({ deleted: true });
        }
        return json({ error: "method_not_allowed" }, 405);
      }

      if (sub === "invites") {
        if (method === "POST" && subId === undefined) {
          const input = yield* decodeBody(request, InviteBody);
          const email = input.email.trim();
          if (email.length > 254 || !EMAIL.test(email))
            return yield* Effect.fail(
              fail(400, "invalid_email", "Enter a valid email address."),
            );
          if (!canInvite(role, input.role))
            return yield* Effect.fail(
              forbidden(
                `You can't invite people as ${input.role === "admin" ? "an admin" : "a member"}.`,
              ),
            );
          const invite = yield* Effect.promise(() =>
            store.inviteToWorkspace(
              db,
              workspaceId,
              email,
              input.role,
              actor.userId,
              now,
            ),
          );
          return json({ invite }, 201);
        }
        if (method === "DELETE" && subId !== undefined) {
          if (!canManage(role))
            return yield* Effect.fail(
              forbidden("Only admins can revoke invitations."),
            );
          yield* Effect.promise(() =>
            store.revokeInvite(db, workspaceId, subId),
          );
          return json({ revoked: true });
        }
        return json({ error: "method_not_allowed" }, 405);
      }

      if (sub === "members" && subId !== undefined && leaf === undefined) {
        const target = yield* Effect.promise(() =>
          store.roleOf(db, workspaceId, subId),
        );
        if (target === null)
          return yield* Effect.fail(
            fail(404, "not_found", "That person isn't in this workspace."),
          );
        if (method === "PATCH") {
          const input = yield* decodeBody(request, RoleBody);
          if (!canChangeRole(role, target, input.role))
            return yield* Effect.fail(
              forbidden("You can't change that person's role."),
            );
          yield* Effect.promise(() =>
            store.setMemberRole(db, workspaceId, subId, input.role),
          );
          return json({ role: input.role });
        }
        if (method === "DELETE") {
          const self = subId === actor.userId;
          if (!canRemove(role, target, self))
            return yield* Effect.fail(
              forbidden(
                self
                  ? "The owner can't leave. Delete the workspace instead."
                  : "You can't remove that person.",
              ),
            );
          yield* Effect.promise(() =>
            store.removeMember(db, workspaceId, subId),
          );
          return json({ removed: true });
        }
        return json({ error: "method_not_allowed" }, 405);
      }

      if (sub === "groups") {
        if (!canManage(role) && method !== "GET")
          return yield* Effect.fail(
            forbidden("Only admins can manage groups."),
          );
        if (method === "POST" && subId === undefined) {
          const input = yield* decodeBody(request, NameBody);
          const clean = yield* name(input.name, GROUP_NAME_MAX, "group");
          return json(
            {
              group: yield* Effect.promise(() =>
                store.createGroup(db, workspaceId, clean, now),
              ),
            },
            201,
          );
        }
        if (subId !== undefined && leaf === undefined) {
          if (method === "PATCH") {
            const input = yield* decodeBody(request, NameBody);
            const clean = yield* name(input.name, GROUP_NAME_MAX, "group");
            const ok = yield* Effect.promise(() =>
              store.renameGroup(db, workspaceId, subId, clean),
            );
            if (!ok)
              return yield* Effect.fail(
                fail(404, "not_found", "That group doesn't exist."),
              );
            return json({ name: clean });
          }
          if (method === "DELETE") {
            yield* Effect.promise(() =>
              store.deleteGroup(db, workspaceId, subId),
            );
            return json({ deleted: true });
          }
        }
        if (subId !== undefined && leaf === "members" && method === "PUT") {
          const input = yield* decodeBody(request, GroupMembersBody);
          if (input.userIds.length > MAX_GROUP_MEMBERS)
            return yield* Effect.fail(
              fail(400, "too_many", "That group is too large."),
            );
          const ok = yield* Effect.promise(() =>
            store.setGroupMembers(db, workspaceId, subId, input.userIds),
          );
          if (!ok)
            return yield* Effect.fail(
              fail(404, "not_found", "That group doesn't exist."),
            );
          return json({ updated: true });
        }
        return json({ error: "method_not_allowed" }, 405);
      }

      return json({ error: "not_found" }, 404);
    }).pipe(
      Effect.catchTag("WorkspaceHttpError", (error) =>
        Effect.succeed(
          json({ error: error.error, message: error.message }, error.status),
        ),
      ),
    ),
);
