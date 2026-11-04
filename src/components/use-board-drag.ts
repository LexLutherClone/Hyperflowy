import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Pointer-driven card drag for the Board view (ADR 0075), one gesture for mouse
 * and touch. It follows the outline row drag's touch contract
 * (`use-drag-reorder.ts`) so the two feel the same on a phone:
 *
 * - **Mouse:** a press becomes a drag after {@link THRESHOLD}px of movement;
 *   less than that is a click.
 * - **Touch:** the finger must HOLD still for {@link TOUCH_HOLD_MS}. Moving
 *   before then belongs to native scrolling (the board scrolls sideways, the
 *   page scrolls down), so the press is abandoned. Once the hold completes the
 *   drag starts under the finger and native panning is blocked from then on.
 * - **Multi-touch** cancels; `pointercancel` cancels; nothing commits.
 *
 * The hook owns no tree logic: it reports the hovered column and visible
 * insertion index, and calls `onDrop(cardId, columnId, at)` on release. The
 * caller plans the move (`planBoardDrop`) and writes it.
 *
 * DOM contract: columns carry `data-board-column={id}`, their card lists carry
 * `data-board-cards`, and cards carry `data-board-card={id}`. Elements inside
 * a card marked `data-board-no-drag` (checkbox, menu trigger, the text editor)
 * never start a drag.
 */

const THRESHOLD = 5;
const TOUCH_HOLD_MS = 350;
const EDGE = 56;
const SCROLL_MAX = 16;

export interface BoardDropTarget {
  column: string;
  at: number;
}

interface DragState {
  cardId: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  dragging: boolean;
  holdTimer: number | null;
  raf: number | null;
  ghost: HTMLElement | null;
  offsetX: number;
  offsetY: number;
  target: BoardDropTarget | null;
}

/** Visible insertion index in `list` for a pointer at `clientY`: before the
 *  first card whose vertical midpoint is below it. The dragged card's own
 *  element still counts, which is what `planBoardDrop` expects. */
export function insertionIndex(list: Element, clientY: number): number {
  let at = 0;
  for (const el of list.querySelectorAll(":scope > [data-board-card]")) {
    const rect = el.getBoundingClientRect();
    if (clientY > rect.top + rect.height / 2) at += 1;
    else break;
  }
  return at;
}

