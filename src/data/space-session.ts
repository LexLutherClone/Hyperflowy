import { useSyncExternalStore } from "react";

import type { SpaceRole } from "./space-policy";

import { SPACE_ID } from "./outline-scope";
import { canEdit } from "./space-policy";
import { setReadOnlyOutline } from "./tree";

/**
 * The open shared space, when this page is one (ADR 0079): its name and the
 * signed-in person's role. Loaded before the editor mounts (`SpaceGate`), so
 * a view-only role makes the outline read-only from its first render.
 */

export interface SpaceInfo {
  id: string;
  name: string;
  ownerId: string;
}

export type SpaceSession =
  | { status: "personal" }
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error" }
  | { status: "ready"; space: SpaceInfo; role: SpaceRole };

let session: SpaceSession =
  SPACE_ID === null ? { status: "personal" } : { status: "loading" };
const listeners = new Set<() => void>();
let started = false;

function publish(next: SpaceSession) {
  session = next;
  for (const l of listeners) l();
}

async function load(): Promise<void> {
  if (SPACE_ID === null) return;
  try {
    const response = await fetch(`/api/spaces/${encodeURIComponent(SPACE_ID)}`);
    if (response.status === 404) return publish({ status: "missing" });
    if (!response.ok) return publish({ status: "error" });
    // SAFETY: a 2xx from GET /api/spaces/:id carries { space, role }.
    const body = (await response.json()) as {
      space: SpaceInfo;
      role: SpaceRole;
    };
    setReadOnlyOutline(!canEdit(body.role));
    publish({ status: "ready", space: body.space, role: body.role });
  } catch {
    publish({ status: "error" });
  }
}

function subscribe(listener: () => void) {
  if (!started) {
    started = true;
    void load();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSpaceSession(): SpaceSession {
  return useSyncExternalStore(
    subscribe,
    () => session,
    () => session,
  );
}

/** Re-read after the name or access changed. */
export const reloadSpaceSession = load;
