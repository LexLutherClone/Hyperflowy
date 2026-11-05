import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { Node } from "../data/schema";

import { flattenNodeText } from "../data/node-links";
import { SPACE_ID } from "../data/outline-scope";
import { canEdit } from "../data/space-policy";
import * as spaces from "../data/spaces-api";
import { childrenOf, type TreeIndex } from "../data/tree";
import { getTreeIndex } from "../data/tree-store";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";

/**
 * Copy or move bullets between your outline and shared notes (ADR 0083): the
 * sanctioned way to bring private content into a share, since a mirror never
 * can (ADR 0076). On your outline it copies or moves into a shared note you
 * can edit; on a shared note it copies into your outline.
 */

const MAX_ROWS = 300;

interface Row {
  node: Node;
  depth: number;
}

function subtreeRows(index: TreeIndex, rootId: string): Row[] {
  const rows: Row[] = [];
  const walk = (parentId: string, depth: number) => {
    for (const child of childrenOf(index, parentId)) {
      if (rows.length >= MAX_ROWS) return;
      rows.push({ node: child, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(rootId, 0);
  return rows;
}

export function CopyDialog({
  rootId,
  onClose,
}: {
  rootId: string;
  onClose: () => void;
}) {
  const toMine = SPACE_ID !== null;
  const index = getTreeIndex();
  const root = index.byId.get(rootId);
  const rows = subtreeRows(index, rootId);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [targets, setTargets] = useState<spaces.SpaceSummary[] | null>(
    toMine ? [] : null,
  );
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<"copy" | "move">("copy");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (toMine) return;
    void spaces
      .listSpaces()
      .then(({ spaces: all }) => {
        const editable = all.filter((s) => canEdit(s.role));
        setTargets(editable);
        setTarget((t) => t || editable[0]?.id || "");
      })
      .catch(() => setTargets([]));
  }, [toMine]);

  // A row is dropped when it, or a bullet above it, is unticked.
  const parentOf = (id: string) => index.byId.get(id)?.parentId ?? null;
  const dropped = (id: string): boolean => {
    for (
      let cur: string | null = id;
      cur && cur !== rootId;
      cur = parentOf(cur)
    )
      if (excluded.has(cur)) return true;
    return false;
  };

  const submit = async () => {
    setBusy(true);
    try {
      const exclude = [...excluded];
      if (toMine) {
        const { count } = await spaces.copyOutOfSpace(
          SPACE_ID!,
          rootId,
          exclude,
        );
        toast.success(
          `Copied ${count} ${count === 1 ? "bullet" : "bullets"} to your outline`,
        );
      } else {
        const { count, removed } = await spaces.copyIntoSpace(
          target,
          rootId,
          exclude,
          mode,
        );
        const name = targets?.find((t) => t.id === target)?.name ?? "the note";
        if (mode === "move" && !removed)
          toast.warning(
            `Copied ${count} bullets to ${name}, but the originals stayed in your outline.`,
          );
        else
          toast.success(
            `${mode === "move" ? "Moved" : "Copied"} ${count} ${count === 1 ? "bullet" : "bullets"} to ${name}`,
            {
              action: {
                label: "Open",
                onClick: () =>
                  window.location.assign(`/s/${encodeURIComponent(target)}`),
              },
            },
          );
      }
      onClose();
    } catch (error) {
      if (error instanceof Error) toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const showTree = toMine || mode === "copy";
  const title = root ? flattenNodeText(index, root.text) || "Untitled" : "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {toMine ? "Copy to my outline" : "Copy or move to a shared note"}
          </DialogTitle>
          <DialogDescription>
            {toMine
              ? `“${title}” and the bullets you tick are copied to the end of your outline.`
              : "Copies are independent: mirrors become plain bullets, so nothing private stays linked."}
          </DialogDescription>
        </DialogHeader>
        {!toMine && targets !== null && targets.length === 0 && (
          <p className="text-sm text-muted-foreground">
            You can't edit any shared notes yet. Share a page, or ask to be made
            an editor.
          </p>
        )}
        {!toMine && targets !== null && targets.length > 0 && (
          <div className="flex flex-col gap-3">
            <NativeSelect
              aria-label="Shared note"
              className="w-full"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {targets.map((t) => (
                <NativeSelectOption key={t.id} value={t.id}>
                  {t.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <div
              role="radiogroup"
              aria-label="Copy or move"
              className="flex gap-4 text-sm"
            >
              {(["copy", "move"] as const).map((m) => (
                <label key={m} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="copy-mode"
                    checked={mode === m}
                    onChange={() => setMode(m)}
                  />
                  {m === "copy"
                    ? "Copy"
                    : "Move (removes it from your outline)"}
                </label>
              ))}
            </div>
          </div>
        )}
        {showTree && rows.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Bring along</p>
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-lg p-2 ring-1 ring-foreground/10">
              {rows.map(({ node, depth }) => {
                const gone = dropped(node.id);
                const disabled = gone && !excluded.has(node.id);
                return (
                  <li
                    key={node.id}
                    data-copy-row={node.id}
                    style={{ paddingInlineStart: `${depth * 16}px` }}
                  >
                    <label
                      className={`flex items-center gap-2 text-sm ${disabled ? "text-muted-foreground" : ""}`}
                    >
                      <Checkbox
                        checked={!gone}
                        disabled={disabled}
                        aria-label={`Bring along ${flattenNodeText(index, node.text) || "Untitled"}`}
                        onCheckedChange={(on) =>
                          setExcluded((prev) => {
                            const next = new Set(prev);
                            if (on) next.delete(node.id);
                            else next.add(node.id);
                            return next;
                          })
                        }
                      />
                      <span className="truncate">
                        {flattenNodeText(index, node.text) || "Untitled"}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {!showTree && (
          <p className="text-sm text-muted-foreground">
            Moving takes “{title}” and everything under it.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || (!toMine && !target)}
            onClick={() => void submit()}
          >
            {toMine ? "Copy" : mode === "move" ? "Move" : "Copy"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
