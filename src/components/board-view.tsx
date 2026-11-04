import {
  KanbanIcon,
  MoreHorizontalIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { type DragEvent, type FormEvent, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import type { Node } from "../data/schema";

import {
  type BoardCard,
  type BoardColumn,
  buildBoard,
  lastChildId,
  ownContent,
  planBoardDrop,
  type ResolveContent,
} from "../data/board";
import { isMirrorsEnabled } from "../data/flags";
import { capture } from "../data/history";
import { appendChild, moveNode } from "../data/mutations";
import { flattenNodeText } from "../data/node-links";
import { runStructural } from "../data/structural";
import { childrenOf, isNodeLocked, type TreeIndex } from "../data/tree";
import { getTreeIndex, useTreeIndex } from "../data/tree-store";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/**
 * Board view (ADR 0075). Renders the zoom root's children as columns and their
 * children as cards. Every column and card is a real node: moving a card is the
 * outline's own `moveNode` inside one atomic structural write with an undo
 * point, adding a card is `appendChild`, and every outline edit re-renders the
 * board through the tree store. There is no board state to keep in sync.
 *
 * Cards are not a fourth editable text surface ("a node renders in three
 * places" -- docs/plugins.md): a card's title opens the node (zoom), where the
 * full editor, its tokens, keymaps, and history live. Tasks toggle in place
 * through the editor's own completion command.
 *
 * Drag uses native HTML drag and drop (desktop). Every card also has a
 * "Move to" menu, the keyboard, screen-reader, and touch path.
 */

const CARD_MIME = "application/x-dotflowy-card";

interface BoardViewProps {
  /** The zoomed instance id (route-owned). */
  rootId: string;
  /** The view's composed Seam-G prune (hide completed, etc.). */
  isHidden: (node: Node) => boolean;
  /** The editor's completion command (history, protection, transitions). */
  onToggleCompleted: (id: string, completed: boolean) => void;
}

function contentRule(): ResolveContent {
  return isMirrorsEnabled() ? (n) => n.mirrorOf ?? n.id : ownContent;
}

function label(index: TreeIndex, node: Node | undefined): string {
  return node ? flattenNodeText(index, node.text).trim() : "";
}

export function BoardView({
  rootId,
  isHidden,
  onToggleCompleted,
}: BoardViewProps) {
  const index = useTreeIndex();
  const resolve = contentRule();
  const root = index.byId.get(rootId);
  const rootContentId = root ? resolve(root) : rootId;
  const columns = buildBoard(index, rootContentId, isHidden, resolve);
  const [dropAt, setDropAt] = useState<{ column: string; at: number } | null>(
    null,
  );

  const moveCard = (cardId: string, columnId: string, at: number) => {
    const live = getTreeIndex();
    const column = buildBoard(live, rootContentId, isHidden, resolve).find(
      (c) => c.id === columnId,
    );
    if (!column) return;
    const plan = planBoardDrop(live, column, cardId, at);
    if (!plan) return;
    runStructural(() => {
      const drop = capture(live, cardId, null, { label: "move" });
      if (!moveNode(live, cardId, plan.parentId, plan.afterSiblingId)) drop();
    });
  };

  const addChild = (parentId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    runStructural(() => {
      const live = getTreeIndex();
      capture(live, null, null, { label: "create" });
      appendChild(parentId, lastChildId(live, parentId), trimmed);
    });
  };

  return (
    <div
      data-board=""
      className="board -mx-2 flex items-start gap-3 overflow-x-auto px-2 pt-2 pb-6"
    >
      {columns.map((column) => (
        <BoardColumnView
          key={column.id}
          index={index}
          column={column}
          columns={columns}
          dropAt={dropAt?.column === column.id ? dropAt.at : null}
          onDragOverAt={(at) => setDropAt({ column: column.id, at })}
          onDragLeave={() =>
            setDropAt((prev) => (prev?.column === column.id ? null : prev))
          }
          onDrop={(cardId, at) => {
            setDropAt(null);
            moveCard(cardId, column.id, at);
          }}
          onMoveTo={moveCard}
          onAdd={(text) => addChild(column.contentId, text)}
          onToggleCompleted={onToggleCompleted}
        />
      ))}
      <AddInline
        className="w-72 shrink-0"
        placeholder="Add column"
        buttonLabel="Add column"
        disabled={isNodeLocked(index, rootContentId)}
        onSubmit={(text) => addChild(rootContentId, text)}
      />
      {columns.length === 0 && (
        <p className="self-center text-sm text-muted-foreground">
          <HugeiconsIcon icon={KanbanIcon} className="me-1 inline size-4" />
          Each child of this page becomes a column, and its children become
          cards.
        </p>
      )}
    </div>
  );
}

function BoardColumnView({
  index,
  column,
  columns,
  dropAt,
  onDragOverAt,
  onDragLeave,
  onDrop,
  onMoveTo,
  onAdd,
  onToggleCompleted,
}: {
  index: TreeIndex;
  column: BoardColumn;
  columns: BoardColumn[];
  dropAt: number | null;
  onDragOverAt: (at: number) => void;
  onDragLeave: () => void;
  onDrop: (cardId: string, at: number) => void;
  onMoveTo: (cardId: string, columnId: string, at: number) => void;
  onAdd: (text: string) => void;
  onToggleCompleted: (id: string, completed: boolean) => void;
}) {
  const navigate = useNavigate();
  const listRef = useRef<HTMLOListElement>(null);
  const node = index.byId.get(column.contentId);
  const locked = isNodeLocked(index, column.contentId);
  const title = label(index, node) || "Untitled";

  // Visible insertion index under the pointer: before the first card whose
  // vertical midpoint is below it.
  const indexAt = (clientY: number) => {
    const cards = listRef.current?.querySelectorAll<HTMLElement>(
      ":scope > [data-board-card]",
    );
    if (!cards) return 0;
    let at = 0;
    for (const el of cards) {
      const rect = el.getBoundingClientRect();
      if (clientY > rect.top + rect.height / 2) at += 1;
      else break;
    }
    return at;
  };

  const accepts = (e: DragEvent) =>
    !locked && e.dataTransfer.types.includes(CARD_MIME);

  return (
    <section
      aria-label={title}
      data-board-column={column.id}
      className={cn(
        "flex max-h-[75vh] w-72 shrink-0 flex-col rounded-lg bg-muted/50 p-2",
        dropAt !== null && "ring-2 ring-primary/40",
      )}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOverAt(indexAt(e.clientY));
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget;
        if (
          !(next instanceof globalThis.Node && e.currentTarget.contains(next))
        )
          onDragLeave();
      }}
      onDrop={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        const cardId = e.dataTransfer.getData(CARD_MIME);
        if (cardId) onDrop(cardId, indexAt(e.clientY));
      }}
    >
      <header className="flex items-center gap-2 px-1 pb-2">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold hover:underline"
          onClick={() =>
            void navigate({ to: "/$nodeId", params: { nodeId: column.id } })
          }
        >
          {title}
        </button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {column.cards.length}
        </span>
      </header>
      <ol ref={listRef} className="flex min-h-8 flex-col gap-2 overflow-y-auto">
        {column.cards.map((card, i) => (
          <BoardCardView
            key={card.id}
            index={index}
            card={card}
            column={column}
            columns={columns}
            dropBefore={dropAt === i}
            onMoveTo={onMoveTo}
            onToggleCompleted={onToggleCompleted}
          />
        ))}
        {dropAt !== null && dropAt >= column.cards.length && <DropLine />}
      </ol>
      <AddInline
        className="pt-2"
        placeholder="Add card"
        buttonLabel="Add card"
        disabled={locked}
        onSubmit={onAdd}
      />
    </section>
  );
}

