/// <reference types="@cloudflare/workers-types" />

import { Effect, Schema } from "effect";

import type { ChangeOp, Node } from "../src/data/wire-schema";
import type { UserOutlineDO } from "./outline-do";

import { flattenInline } from "../src/data/inline-text";
import {
  canEdit,
  canRead,
  canShare,
  SPACE_NAME_MAX,
  SPACE_ROLES,
} from "../src/data/space-policy";
import { cleanName } from "../src/data/workspace-policy";
import {
  decodeBody,
  EMAIL,
  fail,
  json,
  respond,
  sameOrigin,
  segments,
} from "./api-http";
import { shareEmail } from "./collab-email";
import { planCopy, type CopyPlanError } from "./copy-plan";
import { sendEmail, type EmailEnv } from "./email";
import { planShare, spaceLinkText, type SharePlanError } from "./share-plan";
import * as spaces from "./spaces-store";
import { roleOf as workspaceRoleOf } from "./workspaces-store";

/**
 * `/api/spaces` (ADR 0079): sharing a node as a space, and who can reach it.
 * The space's content travels on `/api/spaces/:id/{sync,nodes,kv}`, routed by
 * `worker/index.ts` after the same role check.
 *
 * - A space you have no role on is a 404, so its existence doesn't leak.
 * - Writes are same-origin and rate-limited, like `/api/workspaces`.
 * - Sharing copies the subtree into the space's Durable Object BEFORE removing
 *   it from the personal outline: an interruption leaves content in both
 *   places, never in neither.
 * - Revoking a grant closes every live connection to the space; clients that
 *   still have access reconnect and pass the role check again.
 */

interface SpacesEnv extends EmailEnv {
  DB: D1Database;
  USER_OUTLINE: DurableObjectNamespace<UserOutlineDO>;
  WORKSPACE_LIMIT: RateLimit;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
}

/** What sharing needs from the actor's personal outline DO. */
export interface ShareSource {
  getNodes(): Promise<readonly Node[]>;
  getKv(
    collection: string,
  ): Promise<ReadonlyArray<Readonly<Record<string, string>>>>;
  applyBatch(ops: ChangeOp[]): Promise<number>;
}

export interface SpaceActor {
  /** Better Auth user id. */
  userId: string;
  /** Display name, for the emails this actor's changes send. */
  name: string;
  verifiedEmail: string | null;
  /** Run work after the response (the request's waitUntil). */
  defer: (work: Promise<unknown>) => void;
  /** The actor's personal outline (resolveUserId-routed), the share source. */
  outline: ShareSource;
}

const Role = Schema.Literals(SPACE_ROLES);
const ShareBody = Schema.Struct({ nodeId: Schema.String });
const NameBody = Schema.Struct({ name: Schema.String });
const GrantBody = Schema.Union([
  Schema.Struct({
    granteeType: Schema.Literal("email"),
    email: Schema.String,
    role: Role,
  }),
  Schema.Struct({
    granteeType: Schema.Literal("group"),
    groupId: Schema.String,
    role: Role,
  }),
]);
const RevokeBody = Schema.Struct({
  granteeType: Schema.Literals(["email", "group"]),
  granteeId: Schema.String,
});
const DailyRow = Schema.Struct({ nodeId: Schema.String });
const CopyInBody = Schema.Struct({
  rootId: Schema.String,
  exclude: Schema.Array(Schema.String),
  mode: Schema.Literals(["copy", "move"]),
});
const CopyOutBody = Schema.Struct({
  rootId: Schema.String,
  exclude: Schema.Array(Schema.String),
});

const COPY_REFUSAL = {
  "not-found": "That bullet doesn't exist anymore.",
  locked: "Unlock this bullet and everything under it before moving it.",
  daily: "Daily notes can't be moved into a shared note. Copy them instead.",
  "mirror-in":
    "A mirror elsewhere in your outline points into this bullet. Remove that mirror before moving, or copy instead.",
} satisfies Record<CopyPlanError, string>;

