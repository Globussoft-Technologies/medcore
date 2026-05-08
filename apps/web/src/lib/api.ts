import { toast } from "@/lib/toast";
import { sanitizeNextPath } from "@/lib/utils";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";

interface FetchOptions extends RequestInit {
  token?: string;
}

// Issue #477 (May 2026): JWTs moved from localStorage → httpOnly cookies
// (`medcore_at`, `medcore_rt`) so XSS can no longer exfiltrate them.
// The server also sets a non-httpOnly `medcore_csrf` cookie that we
// echo back as `X-CSRF-Token` on every mutation — that's the
// double-submit defence, since cookies auto-attach.
//
// Read with a regex rather than splitting `document.cookie` so commas
// in non-cookie text (extensions, polyfills) can't desync the parse.
const CSRF_COOKIE = "medcore_csrf";
function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + CSRF_COOKIE + "=([^;]+)"),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

const MUTATION_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Issues #101 + #132: centralised 401 handling.
 *
 * When ANY API call returns 401 (token expired, revoked, or never issued)
 * we:
 *   1. Clear the stored auth tokens so subsequent calls don't keep failing.
 *   2. Show a friendly toast instead of leaving the user staring at a blank
 *      page after a navigate.
 *   3. Redirect to /login (preserving the current path as ?next= so the
 *      user lands back where they were after re-authenticating).
 *
 * Idempotent — only fires once per page lifecycle so a burst of parallel
 * 401s doesn't spam the user with toasts.
 *
 * Routes that legitimately probe with possibly-bad tokens (loadSession,
 * /auth/me) can opt out by passing `{ skip401Redirect: true }`.
 */
let authExpiredHandled = false;
function handleAuthExpired(): void {
  if (authExpiredHandled) return;
  authExpiredHandled = true;
  if (typeof window === "undefined") return;
  try {
    // Issue #477: cookies are cleared by the server's logout/refresh
    // flow; this localStorage cleanup is for users who still had the
    // pre-#477 keys around at deploy time (force-logout migration).
    localStorage.removeItem("medcore_token");
    localStorage.removeItem("medcore_refresh");
  } catch {
    // localStorage may be unavailable in private mode — best-effort.
  }
  toast.error("Your session has expired, please sign in again.", 6000);
  // Avoid redirecting if we're already on /login — prevents a loop when the
  // login form itself returns a 401 for bad credentials.
  const here = window.location.pathname;
  if (here.startsWith("/login") || here.startsWith("/register")) return;
  // Lane A (commit f1de292) mirror: sanitize the next-path even on the
  // outbound side. The current URL is by construction a same-origin path,
  // but threading it through the same helper the API uses guards against
  // any future call site that might pass a tainted string here.
  const safe = sanitizeNextPath(here + window.location.search);
  const next = encodeURIComponent(safe);
  // Use replace() so the protected page isn't in history (back button
  // shouldn't take the user to a route that just bounced them).
  window.location.replace(`/login?next=${next}`);
}

/** Test-only — reset the once-per-pageload latch. */
export function __resetAuthExpiredLatchForTests(): void {
  authExpiredHandled = false;
}

interface RequestOptions extends FetchOptions {
  /**
   * Skip the 401 redirect-and-toast for endpoints that legitimately probe
   * with a possibly-stale token (e.g. /auth/me on app boot). The 401 is
   * still surfaced to the caller as a thrown Error so per-call handling
   * still works.
   */
  skip401Redirect?: boolean;
  /**
   * Issue #377 (2026-04-26): per-call timeout in milliseconds. The
   * Complaints submit was hanging indefinitely when the API took an
   * unusually long Prisma path (no client-side time limit). Callers can
   * pass a custom budget; otherwise we apply a 30s default for any
   * mutation so the spinner doesn't spin forever on a server-side
   * stall — the user gets a "Request timed out" toast they can retry.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

async function request<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const {
    token,
    headers: customHeaders,
    skip401Redirect,
    timeoutMs,
    ...rest
  } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((customHeaders as Record<string, string>) || {}),
  };

  // Issue #477: the access token is on the httpOnly `medcore_at` cookie
  // and travels automatically because we set `credentials: "include"`
  // below. Explicit `token` arg is still honoured for server-to-server
  // / test fixtures that pass a Bearer string directly — auth middleware
  // accepts both during the migration.
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Issue #477: attach CSRF header on mutations. Server's csrfProtection
  // middleware compares this header against the `medcore_csrf` cookie
  // and 403s on mismatch. Safe methods (GET/HEAD/OPTIONS) skip the check.
  const method = (rest as { method?: string }).method?.toUpperCase() ?? "GET";
  if (MUTATION_METHODS.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  // Issue #377 (2026-04-26): bound every request with an AbortController
  // so a server-side hang surfaces as a "Request timed out" toast instead
  // of leaving the user staring at an infinite spinner. Allow the caller
  // to pass an explicit `signal` (we chain ours with it below) without
  // breaking existing aborts.
  const limitMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);
  const callerSignal = (rest as { signal?: AbortSignal }).signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", () => controller.abort());
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${endpoint}`, {
      headers,
      // Issue #477: `credentials: "include"` makes the browser send the
      // httpOnly auth cookies + the csrf cookie on every API call. CORS
      // on the API side already allows the dashboard origin (cors() in
      // app.ts). Without this flag the cookies never travel.
      credentials: "include",
      ...rest,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string })?.name === "AbortError") {
      const e = new Error("Request timed out — please try again") as Error & {
        status?: number;
      };
      e.status = 408;
      throw e;
    }
    throw err;
  }
  clearTimeout(timer);

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = { error: res.statusText };
  }

  if (!res.ok) {
    // Issues #101 + #132: 401 → expired session. Redirect+toast unless
    // the caller opted out (e.g. /auth/me on app boot).
    if (res.status === 401 && !skip401Redirect && typeof window !== "undefined") {
      handleAuthExpired();
    }
    const err = new Error(data?.error || "Request failed") as Error & {
      status?: number;
      payload?: unknown;
    };
    err.status = res.status;
    err.payload = data;
    throw err;
  }

  return data;
}

export const api = {
  get: <T>(endpoint: string, opts?: RequestOptions) =>
    request<T>(endpoint, { method: "GET", ...opts }),

  post: <T>(endpoint: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(endpoint, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
      ...opts,
    }),

  patch: <T>(endpoint: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(endpoint, {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
      ...opts,
    }),

  put: <T>(endpoint: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(endpoint, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
      ...opts,
    }),

  delete: <T>(endpoint: string, opts?: RequestOptions) =>
    request<T>(endpoint, { method: "DELETE", ...opts }),
};

/**
 * Open an authenticated HTML print endpoint in a new window.
 *
 * Issue #477: was reading a Bearer token from localStorage (now defunct).
 * Now relies on the `credentials: "include"` cookie attachment — same as
 * the rest of `api`. The popup itself doesn't navigate so cookies don't
 * matter on `win`; we only need them on the `fetch` here. Print endpoints
 * are GET only, so no CSRF header is required.
 */
export async function openPrintEndpoint(endpoint: string): Promise<void> {
  // Open early to avoid popup blockers
  const win = window.open("", "_blank");
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      credentials: "include",
    });
    const html = await res.text();
    if (win) {
      win.document.open();
      win.document.write(html);
      win.document.close();
    }
  } catch (err) {
    if (win) win.close();
    toast.error(err instanceof Error ? err.message : "Failed to open document");
  }
}
