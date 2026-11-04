import DiffMatchPatch from "diff-match-patch";

/**
 * Three-way merge of one node's text (ADR 0077). Shared by the Durable Object,
 * which merges a PATCH whose base is stale, and by the browser, which uses the
 * same function so both sides agree on what "merged" means.
 *
 * `base` is the text the writer's edit was derived from, `current` is what the
 * server holds now, and `ours` is the writer's new text. The writer's change
 * (base -> ours) is re-applied to `current` as diff-match-patch patches, which
 * locate each hunk by its surrounding context, so an edit lands in the right
 * place even after someone else changed text before it.
 *
 * Never loses the other writer's change silently: when a hunk cannot be placed
 * (its context is gone, e.g. both sides rewrote the same words), the merge
 * still applies every hunk that does fit and reports `clean: false`. The DO
 * keeps that best-effort text rather than reverting to plain last-write-wins.
 */

export interface TextMergeResult {
  text: string;
  /** False when one or more of `ours`'s hunks could not be placed. */
  clean: boolean;
}

let dmp: DiffMatchPatch | null = null;
function engine(): DiffMatchPatch {
  if (dmp) return dmp;
  dmp = new DiffMatchPatch();
  // Node texts are short; never give up on a diff for time.
  dmp.Diff_Timeout = 0;
  // Context must match closely: a hunk that only half-matches is a conflict,
  // not a guess. (Defaults: 0.5 / 1000 / 0.5.)
  dmp.Match_Threshold = 0.35;
  dmp.Match_Distance = 200;
  dmp.Patch_DeleteThreshold = 0.35;
  return dmp;
}

export function mergeText(
  base: string,
  current: string,
  ours: string,
): TextMergeResult {
  // The trivial cases are exact, and cover almost every write.
  if (current === base || current === ours) return { text: ours, clean: true };
  if (ours === base) return { text: current, clean: true };
  const d = engine();
  const diffs = d.diff_main(base, ours);
  d.diff_cleanupSemantic(diffs);
  const patches = d.patch_make(base, diffs);
  const [text, applied] = d.patch_apply(patches, current);
  return { text, clean: applied.every(Boolean) };
}