function BoardCardView({
  index,
  card,
  column,
  columns,
  dropBefore,
  onMoveTo,
  onToggleCompleted,
}: {
  index: TreeIndex;
  card: BoardCard;
  column: BoardColumn;
  columns: BoardColumn[];
  dropBefore: boolean;
  onMoveTo: (cardId: string, columnId: string, at: number) => void;
  onToggleCompleted: (id: string, completed: boolean) => void;
}) {
  const navigate = useNavigate();
  const node = index.byId.get(card.contentId);
  if (!node) return null;
  const text = label(index, node) || "Untitled";
  const childCount = childrenOf(index, card.contentId).length;
  const isTask = node.kind === null && node.isTask;
  const others = columns.filter((c) => c.id !== column.id);

  return (
    <>
      {dropBefore && <DropLine />}
      <li
        data-board-card={card.id}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(CARD_MIME, card.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        className={cn(
          "group flex cursor-grab items-start gap-2 rounded-md border bg-card p-2 text-sm shadow-xs active:cursor-grabbing",
          node.completed && "opacity-60",
        )}
      >
        {isTask && (
          <Checkbox
            className="checkbox mt-0.5 border-muted-foreground"
            aria-label={node.completed ? "Mark not done" : "Mark done"}
            checked={node.completed}
            onCheckedChange={(checked) =>
              onToggleCompleted(card.contentId, checked)
            }
          />
        )}
        <button
          type="button"
          className={cn(
            "min-w-0 flex-1 text-left break-words hover:underline",
            node.completed && "line-through",
          )}
          onClick={() =>
            void navigate({ to: "/$nodeId", params: { nodeId: card.id } })
          }
        >
          {text}
          {childCount > 0 && (
            <span className="ms-1.5 text-xs text-muted-foreground no-underline">
              · {childCount}
            </span>
          )}
        </button>
        {others.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Move “${text}”`}
                  className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Move to</DropdownMenuLabel>
                {others.map((target) => (
                  <DropdownMenuItem
                    key={target.id}
                    onClick={() =>
                      onMoveTo(card.id, target.id, target.cards.length)
                    }
                  >
                    {label(index, index.byId.get(target.contentId)) ||
                      "Untitled"}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    </>
  );
}

function DropLine() {
  return (
    <li
      aria-hidden
      data-board-drop-line=""
      className="h-0.5 shrink-0 rounded-full bg-primary"
    />
  );
}

function AddInline({
  placeholder,
  buttonLabel,
  disabled,
  className,
  onSubmit,
}: {
  placeholder: string;
  buttonLabel: string;
  disabled: boolean;
  className?: string;
  onSubmit: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (disabled) return null;
  if (!open)
    return (
      <div className={className}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          onClick={() => setOpen(true)}
        >
          <HugeiconsIcon icon={PlusSignIcon} />
          {buttonLabel}
        </Button>
      </div>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(text);
    setText("");
  };
  return (
    <form className={className} onSubmit={submit}>
      <input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by an explicit click
        autoFocus
        aria-label={placeholder}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setText("");
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!text.trim()) setOpen(false);
        }}
        className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </form>
  );
}
