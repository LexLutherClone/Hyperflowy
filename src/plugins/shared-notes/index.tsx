import {
  ArrowRight01Icon,
  ArrowDown01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";

import type { Node } from "../../data/schema";

import { flattenInline } from "../../data/inline-text";
import { inSpace } from "../../data/outline-scope";
import { previewLines, spaceLinkId } from "../../data/space-link";
import { useSpacePreview } from "../../data/space-preview";
import { Button } from "../kit";
import { definePlugin } from "../types";

/**
 * Shared-note previews (ADR 0080). Under a bullet that links to a shared note
 * (what sharing leaves in your outline, ADR 0079), show that note's outline,
 * live and read-only, with a way to open it. It never writes, and its nodes
 * never enter your outline's data layer.
 */

const ROLE = {
  viewer: "Can view",
  commenter: "Can comment",
  editor: "Can edit",
  admin: "Admin",
} as const;

/** True once the element has been on screen (rows are windowed, so a
 *  mounted row is near the viewport, but this keeps a long outline's
 *  previews from all connecting at once). */
function useSeen() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (!("IntersectionObserver" in window)) return setSeen(true);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

function SharedNotePreview({ node }: { node: Node }) {
  const spaceId = inSpace()
    ? null
    : spaceLinkId(node.text, window.location.origin);
  const [ref, seen] = useSeen();
  const [open, setOpen] = useState(true);
  const state = useSpacePreview(spaceId !== null && seen ? spaceId : null);
  if (spaceId === null) return null;
  const href = `/s/${encodeURIComponent(spaceId)}`;

  return (
    <div
      ref={ref}
      data-space-preview={spaceId}
      className="my-1 rounded-lg bg-muted/40 px-3 py-2 text-sm ring-1 ring-foreground/5"
      // The body sits outside the bullet's text; keep clicks here from
      // placing the editing caret.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide preview" : "Show preview"}
          className="flex items-center gap-1 hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
        >
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            className="size-3.5"
          />
          <HugeiconsIcon icon={UserGroupIcon} className="size-3.5" />
          Shared note
          {state.status === "ready" && ` · ${ROLE[state.role]}`}
        </button>
        <Button
          variant="ghost"
          size="xs"
          className="ms-auto"
          nativeButton={false}
          render={<a href={href} />}
        >
          Open
        </Button>
      </div>
      {open && <PreviewBody state={state} />}
    </div>
  );
}

function PreviewBody({ state }: { state: ReturnType<typeof useSpacePreview> }) {
  if (state.status === "loading")
    return <p className="mt-1 text-muted-foreground">Loading…</p>;
  if (state.status === "missing")
    return (
      <p className="mt-1 text-muted-foreground">
        This note isn't shared with you anymore.
      </p>
    );
  if (state.status === "error")
    return (
      <p className="mt-1 text-muted-foreground">
        Couldn't load the preview. Open the note to see it.
      </p>
    );
  const { lines, more } = previewLines(state.nodes);
  if (lines.length === 0)
    return <p className="mt-1 text-muted-foreground">Nothing in it yet.</p>;
  return (
    <ul className="mt-1 flex flex-col gap-0.5" aria-label="Shared note preview">
      {lines.map((line) => (
        <li
          key={line.id}
          data-preview-node={line.id}
          className={line.completed ? "text-muted-foreground line-through" : ""}
          style={{ paddingInlineStart: `${line.depth * 16}px` }}
        >
          <span aria-hidden className="me-1.5 text-muted-foreground">
            {line.isTask ? (line.completed ? "☑" : "☐") : "•"}
          </span>
          {flattenInline(line.text) || " "}
          {line.hiddenChildren > 0 && (
            <span className="ms-1 text-xs text-muted-foreground no-underline">
              (+{line.hiddenChildren})
            </span>
          )}
        </li>
      ))}
      {more > 0 && (
        <li className="text-xs text-muted-foreground">and {more} more…</li>
      )}
    </ul>
  );
}

export default definePlugin({
  id: "shared-notes",
  slots: [
    {
      id: "shared-notes:row",
      position: "row:body",
      render: (node) => <SharedNotePreview node={node} />,
    },
  ],
});
