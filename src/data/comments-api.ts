import { Option, Schema } from "effect";

import type { Comment, CommentSummary, ThreadView } from "./comments";

import { SPACE_ID } from "./outline-scope";

/**
 * Browser client for the open space's comments (ADR 0081). Only meaningful on
 * a shared-note page; every call throws an Error with the server's message.
 */

type RequestBody =
  | { nodeId: string; body: string }
  | { body: string }
  | { resolved: boolean };

const ErrorBody = Schema.Struct({ message: Schema.String });

function base(): string {
  if (SPACE_ID === null)
    throw new Error("Comments exist only in shared notes.");
  return `/api/spaces/${encodeURIComponent(SPACE_ID)}/comments`;
}

async function request<T>(
  method: string,
  path: string,
  fallback: string,
  body?: RequestBody,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base()}${path}`, {
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

export const commentSummary = () =>
  request<{ summary: CommentSummary[] }>("GET", "", "Couldn't load comments.");

export const thread = (nodeId: string) =>
  request<ThreadView>(
    "GET",
    `?nodeId=${encodeURIComponent(nodeId)}`,
    "Couldn't load comments.",
  );

export const addComment = (nodeId: string, body: string) =>
  request<{ comment: Comment }>("POST", "", "Couldn't post your comment.", {
    nodeId,
    body,
  });

export const editComment = (id: string, body: string) =>
  request("PATCH", `/${encodeURIComponent(id)}`, "Couldn't save your edit.", {
    body,
  });

export const deleteComment = (id: string) =>
  request(
    "DELETE",
    `/${encodeURIComponent(id)}`,
    "Couldn't delete the comment.",
  );

export const setResolved = (nodeId: string, resolved: boolean) =>
  request(
    "PUT",
    `/threads/${encodeURIComponent(nodeId)}`,
    "Couldn't update the thread.",
    { resolved },
  );

export interface SpacePerson {
  /** Opaque account id, carried by a mention. */
  id: string;
  name: string;
}

/** Who can be mentioned in the open space, by name (commenters and up). */
export async function people(): Promise<SpacePerson[]> {
  if (SPACE_ID === null) return [];
  const response = await fetch(
    `/api/spaces/${encodeURIComponent(SPACE_ID)}/people`,
  );
  if (!response.ok) return [];
  // SAFETY: a 2xx from GET /api/spaces/:id/people carries { people }.
  const body = (await response.json()) as { people: SpacePerson[] };
  return body.people;
}
