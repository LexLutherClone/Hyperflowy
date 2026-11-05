import { useCallback, useSyncExternalStore } from "react";

import type { CommentSummary } from "./comments";

import { commentSummary } from "./comments-api";
import { SPACE_ID } from "./outline-scope";

/**
 * Per-bullet comment counts for the open shared note (ADR 0081), for the row
 * badges. Loaded on first use, refreshed every 30 seconds while the page is
 * visible, and right after you comment. On your own outline it's always empty.
 */

const REFRESH_MS = 30_000;
let summary = new Map<string, CommentSummary>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export async function refreshCommentCounts(): Promise<void> {
  if (SPACE_ID === null) return;
  try {
    const next = await commentSummary();
    summary = new Map(next.summary.map((s) => [s.nodeId, s]));
    for (const l of listeners) l();
  } catch {
    // Keep the last counts; the next refresh tries again.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (SPACE_ID !== null && timer === null) {
    void refreshCommentCounts();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshCommentCounts();
    }, REFRESH_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The bullet's comment summary, or null when it has none. */
export function useCommentSummary(nodeId: string): CommentSummary | null {
  const get = useCallback(() => summary.get(nodeId) ?? null, [nodeId]);
  return useSyncExternalStore(subscribe, get, () => null);
}
