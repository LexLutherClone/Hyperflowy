/**
 * The client half of concurrent text merge (ADR 0077): for each node, the
 * server text that the local text was DERIVED from -- its "shadow", in the
 * sense of differential synchronization. The DO merges a PATCH whose shadow
 * (`baseText`) no longer matches the stored text instead of overwriting it,
 * so this value must say exactly what the local edit started from:
 *
 * - **Edit start.** When an editor gains focus it shows the stored text; that
 *   is the base of everything typed until the next send. The board card editor
 *   registers its starting text the same way.
 * - **Send.** Once a write is sent, the server holds (a merge containing) it,
 *   so the next write's change is only what was typed since: the sent text
 *   becomes the shadow.
 * - **Release.** The focused editor ignores echoes (ADR 0010), so while it is
 *   focused its DOM is still derived from the shadow, not from newer server
 *   text: the shadow must outlive those echoes. Once nothing is in flight or
 *   pending for the node and it is not being edited, the shadow is dropped and
 *   the next edit starts from the store, which by then holds server text.
 *
 * Without a shadow the base is the mutation's original value (the store), the
 * right answer for any edit made outside a focused editor.
 */

const shadow = new Map<string, string>();
const inflight = new Map<string, number>();

let isEditing: (id: string) => boolean = () => false;
let hasPending: (id: string) => boolean = () => false;

/** Wire the probes this module needs without importing the editor or the
 *  write lane (both import it). Called once at client start. */
export function configureTextShadow(probes: {
  isEditing: (id: string) => boolean;
  hasPending: (id: string) => boolean;
}): void {
  isEditing = probes.isEditing;
  hasPending = probes.hasPending;
}

/** The base to send with a text write for `id` whose store value before the
 *  edit was `originalText`. */
export function textBaseFor(id: string, originalText: string): string {
  return shadow.get(id) ?? originalText;
}

/** An editor began editing `id` showing `text`. Keeps an existing shadow: if a
 *  write is still in flight, the DOM already contains it. */
export function beginTextEdit(id: string, text: string): void {
  if (!shadow.has(id)) shadow.set(id, text);
}

/** A write carrying `text` for `id` is being sent. */
export function noteTextSent(id: string, text: string): void {
  shadow.set(id, text);
  inflight.set(id, (inflight.get(id) ?? 0) + 1);
}

/** That write settled. A failed write rolls the store back to server text, so
 *  the shadow goes with it. */
export function noteTextSettled(id: string, ok: boolean): void {
  const n = (inflight.get(id) ?? 1) - 1;
  if (n > 0) inflight.set(id, n);
  else inflight.delete(id);
  if (!ok) shadow.delete(id);
  else release(id);
}

/** The server's text for `id` arrived (any writer), or editing of `id` ended. */
export function release(id: string): void {
  if (!shadow.has(id)) return;
  if ((inflight.get(id) ?? 0) > 0) return;
  if (hasPending(id) || isEditing(id)) return;
  shadow.delete(id);
}

/** Test-only reset. */
export function resetTextShadow(): void {
  shadow.clear();
  inflight.clear();
  isEditing = () => false;
  hasPending = () => false;
}

/** Test-only read. */
export function shadowOf(id: string): string | undefined {
  return shadow.get(id);
}
