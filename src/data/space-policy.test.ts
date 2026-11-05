import { expect, test } from "bun:test";

import { canEdit, canRead, canShare, highestRole } from "./space-policy";

test("the highest grant wins", () => {
  expect(highestRole([])).toBeNull();
  expect(highestRole(["viewer", "editor", "commenter"])).toBe("editor");
  expect(highestRole(["admin", "viewer"])).toBe("admin");
});

test("each role includes the one before it", () => {
  expect([canRead(null), canEdit(null), canShare(null)]).toEqual([
    false,
    false,
    false,
  ]);
  expect([canRead("viewer"), canEdit("viewer")]).toEqual([true, false]);
  // Commenters can't edit content; comments arrive in a later milestone.
  expect(canEdit("commenter")).toBe(false);
  expect([canEdit("editor"), canShare("editor")]).toEqual([true, false]);
  expect(canShare("admin")).toBe(true);
});
