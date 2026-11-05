/// <reference types="@cloudflare/workers-types" />

import { Data, Effect, Schema } from "effect";

/**
 * JSON plumbing shared by the account-scoped D1 APIs (workspaces, spaces):
 * one error type mapped to `{ error, message }`, same-origin checks for
 * writes, bounded JSON bodies decoded against Effect Schema with excess
 * properties rejected, and path segments.
 */

export class ApiHttpError extends Data.TaggedError("ApiHttpError")<{
  status: number;
  error: string;
  message: string;
}> {}

export const fail = (status: number, error: string, message: string) =>
  new ApiHttpError({ status, error, message });

export function json<T>(value: T, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/** Map an `ApiHttpError` to its JSON response. */
export const respond = <R>(program: Effect.Effect<Response, ApiHttpError, R>) =>
  program.pipe(
    Effect.catchTag("ApiHttpError", (error) =>
      Effect.succeed(
        json({ error: error.error, message: error.message }, error.status),
      ),
    ),
  );

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY = 16_384;

export const decodeBody = <S extends Schema.Top>(request: Request, schema: S) =>
  Effect.gen(function* () {
    if (
      !/^application\/json(?:;|$)/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      return yield* Effect.fail(
        fail(415, "invalid_content_type", "Send JSON."),
      );
    const text = yield* Effect.tryPromise({
      try: async () => {
        const reader = request.body?.getReader();
        if (!reader) return "";
        let length = 0;
        let text = "";
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_BODY)
              throw fail(413, "input_too_large", "The request is too large.");
            text += decoder.decode(value, { stream: true });
          }
          return text + decoder.decode();
        } finally {
          await reader.cancel();
        }
      },
      catch: (error) =>
        error instanceof ApiHttpError
          ? error
          : fail(400, "invalid_body", "Couldn't read the request."),
    });
    const raw = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: () => fail(400, "invalid_body", "Send a valid JSON body."),
    });
    return yield* Schema.decodeUnknownEffect(schema, {
      onExcessProperty: "error",
    })(raw).pipe(
      Effect.mapError(() =>
        fail(400, "invalid_input", "Check the request and try again."),
      ),
    );
  });

export function sameOrigin(
  request: Request,
  env: { BETTER_AUTH_URL?: string; BETTER_AUTH_TRUSTED_ORIGINS?: string },
): boolean {
  const origins = new Set([
    new URL(request.url).origin,
    ...(env.BETTER_AUTH_URL ? [new URL(env.BETTER_AUTH_URL).origin] : []),
    ...(env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",").map((o) => o.trim()) ?? []),
  ]);
  return origins.has(request.headers.get("origin") ?? "");
}

/** `/api/<root>/...` path segments after `/api`, URI-decoded. */
export function segments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .slice(1)
    .map((s) => decodeURIComponent(s));
}
