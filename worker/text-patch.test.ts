import { expect, test } from "bun:test";

import { rebaseTextPatches } from "./text-patch";

const store = (texts: Record<string, string>) => (id: string) => texts[id];

test("a write whose base matches the stored text applies verbatim", () => {
  const plan = rebaseTextPatches(
    [{ id: "a", changes: { text: "abcd" }, baseText: "abc" }],
    store({ a: "abc" }),
  );
  expect(plan.updates[0]!.changes.text).toBe("abcd");
  expect(plan.merged).toEqual([]);
});

test("a stale base is merged onto the stored text instead of overwriting it", () => {
  const plan = rebaseTextPatches(
    [{ id: "a", changes: { text: "Draft spec v2" }, baseText: "Draft spec" }],
    store({ a: "TODO Draft spec" }),
  );
  expect(plan.updates[0]!.changes.text).toBe("TODO Draft spec v2");
  expect(plan.merged).toEqual(["a"]);
  expect(plan.conflicted).toEqual([]);
});

test("no base means last-write-wins, exactly as before", () => {
  const plan = rebaseTextPatches(
    [{ id: "a", changes: { text: "mine" } }],
    store({ a: "theirs" }),
  );
  expect(plan.updates[0]!.changes.text).toBe("mine");
});

test("non-text changes and unknown nodes pass through untouched", () => {
  const updates = [
    { id: "a", changes: { completed: true }, baseText: "x" },
    { id: "gone", changes: { text: "y" }, baseText: "x" },
  ];
  const plan = rebaseTextPatches(updates, store({ a: "z" }));
  expect(plan.updates).toEqual(updates);
});

test("other fields in the same update are kept alongside the merged text", () => {
  const plan = rebaseTextPatches(
    [
      {
        id: "a",
        changes: { text: "one two!", updatedAt: 5 },
        baseText: "one two",
      },
    ],
    store({ a: "zero one two" }),
  );
  expect(plan.updates[0]!.changes).toEqual({
    text: "zero one two!",
    updatedAt: 5,
  });
});

test("an unplaceable hunk is reported as a conflict, keeping their text", () => {
  const plan = rebaseTextPatches(
    [
      {
        id: "a",
        changes: { text: "meeting at 4pm" },
        baseText: "meeting at 3pm",
      },
    ],
    store({ a: "call" }),
  );
  expect(plan.conflicted).toEqual(["a"]);
  expect(plan.updates[0]!.changes.text).toContain("call");
});
