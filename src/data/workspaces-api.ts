import { Option, Schema } from "effect";

import type { GrantableRole, WorkspaceRole } from "./workspace-policy";

/**
 * Browser client for `/api/workspaces` (ADR 0078). Same-origin, so the session
 * cookie and the Origin header the server checks ride along. Every call throws
 * an Error carrying the server's human-readable message on failure.
 */

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: WorkspaceRole;
  memberCount: number;
}

export interface PendingInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: GrantableRole;
  invitedByName: string | null;
  createdAt: number;
}

export interface WorkspaceMember {
  userId: string;
  name: string | null;
  email: string | null;
  role: WorkspaceRole;
  joinedAt: number;
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  memberIds: string[];
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: GrantableRole;
  createdAt: number;
}

export interface WorkspaceDetail {
  workspace: { id: string; name: string; role: WorkspaceRole };
  members: WorkspaceMember[];
  groups: WorkspaceGroup[];
  invites: WorkspaceInvite[];
}

/** The request bodies these routes accept. */
type RequestBody =
  | { name: string }
  | { email: string; role: GrantableRole }
  | { role: GrantableRole }
  | { userIds: string[] };

const ErrorBody = Schema.Struct({ message: Schema.String });

async function request<T>(
  method: string,
  path: string,
  fallback: string,
  body?: RequestBody,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`${fallback} Check your connection and try again.`);
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = Schema.decodeUnknownOption(ErrorBody)(parsed);
    throw new Error(Option.isSome(error) ? error.value.message : fallback);
  }
  // SAFETY: a 2xx from these routes carries the documented JSON body for T.
  return parsed as T;
}

const at = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`;

export const listWorkspaces = () =>
  request<{ workspaces: WorkspaceSummary[]; invites: PendingInvite[] }>(
    "GET",
    "/api/workspaces",
    "Couldn't load your workspaces.",
  );

export const createWorkspace = (name: string) =>
  request<{ workspace: WorkspaceSummary }>(
    "POST",
    "/api/workspaces",
    "Couldn't create the workspace.",
    { name },
  );

export const getWorkspace = (id: string) =>
  request<WorkspaceDetail>("GET", at(id), "Couldn't load the workspace.");

export const renameWorkspace = (id: string, name: string) =>
  request("PATCH", at(id), "Couldn't rename the workspace.", { name });

export const deleteWorkspace = (id: string) =>
  request("DELETE", at(id), "Couldn't delete the workspace.");

export const invite = (id: string, email: string, role: GrantableRole) =>
  request<{ invite: WorkspaceInvite }>(
    "POST",
    `${at(id)}/invites`,
    "Couldn't send the invitation.",
    { email, role },
  );

export const revokeInvite = (id: string, inviteId: string) =>
  request(
    "DELETE",
    `${at(id)}/invites/${encodeURIComponent(inviteId)}`,
    "Couldn't revoke the invitation.",
  );

export const setRole = (id: string, userId: string, role: GrantableRole) =>
  request(
    "PATCH",
    `${at(id)}/members/${encodeURIComponent(userId)}`,
    "Couldn't change the role.",
    { role },
  );

export const removeMember = (id: string, userId: string) =>
  request(
    "DELETE",
    `${at(id)}/members/${encodeURIComponent(userId)}`,
    "Couldn't remove that person.",
  );

export const createGroup = (id: string, name: string) =>
  request<{ group: WorkspaceGroup }>(
    "POST",
    `${at(id)}/groups`,
    "Couldn't create the group.",
    { name },
  );

export const renameGroup = (id: string, groupId: string, name: string) =>
  request(
    "PATCH",
    `${at(id)}/groups/${encodeURIComponent(groupId)}`,
    "Couldn't rename the group.",
    { name },
  );

export const deleteGroup = (id: string, groupId: string) =>
  request(
    "DELETE",
    `${at(id)}/groups/${encodeURIComponent(groupId)}`,
    "Couldn't delete the group.",
  );

export const setGroupMembers = (
  id: string,
  groupId: string,
  userIds: string[],
) =>
  request(
    "PUT",
    `${at(id)}/groups/${encodeURIComponent(groupId)}/members`,
    "Couldn't update the group.",
    { userIds },
  );

export const acceptInvite = (inviteId: string) =>
  request<{ workspaceId: string }>(
    "POST",
    `/api/workspace-invites/${encodeURIComponent(inviteId)}/accept`,
    "Couldn't join the workspace.",
  );

export const declineInvite = (inviteId: string) =>
  request(
    "POST",
    `/api/workspace-invites/${encodeURIComponent(inviteId)}/decline`,
    "Couldn't decline the invitation.",
  );
