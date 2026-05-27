// Tiny CSRF-aware fetch wrapper used by the super-admin pages.
//
// The API enforces double-submit CSRF on POST/PUT/PATCH/DELETE
// (apps/api/src/middleware/csrf.ts). The token lives in the non-httpOnly
// `medcore_csrf` cookie minted at login; this helper reads it and
// echoes it into the `X-CSRF-Token` header. `credentials: "include"` is
// always set so the httpOnly auth cookies travel with the request.

const CSRF_COOKIE = "medcore_csrf";

function isMutationMethod(method: string): boolean {
  return (
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
  );
}

function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + CSRF_COOKIE + "=([^;]+)"),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

export function csrfFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  if (isMutationMethod(method)) {
    const token = readCsrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }
  return fetch(input, {
    ...init,
    credentials: init?.credentials ?? "include",
    headers,
  });
}
