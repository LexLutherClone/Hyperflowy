import {
  ArrowUpRight01Icon,
  KanbanIcon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";

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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { type BoardDropTarget, useBoardDrag } from "./use-board-drag";

/**
 * Board view (ADR 0075). Renders the zoom root's children as columns and their
 * children as cards. Every column and card is a real node: moving a card is the
 * outline's own `moveNode` inside one atomic structural write with an undo
 * point, adding a card is `appendChild`, editing a card's text is the editor's
 * own `onTextChange`, and every outline edit re-renders the board through the
 * tree store. There is no board state to keep in sync.
 *
 * Card text edits as its TEXT SOURCE (raw markdown) in a plain textarea, not a
 * fourth contentEditable surface ("a node renders in three places" --
 * docs/plugins.md). One commit per edit session (Enter or blur) writes through
 * `onTextChange`, so lock guards, history, and the coalesced PATCH all apply.
 *
 * Drag is pointer-driven for mouse and touch (`use-board-drag.ts`). Every card
 * also has a "Move to" menu, the keyboard and screen-reader path.
 */

interface BoardViewProps {
  /** The zoomed instance id (route-owned). */
  rootId: string;
  /** The view's composed Seam-G prune (hide completed, etc.). */
  isHidden: (node: Node) => boolean;
  /** The editor's completion command (history, protection, transitions). */
  onToggleCompleted: (id: string, completed: boolean) => void;
  /** The editor's text command (lock guard, history, coalesced write). */
  onTextChange: (id: string, text: string) => void;
}

interface CardActions {
  index: TreeIndex;
  columns: BoardColumn[];
  draggingId: string | null;
  startDrag: ReturnType<typeof useBoardDrag>["startDrag"];
  consumeClick: () => boolean;
  onMoveTo: (cardId: string, columnId: string, at: number) => void;
  onToggleCompleted: (id: string, completed: boolean) => void;
  onTextChange: (id: string, text: string) => void;
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
  onTextChange,
}: BoardViewProps) {
  const index = useTreeIndex();
  const resolve = contentRule();
  const root = index.byId.get(rootId);
  const rootContentId = root ? resolve(root) : rootId;
  const columns = buildBoard(index, rootContentId, isHidden, resolve);
  const boardRef = useRef<HTMLDivElement>(null);

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

  const drag = useBoardDrag({
    boardRef,
    canDropIn: (columnId) => {
      const live = getTreeIndex();
      const column = live.byId.get(columnId);
      return !!column && !isNodeLocked(live, resolve(column));
    },
    onDrop: moveCard,
  });

  const actions: CardActions = {
    index,
    columns,
    draggingId: drag.draggingId,
    startDrag: drag.startDrag,
    consumeClick: drag.consumeClick,
    onMoveTo: moveCard,
    onToggleCompleted,
    onTextChange,
  };

  return (
    <div
      ref={boardRef}
      data-board=""
      className="board -mx-2 flex items-start gap-3 overflow-x-auto px-2 pt-2 pb-6"
    >
      {columns.map((column) => (
        <BoardColumnView
          key={column.id}
          column={column}
          target={drag.target?.column === column.id ? drag.target : null}
          onAdd={(text) => addChild(column.contentId, text)}
          actions={actions}
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
  column,
  target,
  onAdd,
  actions,
}: {
  column: BoardColumn;
  target: BoardDropTarget | null;
  onAdd: (text: string) => void;
  actions: CardActions;
}) {
  const navigate = useNavigate();
  const { index } = actions;
  const node = index.byId.get(column.contentId);
  const locked = isNodeLocked(index, column.contentId);
  const title = label(index, node) || "Untitled";
  const dropAt = target?.at ?? null;

  return (
    <section
      aria-label={title}
      data-board-column={column.id}
      className={cn(
        "flex max-h-[75vh] w-72 shrink-0 flex-col rounded-lg bg-muted/50 p-2",
        dropAt !== null && "ring-2 ring-primary/40",
      )}
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
      <ol
        data-board-cards=""
        className="flex min-h-8 flex-col gap-2 overflow-y-auto"
      >
        {column.cards.map((card, i) => (
          <BoardCardView
            key={card.id}
            card={card}
            column={column}
            dropBefore={dropAt === i}
            actions={actions}
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
  card,
  column,
  dropBefore,
  actions,
}: {
  card: BoardCard;
  column: BoardColumn;
  dropBefore: boolean;
  actions: CardActions;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const { index, columns } = actions;
  const node = index.byId.get(card.contentId);
  if (!node) return null;
  const text = label(index, node) || "Untitled";
  const childCount = childrenOf(index, card.contentId).length;
  const isTask = node.kind === null && node.isTask;
  const locked = isNodeLocked(index, card.contentId);
  const others = columns.filter((c) => c.id !== column.id);
  const open = () =>
    void navigate({ to: "/$nodeId", params: { nodeId: card.id } });

  return (
    <>
      {dropBefore && <DropLine />}
      <li
        data-board-card={card.id}
        data-dragging={actions.draggingId === card.id ? "" : undefined}
        onPointerDown={(e) => {
          if (!editing) actions.startDrag(card.id, e);
        }}
        className={cn(
          "board-card group flex items-start gap-2 rounded-md border bg-card p-2 text-sm shadow-xs",
          !editing && "cursor-grab",
          node.completed && !editing && "opacity-60",
        )}
      >
        {isTask && (
          <span data-board-no-drag="" className="contents">
            <Checkbox
              className="checkbox mt-0.5 border-muted-foreground"
              aria-label={node.completed ? "Mark not done" : "Mark done"}
              checked={node.completed}
              onCheckedChange={(checked) =>
                actions.onToggleCompleted(card.contentId, checked)
              }
            />
          </span>
        )}
        {editing ? (
          <CardTextEditor
            source={node.text}
            onCommit={(next) => {
              setEditing(false);
              if (next !== node.text)
                actions.onTextChange(card.contentId, next);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <button
            type="button"
            aria-label={locked ? text : `Edit “${text}”`}
            className={cn(
              "min-w-0 flex-1 text-left break-words select-none",
              !locked && "hover:underline",
              node.completed && "line-through",
            )}
            onClick={() => {
              if (actions.consumeClick() || locked) return;
              setEditing(true);
            }}
          >
            {text}
            {childCount > 0 && (
              <span className="ms-1.5 text-xs text-muted-foreground no-underline">
                · {childCount}
              </span>
            )}
          </button>
        )}
        {!editing && (
          <span data-board-no-drag="" className="contents">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Card actions for “${text}”`}
                    className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <HugeiconsIcon icon={MoreHorizontalIcon} />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={open}>
                  <HugeiconsIcon icon={ArrowUpRight01Icon} />
                  Open
                </DropdownMenuItem>
                {!locked && (
                  <DropdownMenuItem onClick={() => setEditing(true)}>
                    <HugeiconsIcon icon={PencilEdit02Icon} />
                    Edit text
                  </DropdownMenuItem>
                )}
                {others.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Move to</DropdownMenuLabel>
                      {others.map((target) => (
                        <DropdownMenuItem
                          key={target.id}
                          onClick={() =>
                            actions.onMoveTo(
                              card.id,
                              target.id,
                              target.cards.length,
                            )
                          }
                        >
                          {label(index, index.byId.get(target.contentId)) ||
                            "Untitled"}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        )}
      </li>
    </>
  );
}

/**
 * Edits a card's text source. Uncontrolled after mount: the store is not
 * repainted into it while it has focus, so an echo of another write can't move
 * the caret (the ADR 0010 hazard). Enter commits, Shift+Enter is a newline,
 * Escape discards, and blur commits.
 */
function CardTextEditor({
  source,
  onCommit,
  onCancel,
}: {
  source: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const done = useRef(false);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  const fit = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  return (
    <textarea
      data-board-no-drag=""
      aria-label="Card text"
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by an explicit click
      autoFocus
      defaultValue={source}
      rows={1}
      ref={(el) => {
        if (el) fit(el);
      }}
      onFocus={(e) => {
        const el = e.currentTarget;
        el.setSelectionRange(el.value.length, el.value.length);
      }}
      onInput={(e) => fit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          const value = e.currentTarget.value;
          finish(() => onCommit(value));
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(onCancel);
        }
      }}
      onBlur={(e) => {
        const value = e.currentTarget.value;
        finish(() => onCommit(value));
      }}
      className="min-w-0 flex-1 resize-none overflow-hidden rounded-sm bg-transparent leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
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
