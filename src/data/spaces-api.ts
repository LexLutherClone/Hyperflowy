import { Option, Schema } from "effect";

import type { SpaceRole } from "./space-policy";

/**
 * Browser client for `/api/spaces` (ADR 0079). Throws an Error carrying the
 * server's human-readable message on failure.
 */

export interface SpaceSummary {
  id: string;
  name: string;
  role: SpaceRole;
  ownerId: string;
  ownerName: string | null;
}

export interface SpaceGrant {
  granteeType: "email" | "group";
  granteeId: string;
  role: SpaceRole;
  label: string;
}

export interface SpaceDetail {
  space: { id: string; name: string; ownerId: string };
  role: SpaceRole;
  grants: SpaceGrant[];
}

type RequestBody =
  | { nodeId: string }
  | { name: string }
  | { granteeType: "email"; email: string; role: SpaceRole }
  | { granteeType: "group"; groupId: string; role: SpaceRole }
  | { granteeType: "email" | "group"; granteeId: string };

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

const at = (id: string) => `/api/spaces/${encodeURIComponent(id)}`;

export const listSpaces = () =>
  request<{ spaces: SpaceSummary[] }>(
    "GET",
    "/api/spaces",
    "Couldn't load your shared notes.",
  );

/** Share a bullet of your outline as a new space. */
export const shareNode = (nodeId: string) =>
  request<{
    space: { id: string; name: string; url: string };
    replaced: boolean;
  }>("POST", "/api/spaces", "Couldn't share that bullet.", { nodeId });

export const getSpaceDetail = (id: string) =>
  request<SpaceDetail>("GET", at(id), "Couldn't load who has access.");

export const renameSpace = (id: string, name: string) =>
  request("PATCH", at(id), "Couldn't rename the shared note.", { name });

export const grantEmail = (id: string, email: string, role: SpaceRole) =>
  request("PUT", `${at(id)}/grants`, "Couldn't share with that person.", {
    granteeType: "email",
    email,
    role,
  });

export const grantGroup = (id: string, groupId: string, role: SpaceRole) =>
  request("PUT", `${at(id)}/grants`, "Couldn't share with that group.", {
    granteeType: "group",
    groupId,
    role,
  });

export const revokeGrant = (
  id: string,
  granteeType: "email" | "group",
  granteeId: string,
) =>
  request("DELETE", `${at(id)}/grants`, "Couldn't remove access.", {
    granteeType,
    granteeId,
  });
