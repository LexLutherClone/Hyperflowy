import { describe, expect, test } from "bun:test";

import {
  canChangeRole,
  canDelete,
  canInvite,
  canManage,
  canRemove,
  canView,
  cleanName,
} from "./workspace-policy";

describe("workspace policy", () => {
  test("any member can view; only admins and the owner manage", () => {
    expect(canView(null)).toBe(false);
    expect(canView("member")).toBe(true);
    expect(canManage("member")).toBe(false);
    expect(canManage("admin")).toBe(true);
    expect(canManage("owner")).toBe(true);
  });

  test("only the owner deletes the workspace", () => {
    expect(canDelete("admin")).toBe(false);
    expect(canDelete("owner")).toBe(true);
  });

  test("invitations grant at most the inviter's own role", () => {
    expect(canInvite("member", "member")).toBe(false);
    expect(canInvite("admin", "member")).toBe(true);
    expect(canInvite("admin", "admin")).toBe(true);
    expect(canInvite("owner", "admin")).toBe(true);
  });

  test("role changes only reach people ranked below you", () => {
    expect(canChangeRole("admin", "member", "admin")).toBe(true);
    expect(canChangeRole("admin", "admin", "member")).toBe(false);
    expect(canChangeRole("owner", "admin", "member")).toBe(true);
    expect(canChangeRole("owner", "owner", "admin")).toBe(false);
    expect(canChangeRole("member", "member", "admin")).toBe(false);
  });

  test("removal: below you, or yourself unless you're the owner", () => {
    expect(canRemove("admin", "member", false)).toBe(true);
    expect(canRemove("admin", "admin", false)).toBe(false);
    expect(canRemove("owner", "admin", false)).toBe(true);
    expect(canRemove("member", "member", true)).toBe(true);
    expect(canRemove("admin", "admin", true)).toBe(true);
    expect(canRemove("owner", "owner", true)).toBe(false);
    expect(canRemove(null, "member", true)).toBe(false);
  });

  test("names are trimmed, collapsed, non-empty, and bounded", () => {
    expect(cleanName("  Design   team ", 80)).toBe("Design team");
    expect(cleanName("   ", 80)).toBeNull();
    expect(cleanName("x".repeat(81), 80)).toBeNull();
  });
});
