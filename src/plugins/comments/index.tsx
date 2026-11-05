import { formatDistanceToNow } from "date-fns";
import { CheckIcon, MessageSquareIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import type { ThreadView } from "../../data/comments";
import type { PluginContext } from "../types";

import {
  refreshCommentCounts,
  useCommentSummary,
} from "../../data/comment-counts";
import {
  canComment,
  canDeleteComment,
  canEditComment,
  COMMENT_MAX,
} from "../../data/comments";
import * as api from "../../data/comments-api";
import { flattenInline } from "../../data/inline-text";
import { inSpace } from "../../data/outline-scope";
import { useSpaceSession } from "../../data/space-session";
import { useSession } from "../../lib/auth-client";
import { Button, SheetHeader, SheetTitle, Textarea } from "../kit";
import { definePlugin } from "../types";

/**
 * Comments on a shared note's bullets (ADR 0081): a count badge after a
 * bullet with comments, `/comment` to open its thread, and the thread in the
 * side panel. Shared notes only; your own outline has no comments.
 */

const POLL_MS = 10_000;

function openThread(nodeId: string, ctx: PluginContext) {
  const text = ctx.tree.byId.get(nodeId)?.text ?? "";
  ctx.openPanel(
    <CommentsPanel nodeId={nodeId} label={flattenInline(text) || "Untitled"} />,
  );
}

function CommentBadge({
  nodeId,
  getCtx,
}: {
  nodeId: string;
  getCtx: () => PluginContext;
}) {
  const summary = useCommentSummary(nodeId);
  const session = useSpaceSession();
  const role = session.status === "ready" ? session.role : null;
  if (!summary)
    // No thread yet: commenters get a quiet "add" affordance (a read-only
    // note blocks `/`, so this is how a commenter starts a thread).
    return canComment(role) ? (
      <button
        type="button"
        data-comment-add={nodeId}
        aria-label="Add a comment"
        className="comment-add inline-flex items-center rounded px-1 text-muted-foreground hover:bg-muted"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => openThread(nodeId, getCtx())}
      >
        <MessageSquareIcon className="size-3" />
      </button>
    ) : null;
  return (
    <button
      type="button"
      data-comment-badge={nodeId}
      aria-label={`${summary.count} ${summary.count === 1 ? "comment" : "comments"}${summary.resolved ? ", resolved" : ""}`}
      className={`inline-flex items-center gap-0.5 rounded px-1 text-xs tabular-nums hover:bg-muted ${summary.resolved ? "text-muted-foreground/60" : "text-muted-foreground"}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => openThread(nodeId, getCtx())}
    >
      {summary.resolved ? (
        <CheckIcon className="size-3" />
      ) : (
        <MessageSquareIcon className="size-3" />
      )}
      {summary.count}
    </button>
  );
}

export function CommentsPanel({
  nodeId,
  label,
}: {
  nodeId: string;
  label: string;
}) {
  const session = useSpaceSession();
  const { data: auth } = useSession();
  const me = auth?.user.id ?? "";
  const role = session.status === "ready" ? session.role : null;
  const [view, setView] = useState<ThreadView | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(
    null,
  );
  const [people, setPeople] = useState<api.SpacePerson[]>([]);
  useEffect(() => {
    void api.people().then(setPeople);
  }, []);

  const load = useCallback(async () => {
    try {
      setView(await api.thread(nodeId));
    } catch (error) {
      if (error instanceof Error) toast.error(error.message);
    }
  }, [nodeId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const act = async <T,>(action: () => Promise<T>) => {
    try {
      await action();
    } catch (error) {
      if (error instanceof Error) toast.error(error.message);
    }
    await Promise.all([load(), refreshCommentCounts()]);
  };

  const post = () => {
    const body = draft.trim();
    if (!body) return;
    void act(() => api.addComment(nodeId, body)).then(() => setDraft(""));
  };

  const resolved = view?.thread.resolvedAt != null;
  return (
    <div className="flex h-full flex-col gap-4" data-comments-panel={nodeId}>
      <SheetHeader className="px-0">
        <SheetTitle>Comments</SheetTitle>
        <p className="line-clamp-2 text-sm text-muted-foreground">{label}</p>
      </SheetHeader>
      {view === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {view.comments.length > 0 && canComment(role) && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => void act(() => api.setResolved(nodeId, !resolved))}
            >
              <CheckIcon />
              {resolved ? "Reopen" : "Resolve"}
            </Button>
          )}
          {resolved && (
            <p className="text-sm text-muted-foreground">
              Resolved. A new comment reopens the thread.
            </p>
          )}
          <ul className="flex flex-col gap-3 overflow-y-auto">
            {view.comments.length === 0 && (
              <li className="text-sm text-muted-foreground">
                No comments yet.
              </li>
            )}
            {view.comments.map((c) => (
              <li
                key={c.id}
                data-comment={c.id}
                className={`flex flex-col gap-1 rounded-lg p-3 ring-1 ring-foreground/10 ${resolved ? "opacity-70" : ""}`}
              >
                <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {c.authorName}
                  </span>
                  <span>
                    {formatDistanceToNow(c.createdAt, { addSuffix: true })}
                    {c.editedAt !== null && " · edited"}
                  </span>
                </div>
                {editing?.id === c.id ? (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(() => api.editComment(c.id, editing.body)).then(
                        () => setEditing(null),
                      );
                    }}
                  >
                    <Textarea
                      aria-label="Edit comment"
                      value={editing.body}
                      maxLength={COMMENT_MAX}
                      onChange={(e) =>
                        setEditing({ id: c.id, body: e.target.value })
                      }
                    />
                    <div className="flex gap-2">
                      <Button type="submit" size="sm">
                        Save
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className="text-sm break-words whitespace-pre-wrap">
                    <CommentText body={c.body} people={people} />
                  </p>
                )}
                {editing?.id !== c.id && (
                  <div className="flex gap-1">
                    {canEditComment(role, me, c) && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setEditing({ id: c.id, body: c.body })}
                      >
                        Edit
                      </Button>
                    )}
                    {canDeleteComment(role, me, c) && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => void act(() => api.deleteComment(c.id))}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {canComment(role) ? (
            <form
              className="mt-auto flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                post();
              }}
            >
              <Textarea
                aria-label="Write a comment"
                placeholder="Write a comment… Type @ to mention someone."
                value={draft}
                maxLength={COMMENT_MAX}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    post();
                  }
                }}
              />
              <MentionSuggestions
                draft={draft}
                people={people}
                onPick={(email) =>
                  setDraft((d) => d.replace(/@[^\s@]*$/, `@${email} `))
                }
              />
              <Button type="submit" size="sm" disabled={!draft.trim()}>
                Comment
              </Button>
            </form>
          ) : (
            <p className="mt-auto text-sm text-muted-foreground">
              You can read comments here, but not add them.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** People matching the `@query` the draft ends with. */
function MentionSuggestions({
  draft,
  people,
  onPick,
}: {
  draft: string;
  people: api.SpacePerson[];
  onPick: (email: string) => void;
}) {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  if (!match) return null;
  const query = match[1]!.toLowerCase();
  const hits = people
    .filter(
      (p) =>
        p.email.includes(query) || (p.name ?? "").toLowerCase().includes(query),
    )
    .slice(0, 6);
  if (hits.length === 0) return null;
  return (
    <ul
      aria-label="Mention someone"
      className="flex flex-col rounded-lg py-1 text-sm ring-1 ring-foreground/10"
    >
      {hits.map((p) => (
        <li key={p.email}>
          <button
            type="button"
            className="flex w-full gap-2 px-3 py-1 text-left hover:bg-muted"
            onClick={() => onPick(p.email)}
          >
            {p.name && <span className="font-medium">{p.name}</span>}
            <span className="text-muted-foreground">{p.email}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A comment's text, with `@email` mentions shown as the person's name. */
function CommentText({
  body,
  people,
}: {
  body: string;
  people: api.SpacePerson[];
}) {
  const parts = body.split(/(@[^\s@()<>,;]+@[^\s@()<>,;]+\.[A-Za-z]{2,})/g);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const email = part.slice(1).toLowerCase();
        const person = people.find((p) => p.email === email);
        return (
          <span
            key={i}
            className="rounded bg-primary/10 px-0.5 font-medium"
            title={email}
          >
            @{person?.name ?? email}
          </span>
        );
      })}
    </>
  );
}

export default definePlugin({
  id: "comments",
  slots: [
    {
      id: "comments:row",
      position: "row:after-text",
      render: (node, getCtx) =>
        inSpace() ? <CommentBadge nodeId={node.id} getCtx={getCtx} /> : null,
    },
  ],
  commands: [
    {
      id: "comment",
      label: "Comment",
      description: "Open this bullet's comments",
      icon: MessageSquareIcon,
      keywords: ["comment", "discuss", "thread", "note"],
      available: () => inSpace(),
      run: (nodeId, ctx) => openThread(nodeId, ctx),
    },
  ],
});
