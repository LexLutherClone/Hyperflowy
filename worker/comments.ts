/// <reference types="@cloudflare/workers-types" />

import { Effect, Schema } from "effect";

import type { Comment, CommentSummary, ThreadView } from "../src/data/comments";
import type { SpaceRole } from "../src/data/space-policy";
import type { Node } from "../src/data/wire-schema";

import {
  canComment,
  canDeleteComment,
  canEditComment,
  canReadComments,
  cleanCommentBody,
  COMMENT_MAX,
} from "../src/data/comments";
import { decodeBody, fail, json, respond, sameOrigin } from "./api-http";

/**
 * `/api/spaces/:id/comments` (ADR 0081): threads on a shared note's bullets,
 * stored in the space's Durable Object. The caller's role was resolved by
 * `worker/index.ts`; this applies the comment rules (`src/data/comments.ts`):
 * anyone with access reads, commenters and up write and resolve, only the
 * author edits, and the author or an admin deletes.
 *
 * | Route                                   | Does                      |
 * | --------------------------------------- | ------------------------- |
 * | `GET  …/comments`                       | per-bullet counts         |
 * | `GET  …/comments?nodeId=`               | one bullet's thread       |
 * | `POST …/comments { nodeId, body }`      | add (reopens if resolved) |
 * | `PATCH …/comments/:id { body }`         | edit your own             |
 * | `DELETE …/comments/:id`                 | delete                    |
 * | `PUT  …/comments/threads/:nodeId { resolved }` | resolve or reopen  |
 */

interface CommentsEnv {
  WORKSPACE_LIMIT: RateLimit;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
}

/** What comments need from a space's Durable Object. */
export interface CommentStore {
  getNodes(): Promise<readonly Node[]>;
  listComments(nodeId: string): Promise<ThreadView>;
  commentSummary(): Promise<CommentSummary[]>;
  getComment(id: string): Promise<Comment | null>;
  addComment(comment: Comment): Promise<void>;
  editComment(id: string, body: string, at: number): Promise<void>;
  deleteComment(id: string): Promise<void>;
  setThreadResolved(
    nodeId: string,
    by: string | null,
    at: number,
  ): Promise<void>;
}

export interface CommentActor {
  userId: string;
  name: string;
  role: SpaceRole;
  space: CommentStore;
  /** After a comment is added: notify the people it mentions (ADR 0082). */
  onComment?: (comment: Comment) => void;
}

const AddBody = Schema.Struct({ nodeId: Schema.String, body: Schema.String });
const EditBody = Schema.Struct({ body: Schema.String });
const ResolveBody = Schema.Struct({ resolved: Schema.Boolean });

const tooLong = () =>
  fail(
    400,
    "invalid_comment",
    `Write a comment of up to ${COMMENT_MAX} characters.`,
  );

export const handleComments = Effect.fn("Comments.handle")(
  (request: Request, env: CommentsEnv, actor: CommentActor, rest: string[]) =>
    respond(
      Effect.gen(function* () {
        const method = request.method;
        const { space, role, userId } = actor;
        if (!canReadComments(role))
          return yield* Effect.fail(fail(404, "not_found", "Not found."));

        if (method !== "GET") {
          if (!sameOrigin(request, env))
            return yield* Effect.fail(
              fail(403, "invalid_origin", "Open this server to comment."),
            );
          const { success } = yield* Effect.promise(() =>
            env.WORKSPACE_LIMIT.limit({ key: userId }),
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

        const [first, second] = rest;
        if (first === undefined) {
          if (method === "GET") {
            const nodeId = new URL(request.url).searchParams.get("nodeId");
            if (nodeId)
              return json(
                yield* Effect.promise(() => space.listComments(nodeId)),
              );
            return json({
              summary: yield* Effect.promise(() => space.commentSummary()),
            });
          }
          if (method === "POST") {
            if (!canComment(role))
              return yield* Effect.fail(
                fail(
                  403,
                  "forbidden",
                  "You can view this note but not comment on it.",
                ),
              );
            const input = yield* decodeBody(request, AddBody);
            const body = cleanCommentBody(input.body);
            if (!body) return yield* Effect.fail(tooLong());
            const exists = (yield* Effect.promise(() => space.getNodes())).some(
              (n) => n.id === input.nodeId,
            );
            if (!exists)
              return yield* Effect.fail(
                fail(404, "not_found", "That bullet doesn't exist anymore."),
              );
            const comment = {
              id: crypto.randomUUID(),
              nodeId: input.nodeId,
              authorId: userId,
              authorName: actor.name,
              body,
              createdAt: Date.now(),
              editedAt: null,
            };
            yield* Effect.promise(() => space.addComment(comment));
            actor.onComment?.(comment);
            return json({ comment }, 201);
          }
          return json({ error: "method_not_allowed" }, 405);
        }

        if (first === "threads" && second !== undefined && method === "PUT") {
          if (!canComment(role))
            return yield* Effect.fail(
              fail(
                403,
                "forbidden",
                "You can view this note but not resolve comments.",
              ),
            );
          const { resolved } = yield* decodeBody(request, ResolveBody);
          yield* Effect.promise(() =>
            space.setThreadResolved(
              second,
              resolved ? userId : null,
              Date.now(),
            ),
          );
          return json({ resolved });
        }

        if (second !== undefined) return json({ error: "not_found" }, 404);
        const comment = yield* Effect.promise(() => space.getComment(first));
        if (!comment)
          return yield* Effect.fail(
            fail(404, "not_found", "That comment is gone."),
          );
        if (method === "PATCH") {
          if (!canEditComment(role, userId, comment))
            return yield* Effect.fail(
              fail(403, "forbidden", "Only the author can edit a comment."),
            );
          const input = yield* decodeBody(request, EditBody);
          const body = cleanCommentBody(input.body);
          if (!body) return yield* Effect.fail(tooLong());
          yield* Effect.promise(() =>
            space.editComment(first, body, Date.now()),
          );
          return json({ body });
        }
        if (method === "DELETE") {
          if (!canDeleteComment(role, userId, comment))
            return yield* Effect.fail(
              fail(
                403,
                "forbidden",
                "Only the author or an admin can delete a comment.",
              ),
            );
          yield* Effect.promise(() => space.deleteComment(first));
          return json({ deleted: true });
        }
        return json({ error: "method_not_allowed" }, 405);
      }),
    ),
);
