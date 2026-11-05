import { expect, test } from "bun:test";

import {
  canComment,
  canDeleteComment,
  canEditComment,
  canReadComments,
  cleanCommentBody,
  COMMENT_MAX,
} from "./comments";

const mine = { authorId: "ann" };

test("everyone with access reads; commenters and up write", () => {
  expect(canReadComments(null)).toBe(false);
  expect(canReadComments("viewer")).toBe(true);
  expect(canComment("viewer")).toBe(false);
  expect(canComment("commenter")).toBe(true);
  expect(canComment("editor")).toBe(true);
  expect(canComment("admin")).toBe(true);
});

test("only the author edits; the author or an admin deletes", () => {
  expect(canEditComment("commenter", "ann", mine)).toBe(true);
  expect(canEditComment("admin", "bo", mine)).toBe(false);
  // Downgraded to viewer: can't edit what you wrote.
  expect(canEditComment("viewer", "ann", mine)).toBe(false);
  expect(canDeleteComment("commenter", "ann", mine)).toBe(true);
  expect(canDeleteComment("editor", "bo", mine)).toBe(false);
  expect(canDeleteComment("admin", "bo", mine)).toBe(true);
});

test("bodies are trimmed, non-empty, and bounded", () => {
  expect(cleanCommentBody("  hi  ")).toBe("hi");
  expect(cleanCommentBody("   ")).toBeNull();
  expect(cleanCommentBody("x".repeat(COMMENT_MAX + 1))).toBeNull();
});
