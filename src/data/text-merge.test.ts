import { describe, expect, test } from "bun:test";

import { mergeText } from "./text-merge";

describe("mergeText", () => {
  test("no concurrent change: ours wins exactly", () => {
    expect(mergeText("abc", "abc", "abcd")).toEqual({
      text: "abcd",
      clean: true,
    });
  });

  test("we changed nothing: the server text stands", () => {
    expect(mergeText("abc", "Xabc", "abc")).toEqual({
      text: "Xabc",
      clean: true,
    });
  });

  test("both sides already agree", () => {
    expect(mergeText("a", "ab", "ab")).toEqual({ text: "ab", clean: true });
  });

  test("edits in different places both survive", () => {
    const base = "Buy milk and bread";
    const current = "Buy oat milk and bread"; // someone else
    const ours = "Buy milk and bread tomorrow"; // us
    expect(mergeText(base, current, ours)).toEqual({
      text: "Buy oat milk and bread tomorrow",
      clean: true,
    });
  });

  test("our append lands after their prepend (the typing-race case)", () => {
    expect(
      mergeText("Draft spec", "TODO Draft spec", "Draft spec v2").text,
    ).toBe("TODO Draft spec v2");
  });

  test("our deletion applies to the text they changed elsewhere", () => {
    const base = "one two three four";
    const current = "one two three four five";
    const ours = "one three four";
    expect(mergeText(base, current, ours)).toEqual({
      text: "one three four five",
      clean: true,
    });
  });

  test("markdown tokens survive a concurrent edit", () => {
    const base = "Read [[Plan]] #work";
    const current = "Read [[Plan]] #work #urgent";
    const ours = "Re-read [[Plan]] #work";
    expect(mergeText(base, current, ours).text).toBe(
      "Re-read [[Plan]] #work #urgent",
    );
  });

  test("inserts at the same spot keep both", () => {
    const merged = mergeText("ab", "aYb", "aXb").text;
    expect(merged.length).toBe(4);
    expect(merged).toContain("X");
    expect(merged).toContain("Y");
  });

  test("a rewrite of words they deleted is reported, and their change is kept", () => {
    const base = "meeting at 3pm";
    const current = "call"; // they replaced the whole thing
    const ours = "meeting at 4pm"; // we changed a word that no longer exists
    const result = mergeText(base, current, ours);
    expect(result.clean).toBe(false);
    expect(result.text).toContain("call");
  });

  test("is deterministic", () => {
    const args = [
      "The quick fox",
      "The quick brown fox",
      "A quick fox!",
    ] as const;
    expect(mergeText(...args)).toEqual(mergeText(...args));
  });
});
