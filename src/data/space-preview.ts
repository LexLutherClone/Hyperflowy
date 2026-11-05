import { Schema } from "effect";
import { useCallback, useSyncExternalStore } from "react";

import type { Node } from "./schema";
import type { SpaceRole } from "./space-policy";

import { type ServerMessage, ServerMessageSchema } from "./wire-schema";

/**
 * Live, read-only previews of shared notes inside your own outline
 * (ADR 0080). One WebSocket per previewed space, shared by every row showing
 * it, opened when the first row mounts and closed when the last unmounts. It
 * speaks the outline sync protocol (`hello` -> `snapshot`, then `change`
 * frames) against `/api/spaces/<id>/sync`, the same role-checked endpoint the
 * space's own page uses (ADR 0079), and writes nothing.
 *
 * Deliberately separate from `nodesCollection`: the editor's data layer is
 * one outline per page, and a preview must never feed the tree store, undo
 * history, or a write path.
 */

export type SpacePreviewState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error" }
  | {
      status: "ready";
      name: string;
      role: SpaceRole;
      nodes: Node[];
    };

const LOADING: SpacePreviewState = { status: "loading" };
const decodeMessage = Schema.decodeUnknownOption(ServerMessageSchema);

/** One inbound frame, validated against the shared sync schema; null drops it. */
function decodeFrame(data: string): ServerMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const decoded = decodeMessage(raw);
  return decoded._tag === "Some" ? decoded.value : null;
}
const RETRY_MS = [1000, 3000, 8000, 20000];

class PreviewConnection {
  state: SpacePreviewState = LOADING;
  readonly listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private nodes = new Map<string, Node>();
  private meta: { name: string; role: SpaceRole } | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(readonly spaceId: string) {
    void this.open();
  }

  private publish(next: SpacePreviewState) {
    this.state = next;
    for (const l of this.listeners) l();
  }

  private publishNodes() {
    if (!this.meta) return;
    this.publish({
      status: "ready",
      ...this.meta,
      nodes: [...this.nodes.values()],
    });
  }

  /** Look the space up (name, role, still shared?), then connect. */
  private async open() {
    if (this.closed) return;
    try {
      const response = await fetch(
        `/api/spaces/${encodeURIComponent(this.spaceId)}`,
      );
      if (this.closed) return;
      if (response.status === 404) return this.publish({ status: "missing" });
      if (!response.ok) return this.retry();
      // SAFETY: a 2xx from GET /api/spaces/:id carries { space, role }.
      const body = (await response.json()) as {
        space: { name: string };
        role: SpaceRole;
      };
      this.meta = { name: body.space.name, role: body.role };
    } catch {
      return this.retry();
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${window.location.host}/api/spaces/${encodeURIComponent(this.spaceId)}/sync`,
    );
    this.socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", since: null }));
    ws.onmessage = (event) => {
      // The DO only sends text frames.
      const msg = decodeFrame(String(event.data));
      if (!msg) return;
      if (msg.type === "snapshot") {
        this.attempts = 0;
        this.nodes = new Map(msg.nodes.map((n) => [n.id, n]));
      } else {
        const frames = msg.type === "change" ? [msg] : msg.changes;
        for (const f of frames)
          for (const op of f.ops) {
            if (op.op === "delete") this.nodes.delete(op.key);
            else this.nodes.set(op.value.id, op.value);
          }
      }
      this.publishNodes();
    };
    // Access changed (4001), the network dropped, or the upgrade was refused:
    // look the space up again before reconnecting, so a revoked share turns
    // into "missing" instead of a reconnect loop.
    ws.onclose = () => {
      if (this.socket === ws) this.socket = null;
      if (!this.closed) this.retry();
    };
  }

  private retry() {
    if (this.closed || this.timer) return;
    const delay = RETRY_MS[this.attempts];
    if (delay === undefined) return this.publish({ status: "error" });
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.open();
    }, delay);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }
}

const connections = new Map<
  string,
  { conn: PreviewConnection; refs: number }
>();

function acquire(spaceId: string): PreviewConnection {
  let entry = connections.get(spaceId);
  if (!entry) {
    entry = { conn: new PreviewConnection(spaceId), refs: 0 };
    connections.set(spaceId, entry);
  }
  entry.refs += 1;
  return entry.conn;
}

function release(spaceId: string): void {
  const entry = connections.get(spaceId);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.conn.close();
  connections.delete(spaceId);
}

/**
 * The live preview of `spaceId`, or null to stay disconnected (off screen,
 * or not a space link). The subscription IS the connection's lifetime: the
 * first subscriber opens it, the last one closes it.
 */
export function useSpacePreview(spaceId: string | null): SpacePreviewState {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (spaceId === null) return () => {};
      const conn = acquire(spaceId);
      conn.listeners.add(listener);
      listener();
      return () => {
        conn.listeners.delete(listener);
        release(spaceId);
      };
    },
    [spaceId],
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      spaceId === null
        ? LOADING
        : (connections.get(spaceId)?.conn.state ?? LOADING),
    () => LOADING,
  );
}
