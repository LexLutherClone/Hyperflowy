/// <reference types="@cloudflare/workers-types" />

import type { Comment } from "../src/data/comments";

import { mentionEmail, mentionedEmails } from "./collab-email";
import { sendEmail, type EmailEnv } from "./email";
import { roleFor, verifiedAccount } from "./spaces-store";

/**
 * Email the people a comment mentions (ADR 0082). A mention is an `@email`
 * token; it notifies only a verified account that currently has a role on the
 * space, and never the author. So a mention can't be used to email an
 * arbitrary address, or to tell anyone a note exists.
 */
export async function notifyMentions(
  env: EmailEnv & { DB: D1Database },
  input: {
    comment: Comment;
    spaceId: string;
    noteName: string;
    authorId: string;
    origin: string;
  },
): Promise<number> {
  let sent = 0;
  for (const email of mentionedEmails(input.comment.body)) {
    const account = await verifiedAccount(env.DB, email);
    if (!account || account.userId === input.authorId) continue;
    const role = await roleFor(env.DB, input.spaceId, account.userId, email);
    if (role === null) continue;
    await sendEmail(
      env,
      mentionEmail({
        to: account.email,
        authorName: input.comment.authorName,
        noteName: input.noteName,
        comment: input.comment.body,
        url: `${input.origin}/s/${encodeURIComponent(input.spaceId)}`,
      }),
    );
    sent += 1;
  }
  return sent;
}