export function useBoardDrag({
  boardRef,
  canDropIn,
  onDrop,
}: {
  /** The horizontally scrolling board container (auto-scrolls at its edges). */
  boardRef: React.RefObject<HTMLElement | null>;
  /** False for a locked column: it shows no indicator and takes no drop. */
  canDropIn: (columnId: string) => boolean;
  onDrop: (cardId: string, columnId: string, at: number) => void;
}) {
  const state = useRef<DragState | null>(null);
  // Set when a press turned into a drag, so the click that follows pointerup
  // is swallowed (no edit, no checkbox toggle). Read once by consumeClick.
  const consumed = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [target, setTarget] = useState<BoardDropTarget | null>(null);
  // Latest callbacks for the document listeners, which are bound once.
  const deps = useRef({ canDropIn, onDrop });
  useEffect(() => {
    deps.current = { canDropIn, onDrop };
  });

  const cleanup = useCallback(() => {
    const s = state.current;
    state.current = null;
    if (!s) return;
    if (s.holdTimer !== null) window.clearTimeout(s.holdTimer);
    if (s.raf !== null) cancelAnimationFrame(s.raf);
    s.ghost?.remove();
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    document.documentElement.classList.remove("board-dragging");
    setDraggingId(null);
    setTarget(null);
    // The listeners are module-stable function declarations below.
    // eslint-disable-next-line react-doctor/exhaustive-deps
  }, []);

  function project(s: DragState) {
    if (s.ghost) {
      s.ghost.style.transform = `translate(${s.x - s.offsetX}px, ${s.y - s.offsetY}px)`;
    }
    const hit = document.elementFromPoint(s.x, s.y);
    const columnEl = hit?.closest<HTMLElement>("[data-board-column]");
    const columnId = columnEl?.dataset.boardColumn ?? null;
    let next: BoardDropTarget | null = null;
    if (columnId && columnEl && deps.current.canDropIn(columnId)) {
      const list = columnEl.querySelector("[data-board-cards]");
      next = { column: columnId, at: list ? insertionIndex(list, s.y) : 0 };
    }
    const prev = s.target;
    if (prev?.column !== next?.column || prev?.at !== next?.at) {
      s.target = next;
      setTarget(next);
    }
  }

  function tick() {
    const s = state.current;
    if (!s?.dragging) return;
    // Sideways: the board's own scroller. Down/up: the hovered column's card
    // list when it overflows, else the page.
    const board = boardRef.current;
    if (board) {
      const r = board.getBoundingClientRect();
      const dx =
        s.x < r.left + EDGE
          ? -speed(r.left + EDGE - s.x)
          : s.x > r.right - EDGE
            ? speed(s.x - (r.right - EDGE))
            : 0;
      if (dx) board.scrollLeft += dx;
    }
    const list = document
      .elementFromPoint(s.x, s.y)
      ?.closest("[data-board-column]")
      ?.querySelector<HTMLElement>("[data-board-cards]");
    const dy =
      s.y < EDGE
        ? -speed(EDGE - s.y)
        : s.y > window.innerHeight - EDGE
          ? speed(s.y - (window.innerHeight - EDGE))
          : 0;
    if (list && list.scrollHeight > list.clientHeight) {
      const r = list.getBoundingClientRect();
      const ly =
        s.y < r.top + EDGE / 2
          ? -speed(r.top + EDGE / 2 - s.y)
          : s.y > r.bottom - EDGE / 2
            ? speed(s.y - (r.bottom - EDGE / 2))
            : 0;
      if (ly) list.scrollTop += ly;
    }
    if (dy) window.scrollBy(0, dy);
    project(s);
    s.raf = requestAnimationFrame(tick);
  }

  function beginDrag(s: DragState) {
    if (s.dragging) return;
    s.dragging = true;
    consumed.current = true;
    const card = document.querySelector<HTMLElement>(
      `[data-board-card="${CSS.escape(s.cardId)}"]`,
    );
    if (card) {
      const rect = card.getBoundingClientRect();
      const ghost = card.cloneNode(true);
      if (ghost instanceof HTMLElement) {
        ghost.removeAttribute("data-board-card");
        ghost.setAttribute("aria-hidden", "true");
        ghost.classList.add("board-drag-ghost");
        ghost.style.width = `${rect.width}px`;
        document.body.append(ghost);
        s.ghost = ghost;
      }
      s.offsetX = s.startX - rect.left;
      s.offsetY = s.startY - rect.top;
    }
    // A touch drag never edits text; drop any selection the hold made.
    window.getSelection()?.removeAllRanges();
    document.documentElement.classList.add("board-dragging");
    setDraggingId(s.cardId);
    project(s);
    s.raf = requestAnimationFrame(tick);
  }

  function onMove(e: PointerEvent) {
    const s = state.current;
    if (!s || e.pointerId !== s.pointerId) return;
    s.x = e.clientX;
    s.y = e.clientY;
    if (!s.dragging) {
      const moved = Math.hypot(s.x - s.startX, s.y - s.startY);
      if (moved < THRESHOLD) return;
      // A touch that moves before the hold is a scroll, not a drag.
      if (s.pointerType === "touch") {
        cleanup();
        return;
      }
      beginDrag(s);
    }
    e.preventDefault();
    project(s);
  }

  function onUp(e: PointerEvent) {
    const s = state.current;
    if (!s || e.pointerId !== s.pointerId) return;
    const drop = s.dragging ? s.target : null;
    const cardId = s.cardId;
    cleanup();
    if (drop) deps.current.onDrop(cardId, drop.column, drop.at);
  }

  function onCancel(e: PointerEvent) {
    const s = state.current;
    if (!s || e.pointerId !== s.pointerId) return;
    cleanup();
  }

  // Block native panning once a touch drag owns the gesture. Preinstalled and
  // non-passive for the same reason as the row drag (WebKit bug 185656):
  // registering during pointerdown can be too late for the first move.
  useEffect(() => {
    const onTouch = (e: TouchEvent) => {
      const s = state.current;
      if (!s || s.pointerType !== "touch") return;
      if (e.touches.length !== 1) {
        cleanup();
        return;
      }
      if (e.type === "touchmove" && s.dragging) {
        if (e.cancelable) e.preventDefault();
        else cleanup();
      }
    };
    document.addEventListener("touchmove", onTouch, { passive: false });
    document.addEventListener("touchstart", onTouch, { passive: false });
    return () => {
      document.removeEventListener("touchmove", onTouch);
      document.removeEventListener("touchstart", onTouch);
      cleanup();
    };
  }, [cleanup]);

  const startDrag = useCallback(
    (cardId: string, e: ReactPointerEvent) => {
      if (!e.isPrimary) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // SAFETY: pointer events on a card target an element inside it
      if ((e.target as Element).closest("[data-board-no-drag]")) return;
      consumed.current = false;
      cleanup();
      const s: DragState = {
        cardId,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        dragging: false,
        holdTimer: null,
        raf: null,
        ghost: null,
        offsetX: 0,
        offsetY: 0,
        target: null,
      };
      state.current = s;
      if (e.pointerType === "touch") {
        s.holdTimer = window.setTimeout(() => {
          s.holdTimer = null;
          if (state.current === s) {
            navigator.vibrate?.(8);
            beginDrag(s);
          }
        }, TOUCH_HOLD_MS);
      }
      document.addEventListener("pointermove", onMove, { passive: false });
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
    },
    // Stable for the board's lifetime; the handlers read refs only.
    // eslint-disable-next-line react-doctor/exhaustive-deps
    [cleanup],
  );

  /** True once after a press that became a drag: swallow that click. */
  const consumeClick = useCallback(() => {
    if (!consumed.current) return false;
    consumed.current = false;
    return true;
  }, []);

  return { startDrag, consumeClick, draggingId, target };
}

function speed(depth: number): number {
  return Math.min(SCROLL_MAX, Math.ceil((depth / EDGE) * SCROLL_MAX));
}