/** The node ids the daily calendar points at, which must stay put. */
async function dailyIds(outline: ShareSource): Promise<Set<string>> {
  const decoded = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))(
    await outline.getKv("daily-index"),
  );
  const ids = new Set<string>();
  for (const row of decoded._tag === "Some" ? decoded.value : []) {
    const d = Schema.decodeUnknownOption(DailyRow)(row);
    if (d._tag === "Some") ids.add(d.value.nodeId);
  }
  return ids;
}

const SHARE_REFUSAL = {
  "not-found": "That bullet doesn't exist anymore.",
  locked: "Unlock this bullet and everything under it before sharing it.",
  daily:
    "Daily notes can't be shared. Move the bullets you want to share out of the daily note first.",
  "mirror-out":
    "Something under this bullet mirrors content from elsewhere in your outline. Sharing it would share that content too. Remove the mirror, or copy what you want to share instead.",
  "mirror-in":
    "A mirror elsewhere in your outline points into this bullet. Remove that mirror before sharing.",
} satisfies Record<SharePlanError, string>;

export const spaceStub = (
  env: Pick<SpacesEnv, "USER_OUTLINE">,
  spaceId: string,
) =>
  env.USER_OUTLINE.get(
    env.USER_OUTLINE.idFromName(spaces.spaceObjectName(spaceId)),
  );

