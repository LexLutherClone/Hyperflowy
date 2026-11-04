import { beforeEach, expect, test } from "bun:test";

import { mergeText } from "./text-merge";
import {
  beginTextEdit,
  configureTextShadow,
  noteTextSent,
  noteTextSettled,
  release,
  resetTextShadow,
  shadowOf,
  textBaseFor,
} from "./text-shadow";

let editing = new Set<string>();
let pending = new Set<string>();
beforeEach(() => {
  resetTextShadow();
  editing = new Set();
  pending = new Set();
  configureTextShadow({
    isEditing: (id) => editing.has(id),
    hasPending: (id) => pending.has(id),
  });
});

test("without a shadow the base is the store's value", () => {
  expect(textBaseFor("a", "stored")).toBe("stored");
});

test("the base of a second write is the first write, not the server echo", () => {
  editing.add("a");
  beginTextEdit("a", "Draft");
  expect(textBaseFor("a", "Draft")).toBe("Draft");
  noteTextSent("a", "Draft s");
  noteTextSettled("a", true);
  // Someone else prepends; the echo lands in the store, but the focused DOM
  // ignores it (ADR 0010), so local typing is still derived from "Draft s".
  release("a");
  expect(textBaseFor("a", "TODO Draft s")).toBe("Draft s");
});

test("the end-to-end typing race keeps both edits", () => {
  // Server: "Draft". We type " spec" in two sends while they prepend "TODO ".
  let server = "Draft";
  editing.add("a");
  beginTextEdit("a", "Draft");

  const send = (ours: string, original: string) => {
    const base = textBaseFor("a", original);
    noteTextSent("a", ours);
    server = mergeText(base, server, ours).text;
    noteTextSettled("a", true);
  };

  send("Draft sp", "Draft");
  server = mergeText(server, server, "TODO " + server).text; // their write
  release("a"); // their echo arrives while we're focused
  send("Draft spec", "TODO Draft sp"); // store already shows their echo
  expect(server).toBe("TODO Draft spec");
});

test("the shadow is released only when idle and not being edited", () => {
  editing.add("a");
  beginTextEdit("a", "x");
  noteTextSent("a", "xy");
  release("a");
  expect(shadowOf("a")).toBe("xy"); // in flight
  noteTextSettled("a", true);
  expect(shadowOf("a")).toBe("xy"); // still focused
  editing.delete("a");
  pending.add("a");
  release("a");
  expect(shadowOf("a")).toBe("xy"); // pending write
  pending.delete("a");
  release("a");
  expect(shadowOf("a")).toBeUndefined();
});

test("a failed write drops the shadow with the rollback", () => {
  editing.add("a");
  beginTextEdit("a", "x");
  noteTextSent("a", "xy");
  noteTextSettled("a", false);
  expect(shadowOf("a")).toBeUndefined();
});

test("beginning an edit keeps a shadow that is still in flight", () => {
  noteTextSent("a", "sent");
  beginTextEdit("a", "store");
  expect(textBaseFor("a", "store")).toBe("sent");
});
