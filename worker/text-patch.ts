import { Schema } from "effect";

import type { NodesPatchBody } from "./wire";

import { mergeText } from "../src/data/text-merge";

/**
 * Rebase stale text writes before a PATCH is applied (ADR 0077).
 *
 * A PATCH update may carry `baseText`: the text its new `text` was derived
 * from. When the stored text still equals that base (the overwhelmingly common
 * case: nobody else touched the node), the write applies as before. When the
 * stored text has moved on, another writer changed the node concurrently, and
 * blind last-write-wins would erase their change; instead the writer's change
 * is three-way merged onto the stored text.
 *
 * An update without `baseText` (an older client, or a field edit that is not
 * text) is unchanged: plain last-write-wins, exactly as before this ADR.
 *
 * Pure: the DO passes its current texts in and applies what comes back.
 */

/** One decoded PATCH update, as the Worker's boundary schema produced it. */
export type TextPatchUpdate = (typeof NodesPatchBody.Type)["updates"][number];

const isText = Schema.is(Schema.String);

export interface TextPatchPlan<U extends TextPatchUpdate> {
  updates: U[];
  /** Ids whose write was merged rather than applied verbatim. */
  merged: string[];
  /** Ids whose merge could not place every hunk (best effort was kept). */
  conflicted: string[];
}

export function rebaseTextPatches<U extends TextPatchUpdate>(
  updates: readonly U[],
  currentText: (id: string) => string | undefined,
): TextPatchPlan<U> {
  const merged: string[] = [];
  const conflicted: string[] = [];
  const out = updates.map((u) => {
    const ours = u.changes.text;
    if (!isText(ours) || u.baseText === undefined) return u;
    const current = currentText(u.id);
    if (current === undefined || current === u.baseText) return u;
    const result = mergeText(u.baseText, current, ours);
    if (result.text !== ours) merged.push(u.id);
    if (!result.clean) conflicted.push(u.id);
    return { ...u, changes: { ...u.changes, text: result.text } };
  });
  return { updates: out, merged, conflicted };
}