export const handleSpaces = Effect.fn("Spaces.handle")(
  (request: Request, env: SpacesEnv, actor: SpaceActor) =>
    respond(
      Effect.gen(function* () {
        const db = env.DB;
        const method = request.method;
        const now = Date.now();
        const [, spaceId, sub] = segments(new URL(request.url).pathname);

        if (method !== "GET") {
          if (!sameOrigin(request, env))
            return yield* Effect.fail(
              fail(403, "invalid_origin", "Open this server to share notes."),
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

        // --- The collection: mine and shared with me; share a node -------
        if (!spaceId) {
          if (method === "GET")
            return json({
              spaces: yield* Effect.promise(() =>
                spaces.listSpacesFor(db, actor.userId, actor.verifiedEmail),
              ),
            });
          if (method !== "POST")
            return json({ error: "method_not_allowed" }, 405);
          const { nodeId } = yield* decodeBody(request, ShareBody);
          const [nodes, dailyRows] = yield* Effect.promise(() =>
            Promise.all([
              actor.outline.getNodes(),
              actor.outline.getKv("daily-index"),
            ]),
          );
          // The daily calendar points at its pages by id; those can't move.
          const decodedDaily = Schema.decodeUnknownOption(
            Schema.Array(Schema.Unknown),
          )(dailyRows);
          const daily = new Set<string>();
          for (const row of decodedDaily._tag === "Some"
            ? decodedDaily.value
            : []) {
            const decoded = Schema.decodeUnknownOption(DailyRow)(row);
            if (decoded._tag === "Some") daily.add(decoded.value.nodeId);
          }
          const root = nodes.find((n) => n.id === nodeId);
          const id = crypto.randomUUID();
          const name =
            cleanName(flattenInline(root?.text ?? ""), SPACE_NAME_MAX) ??
            "Shared note";
          const url = `${new URL(request.url).origin}/s/${id}`;
          const plan = planShare(
            nodes,
            nodeId,
            daily,
            spaceLinkText(name, url),
            now,
          );
          if ("error" in plan)
            return yield* Effect.fail(
              fail(409, `share_${plan.error}`, SHARE_REFUSAL[plan.error]),
            );
          const space = { id, name, ownerId: actor.userId, createdAt: now };
          yield* Effect.promise(() => spaces.createSpace(db, space));
          // Copy into the space first; only then remove from the outline.
          const copied = yield* Effect.promise(() =>
            spaceStub(env, id)
              .upsertNodes(plan.spaceNodes)
              .then(() => true)
              .catch(() => false),
          );
          if (!copied) {
            yield* Effect.promise(() => spaces.deleteSpaceRows(db, id));
            return yield* Effect.fail(
              fail(
                500,
                "share_failed",
                "Couldn't share that bullet. Nothing changed; try again.",
              ),
            );
          }
          const replaced = yield* Effect.promise(() =>
            actor.outline
              .applyBatch(plan.personalOps)
              .then(() => true)
              .catch(() => false),
          );
          return json(
            {
              space: { ...space, role: "admin" as const, url },
              // False: the share exists, but the original stayed in place too.
              replaced,
            },
            201,
          );
        }

        // --- One space ------------------------------------------------------
        const role = yield* Effect.promise(() =>
          spaces.roleFor(db, spaceId, actor.userId, actor.verifiedEmail),
        );
        if (!canRead(role))
          return yield* Effect.fail(
            fail(
              404,
              "not_found",
              "That shared note doesn't exist or isn't shared with you.",
            ),
          );
        const space = yield* Effect.promise(() => spaces.getSpace(db, spaceId));
        if (!space)
          return yield* Effect.fail(
            fail(404, "not_found", "That shared note doesn't exist."),
          );

        if (sub === undefined) {
          if (method === "GET")
            return json({
              space,
              role,
              grants: canShare(role)
                ? yield* Effect.promise(() => spaces.listGrants(db, spaceId))
                : [],
            });
          if (method === "PATCH") {
            if (!canShare(role))
              return yield* Effect.fail(
                fail(403, "forbidden", "Only admins can rename a shared note."),
              );
            const input = yield* decodeBody(request, NameBody);
            const clean = cleanName(input.name, SPACE_NAME_MAX);
            if (!clean)
              return yield* Effect.fail(
                fail(
                  400,
                  "invalid_name",
                  `Use a name of up to ${SPACE_NAME_MAX} characters.`,
                ),
              );
            yield* Effect.promise(() => spaces.renameSpace(db, spaceId, clean));
            return json({ name: clean });
          }
          return json({ error: "method_not_allowed" }, 405);
        }

        // Copy (or move) bullets from your outline into this note: editors and
        // admins only (ADR 0083). The copy is written first; a move removes
        // the originals only after.
        if (sub === "copy-in" && method === "POST") {
          if (!canEdit(role))
            return yield* Effect.fail(
              fail(403, "forbidden", "You can't add to this shared note."),
            );
          const input = yield* decodeBody(request, CopyInBody);
          const target = spaceStub(env, spaceId);
          const [source, daily, targetNodes] = yield* Effect.promise(() =>
            Promise.all([
              actor.outline.getNodes(),
              dailyIds(actor.outline),
              target.getNodes(),
            ]),
          );
          const plan = planCopy({
            source,
            rootId: input.rootId,
            exclude: new Set(input.exclude),
            mode: input.mode,
            target: targetNodes,
            dailyNodeIds: daily,
            now,
          });
          if ("error" in plan)
            return yield* Effect.fail(
              fail(409, `copy_${plan.error}`, COPY_REFUSAL[plan.error]),
            );
          const copied = yield* Effect.promise(() =>
            target
              .applyBatch(plan.targetOps)
              .then(() => true)
              .catch(() => false),
          );
          if (!copied)
            return yield* Effect.fail(
              fail(
                409,
                "copy_failed",
                "Couldn't add to that note: its top bullet may be locked. Nothing changed.",
              ),
            );
          const removed =
            input.mode === "move"
              ? yield* Effect.promise(() =>
                  actor.outline
                    .applyBatch(plan.sourceOps)
                    .then(() => true)
                    .catch(() => false),
                )
              : false;
          return json({ count: plan.count, removed });
        }

        // Copy bullets from this note into your own outline: anyone who can
        // read the note (ADR 0083).
        if (sub === "copy-out" && method === "POST") {
          const input = yield* decodeBody(request, CopyOutBody);
          const [source, targetNodes] = yield* Effect.promise(() =>
            Promise.all([
              spaceStub(env, spaceId).getNodes(),
              actor.outline.getNodes(),
            ]),
          );
          const plan = planCopy({
            source,
            rootId: input.rootId,
            exclude: new Set(input.exclude),
            mode: "copy",
            target: targetNodes,
            dailyNodeIds: new Set(),
            now,
          });
          if ("error" in plan)
            return yield* Effect.fail(
              fail(409, `copy_${plan.error}`, COPY_REFUSAL[plan.error]),
            );
          const copied = yield* Effect.promise(() =>
            actor.outline
              .applyBatch(plan.targetOps)
              .then(() => true)
              .catch(() => false),
          );
          if (!copied)
            return yield* Effect.fail(
              fail(
                409,
                "copy_failed",
                "Couldn't copy into your outline. Nothing changed.",
              ),
            );
          return json({ count: plan.count });
        }

        // Who has access, for anyone who does (the mention picker, ADR 0082).
        if (sub === "people" && method === "GET")
          return json({
            people: yield* Effect.promise(() =>
              spaces.peopleWithAccess(db, spaceId),
            ),
          });

        if (sub === "grants") {
          if (!canShare(role))
            return yield* Effect.fail(
              fail(403, "forbidden", "Only admins can change who has access."),
            );
          if (method === "PUT") {
            const input = yield* decodeBody(request, GrantBody);
            if (input.granteeType === "email") {
              const email = input.email.trim();
              if (email.length > 254 || !EMAIL.test(email))
                return yield* Effect.fail(
                  fail(400, "invalid_email", "Enter a valid email address."),
                );
              const created = yield* Effect.promise(() =>
                spaces.putGrant(
                  db,
                  spaceId,
                  "email",
                  email,
                  input.role,
                  actor.userId,
                  now,
                ),
              );
              // Tell them, once: a role change doesn't email again (ADR 0082).
              if (created)
                actor.defer(
                  sendEmail(
                    env,
                    shareEmail({
                      to: email,
                      sharerName: actor.name,
                      noteName: space.name,
                      role: input.role,
                      url: `${new URL(request.url).origin}/s/${encodeURIComponent(spaceId)}`,
                    }),
                  ),
                );
            } else {
              // You can only share with groups of a workspace you're in.
              const workspaceId = yield* Effect.promise(() =>
                spaces.groupWorkspace(db, input.groupId),
              );
              const member =
                workspaceId &&
                (yield* Effect.promise(() =>
                  workspaceRoleOf(db, workspaceId, actor.userId),
                ));
              if (!member)
                return yield* Effect.fail(
                  fail(
                    404,
                    "not_found",
                    "That group doesn't exist or you're not in its workspace.",
                  ),
                );
              yield* Effect.promise(() =>
                spaces.putGrant(
                  db,
                  spaceId,
                  "group",
                  input.groupId,
                  input.role,
                  actor.userId,
                  now,
                ),
              );
            }
            return json({ granted: true });
          }
          if (method === "DELETE") {
            const input = yield* decodeBody(request, RevokeBody);
            yield* Effect.promise(() =>
              spaces.removeGrant(
                db,
                spaceId,
                input.granteeType,
                input.granteeId,
              ),
            );
            // Everyone reconnects; whoever still has access passes again.
            yield* Effect.promise(() =>
              spaceStub(env, spaceId).disconnectAll(),
            );
            return json({ revoked: true });
          }
          return json({ error: "method_not_allowed" }, 405);
        }

        return json({ error: "not_found" }, 404);
      }),
    ),
);

/**
 * Account deletion, before the identity rows go (ADR 0079): each space the
 * account owns passes to its best-placed collaborator (`spaceSuccessor`). A
 * space nobody can inherit is wiped with its Durable Object, keeping the
 * "delete my account" erasure promise for content only its owner could reach.
 */
export async function releaseOwnedSpaces(
  env: Pick<SpacesEnv, "DB" | "USER_OUTLINE">,
  userId: string,
): Promise<void> {
  for (const id of await spaces.ownedSpaceIds(env.DB, userId)) {
    const next = await spaces.spaceSuccessor(env.DB, id, userId);
    if (next) {
      await spaces.transferSpace(env.DB, id, next);
      continue;
    }
    await spaceStub(env, id).wipe();
    await spaces.deleteSpaceRows(env.DB, id);
  }
}
