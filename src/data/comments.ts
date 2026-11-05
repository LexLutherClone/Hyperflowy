import { Schema } from "effect";

import { canRead, type SpaceRole } from "./space-policy";

/**
 * Comments on a shared note's bullets (ADR 0081). One thread per bullet: its
 * comments in order, and whether the thread is resolved. Shared by the Durable
 * Object (storage), the Worker (enforcement), and the app (which controls to
 * offer), so all three agree on the rules.
 */

export const COMMENT_MAX = 4000;

export const CommentSchema = Schema.Struct({
  id: Schema.String,
  nodeId: Schema.String,
  authorId: Schema.String,
  /** The author's display name when they wrote it. */
  authorName: Schema.String,
  body: Schema.String,
  createdAt: Schema.Number,
  editedAt: Schema.NullOr(Schema.Number),
});
export type Comment = Schema.Schema.Type<typeof CommentSchema>;

export const CommentThreadSchema = Schema.Struct({
  nodeId: Schema.String,
  resolvedAt: Schema.NullOr(Schema.Number),
  resolvedBy: Schema.NullOr(Schema.String),
});
export type CommentThread = Schema.Schema.Type<typeof CommentThreadSchema>;

/** One bullet's thread: its comments, oldest first, and its resolution. */
export interface ThreadView {
  comments: Comment[];
  thread: CommentThread;
}

/** Per bullet: how many comments, and whether its thread is resolved. */
export interface CommentSummary {
  nodeId: string;
  count: number;
  resolved: boolean;
}

const RANK = { viewer: 1, commenter: 2, editor: 3, admin: 4 } satisfies Record<
  SpaceRole,
  number
>;

/** Anyone with access reads comments. */
export const canReadComments = canRead;

/** Commenters, editors, and admins write comments and resolve threads. */
export const canComment = (role: SpaceRole | null): boolean =>
  role !== null && RANK[role] >= RANK.commenter;

/** Only the author edits a comment, while they can still comment. */
export const canEditComment = (
  role: SpaceRole | null,
  actorId: string,
  comment: Pick<Comment, "authorId">,
): boolean => canComment(role) && comment.authorId === actorId;

/** The author, or an admin, deletes a comment. */
export const canDeleteComment = (
  role: SpaceRole | null,
  actorId: string,
  comment: Pick<Comment, "authorId">,
): boolean =>
  role === "admin" || (canComment(role) && comment.authorId === actorId);

/** A trimmed comment body within the limit, or null. */
export function cleanCommentBody(body: string): string | null {
  const trimmed = body.trim();
  return trimmed.length > 0 && trimmed.length <= COMMENT_MAX ? trimmed : null;
}
