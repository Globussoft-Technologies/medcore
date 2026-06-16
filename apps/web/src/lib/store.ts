// Issue #346 / #258: see below for role-clobber defence in refreshUser/loadSession.
// Issues #422 / #441 (2026-04-30): session/role bleed defence — clear prior auth
// state BEFORE every login attempt and tag every login with a monotonic
// generation counter so an in-flight `/auth/me` from the previous user cannot
// overwrite the new user. See `loginGeneration` and the staleness checks in
// refreshUser/loadSession below.
// Issue #477 (May 2026): JWTs moved from localStorage → httpOnly cookies
// (`medcore_at`, `medcore_rt`) + a non-httpOnly CSRF cookie (`medcore_csrf`).
// The store no longer reads/writes tokens from localStorage; all of that is
// done by the server's Set-Cookie headers and the browser's automatic
// cookie attachment via `credentials: "include"` in lib/api.ts.
//
// Force-logout migration: on first import after deploy, any
// pre-#477 keys (`medcore_token` / `medcore_refresh`) in localStorage
// are wiped. Users who were signed in pre-deploy land back on /login
// once and re-authenticate — clean break, no half-state.
import { create } from "zustand";
import { api } from "./api";
import {
  broadcastAuthChanged,
  broadcastAuthCleared,
  onAuthBroadcast,
} from "./auth-broadcast";

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  phone?: string;
  photoUrl?: string | null;
  twoFactorEnabled?: boolean;
  preferredLanguage?: string | null;
  defaultLandingPage?: string | null;
  // Pearl gap #6 piece 1 of 4 — surfaced from /auth/me so the
  // /super-admin route group can client-side-gate on the
  // "globally-tenant-less" super-admin pattern (Role.ADMIN AND
  // tenantId == null), matching apps/api/src/routes/tenants.ts
  // requireSuperAdmin. Nullable: regular tenant ADMINs have a
  // tenantId, super-admins have null. Optional on the type because
  // older /auth/me cached responses pre-dating the surface won't
  // include it.
  tenantId?: string | null;
  // Pearl §8.2 — preserved DB role when `role` has been coerced for
  // permission compatibility. The store normalises Role.SUPER_ADMIN
  // → role="ADMIN" so the ~100 inline `user.role === "ADMIN"`
  // checks across the dashboard pages all grant access automatically
  // (SUPER_ADMIN has the same scope as ADMIN by design). The DB
  // value is kept here so badges / labels / the role chip can still
  // display "SUPER_ADMIN" — see coerceUser() below.
  actualRole?: string;
  // Surfaced from /auth/me. True only for the single root super-admin who may
  // provision tenants + mint other super-admins. Gates the Tenants nav and
  // the "Add Tenant" / "Add Super-Admin" affordances client-side (the API
  // enforces it server-side regardless).
  isMainSuperAdmin?: boolean;
}

/**
 * Pearl §8.2 — coerce SUPER_ADMIN to ADMIN at the store layer.
 *
 * Rationale: the API already gives SUPER_ADMIN exactly the access ADMIN
 * gets (see apps/api/src/middleware/auth.ts:authorize). On the web side
 * there are ~100 inline `user.role === "ADMIN"` permission checks
 * scattered through dashboard pages. Patching each one to also accept
 * "SUPER_ADMIN" is verbose and easy to miss; doing the coercion once
 * here makes every existing check work for SUPER_ADMIN automatically.
 *
 * `actualRole` preserves the DB value so UI surfaces that genuinely
 * need to distinguish the two (the role badge, the super-admin tab in
 * /dashboard/users) read from `actualRole ?? role`.
 *
 * Super-admin route gating still works after this coercion because the
 * dashboard / super-admin layouts test `(role === "ADMIN" && tenantId == null)`
 * as part of their `isSuperAdmin` decision — that clause matches a
 * coerced SUPER_ADMIN just as well as a legacy tenant-less ADMIN.
 */
function coerceUser(u: User): User {
  if (u.role === "SUPER_ADMIN") {
    return { ...u, role: "ADMIN", actualRole: "SUPER_ADMIN" };
  }
  return u;
}

interface LoginResult {
  twoFactorRequired?: boolean;
  tempToken?: string;
  // Pearl §8.2 mandatory-TOTP enrolment branch. Set when the auth
  // endpoint returned 412 because this admin / super-admin account
  // has the require-two-factor flag on but hasn't enrolled yet. The
  // login page redirects to /auth/enrol-totp with the enrolToken so
  // the operator can scan a QR + enter the first code.
  totpEnrolmentRequired?: boolean;
  enrolToken?: string;
  enrolRole?: string;
  enrolEmail?: string | null;
  // Patient multi-hospital disambiguation: the same email+password matched
  // patient accounts in several tenants. The page shows a hospital picker and
  // re-calls login() with the chosen tenantId.
  needsHospitalSelection?: boolean;
  hospitals?: Array<{ id: string; name: string; code: string | null }>;
}

interface AuthState {
  user: User | null;
  /**
   * Issue #477: kept as a "logged-in marker" only — never holds a real
   * JWT anymore. After a successful login we set it to a sentinel
   * "cookie" string so any caller code that gates UI on `token` keeps
   * working without churn (the actual access token is on an httpOnly
   * cookie that JS cannot read). New code should gate on `user` instead.
   */
  token: string | null;
  isLoading: boolean;
  /**
   * Issues #422 / #441: monotonic counter incremented on every login,
   * verify2FA, logout, and loadSession start. Async `/auth/me` probes
   * snapshot this value at start and discard their result if it has
   * changed by the time the response arrives — that means a NEW login
   * (or logout) has happened since, and writing the stale `/me` user
   * would clobber the freshly authenticated principal with the previous
   * one. This is the precise mechanism by which a Doctor login was
   * presenting as Patient in #441.
   */
  loginGeneration: number;
  /**
   * Issue #1: `rememberMe` is forwarded to the API so the server can mint a
   * 30-day refresh token instead of the 7-day default. Optional for backward
   * compatibility with any older call sites; defaults to false (session-only).
   */
  login: (
    email: string,
    password: string,
    rememberMe?: boolean,
    tenantId?: string,
  ) => Promise<LoginResult>;
  verify2FA: (tempToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  loadSession: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const COOKIE_TOKEN_SENTINEL = "cookie";

/**
 * Issue #477 force-logout migration: clear any pre-#477 localStorage
 * keys. On a fresh deploy, users who had signed in under the localStorage
 * scheme will land here once, get cleaned up, and bounce back to /login.
 *
 * Issues #422 / #441 (still relevant): a defence-in-depth wipe used
 * before every login() / verify2FA() so the new request:
 *   1. cannot accidentally see a stale token in localStorage (defunct
 *      now, but kept for migration);
 *   2. cannot leave a partial state if the new login throws — the user
 *      must end up either fully logged-in via fresh cookies, or fully
 *      logged-out, never a hybrid.
 *
 * The actual auth secrets live in httpOnly cookies that the server
 * controls; this helper only touches localStorage.
 */
function clearPersistedAuth(): void {
  try {
    localStorage.removeItem("medcore_token");
    localStorage.removeItem("medcore_refresh");
  } catch {
    // localStorage may be unavailable in private mode — best-effort.
  }
}

// Issue #477: run the migration cleanup at module load, before any
// store state is read. SSR-safe via the typeof guard. Idempotent — on
// the second-and-later page loads after migration this is a no-op
// because the keys are already gone.
if (typeof window !== "undefined") {
  clearPersistedAuth();
}

// Cross-tab cookie-swap defence (#524 / #538 / #540 / #564 / #567 / #584):
// subscribe at module init so that ANY tab of the same origin that posts
// an auth change will trigger an immediate re-hydration here. The
// post-hydration role/userId-clobber checks in refreshUser/loadSession
// already handle the actual identity-mismatch decision (clear + redirect
// to /login?reason=...); this subscription just kicks them off in
// real-time instead of waiting for the next user-driven /me probe.
if (typeof window !== "undefined") {
  onAuthBroadcast((msg) => {
    const current = useAuthStore.getState().user;
    if (msg.kind === "auth-cleared") {
      // Another tab just signed out. If we still hold a user, our
      // cookies are about to be invalidated server-side (or already
      // are); force a re-probe so refreshUser's userId-clobber check
      // fires and we redirect to /login cleanly. If no user is set,
      // nothing to do.
      if (current) {
        void useAuthStore.getState().refreshUser();
      }
      return;
    }
    if (msg.kind === "auth-changed") {
      // Another tab just logged in. If our cached user differs from the
      // newly-broadcast user, the cookie has been swapped underneath us
      // and we must NOT keep rendering as the previous principal.
      // Trigger refreshUser; the userId-clobber branch (lib/store.ts
      // userId-clobber check) will see current.id !== res.data.id and
      // redirect to /login?reason=session_mismatch. If our cached user
      // matches the broadcast, nothing to do (we're the same tab user
      // or a same-user re-login).
      if (current && current.id !== msg.userId) {
        if (typeof window !== "undefined") {
          window.location.replace("/login?reason=cross_tab_session_change");
        }
        return;
      }
      // No cached user, or same user — passive re-poll keeps state
      // fresh (e.g. role change after a permission edit in another
      // tab) without forcing a redirect.
      if (current && current.id === msg.userId && current.role !== msg.role) {
        // Role-clobber path; refreshUser will detect and redirect via
        // its existing role-clobber branch.
        void useAuthStore.getState().refreshUser();
      }
    }
  });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isLoading: true,
  loginGeneration: 0,

  login: async (
    email: string,
    password: string,
    rememberMe: boolean = false,
    tenantId?: string,
  ) => {
    // Issues #422 / #441: bump the generation FIRST so any /auth/me probe
    // already in flight (e.g. from a dashboard page that mounted before the
    // user navigated to /login) is invalidated and cannot write back stale
    // user data after our new `set({ user })` lands.
    const generation = get().loginGeneration + 1;
    // Wipe prior user from in-memory state BEFORE making the request. Issue
    // #477: cookies will be replaced by the server's Set-Cookie response.
    clearPersistedAuth();
    set({
      user: null,
      token: null,
      loginGeneration: generation,
    });

    // Only send `rememberMe` when true, so unchecked-box requests remain
    // byte-identical to the pre-Issue-#1 payload and existing tests/mocks
    // that assert on the exact body shape keep passing.
    const body: {
      email: string;
      password: string;
      rememberMe?: boolean;
      tenantId?: string;
    } = {
      email,
      password,
    };
    if (rememberMe) body.rememberMe = true;
    // Patient multi-hospital disambiguation: pass the chosen hospital on the
    // 2nd /login call so the server narrows the credential match to it.
    if (tenantId) body.tenantId = tenantId;
    // Issue #484: skip the global "Your session has expired" toast for the
    // login endpoint. A 401 here means "wrong credentials" — never
    // "session expired" — because the user is by definition not yet
    // authenticated. The page-level catch in `app/login/page.tsx` already
    // surfaces "Invalid email or password." and used to fire IN ADDITION
    // to the global session-expired toast, leaving the user with two
    // contradictory toasts on a fresh failed login.
    let res: {
      success: boolean;
      data:
        | {
            user: User;
            // Tokens are still in the response body for the brief
            // migration window — server-to-server callers and the e2e
            // suite's `apiLogin` helper still consume them. The browser
            // doesn't need them; the cookies are already set.
            tokens: { accessToken: string; refreshToken: string };
          }
        | { twoFactorRequired: true; tempToken: string };
    };
    try {
      res = await api.post<typeof res>("/auth/login", body, {
        skip401Redirect: true,
      });
    } catch (err) {
      // Pearl §8.2 mandatory-TOTP enrolment branch: the auth route
      // returns HTTP 412 with `data.totpEnrolmentRequired: true` and a
      // one-shot `enrolToken` when the operator has never set up 2FA.
      // The api wrapper throws non-2xx, so we have to peek `err.payload`
      // here. Anything else re-throws and surfaces as a normal login
      // failure ("Invalid email or password" etc).
      const e = err as {
        status?: number;
        payload?: { data?: Record<string, unknown> };
      };
      const d = e.payload?.data;
      if (
        e.status === 412 &&
        d &&
        d.totpEnrolmentRequired === true &&
        typeof d.enrolToken === "string"
      ) {
        if (get().loginGeneration !== generation) return {};
        return {
          totpEnrolmentRequired: true,
          enrolToken: d.enrolToken,
          enrolRole: typeof d.role === "string" ? d.role : undefined,
          enrolEmail:
            d.email === null || typeof d.email === "string"
              ? (d.email as string | null)
              : undefined,
        };
      }
      throw err;
    }

    // Issues #422 / #441: if another login/logout happened while we awaited,
    // discard our result entirely — the user has clearly moved on, and
    // committing this user would be the bleed bug we're fixing.
    if (get().loginGeneration !== generation) {
      return {};
    }

    const data = res.data as Record<string, unknown>;
    if (data.twoFactorRequired) {
      return {
        twoFactorRequired: true,
        tempToken: data.tempToken as string,
      };
    }
    // Patient multi-hospital disambiguation: the same email+password matched
    // accounts in several tenants. Return the list so the page shows a
    // hospital picker; it re-calls login() with the chosen tenantId.
    if (data.needsHospitalSelection) {
      return {
        needsHospitalSelection: true,
        hospitals: (data.hospitals as Array<{
          id: string;
          name: string;
          code: string | null;
        }>) ?? [],
      };
    }

    const { user: rawUser } = data as { user: User };
    const user = coerceUser(rawUser);
    // Issue #477: token is a sentinel; the real one is on the cookie.
    set({ user, token: COOKIE_TOKEN_SENTINEL, isLoading: false });
    // Cross-tab cookie-swap defence (#524 cluster): tell every other
    // tab of the same origin that the cookie just got rewritten under
    // them. They'll force-rehydrate if their cached userId doesn't
    // match this one.
    broadcastAuthChanged(user.id, user.role);
    return {};
  },

  verify2FA: async (tempToken: string, code: string) => {
    // Issues #422 / #441: same generation/clear protocol as login() — the
    // 2FA second step is a "login completion" and must invalidate any prior
    // user state and any in-flight /me probe.
    const generation = get().loginGeneration + 1;
    clearPersistedAuth();
    set({ user: null, token: null, loginGeneration: generation });

    // Issue #484: same skip — a 401 from /auth/2fa/verify-login means
    // "wrong code" not "session expired" (the tempToken is the only
    // thing identifying the user mid-flow), so we suppress the global
    // session-expired toast and let the page surface a step-specific
    // "Invalid 2FA code" message via its own catch.
    const res = await api.post<{
      success: boolean;
      data: {
        user: User;
        tokens: { accessToken: string; refreshToken: string };
      };
    }>("/auth/2fa/verify-login", { tempToken, code }, { skip401Redirect: true });

    if (get().loginGeneration !== generation) return;

    const user = coerceUser(res.data.user);
    // Issue #477: token sentinel only — server set the real cookie.
    set({ user, token: COOKIE_TOKEN_SENTINEL, isLoading: false });
    // Cross-tab cookie-swap defence (#524 cluster): same as login() —
    // 2FA-completion is a fresh login from the cookie's perspective.
    broadcastAuthChanged(user.id, user.role);
  },

  refreshUser: async () => {
    // Issue #477: no localStorage gate. /auth/me trusts the cookie to
    // authenticate; if it's missing/expired the API returns 401 and we
    // fall through to the catch.
    //
    // Issues #422 / #441: snapshot the generation at start so we can
    // detect a logout/login that happened while /me was in flight and
    // discard the result instead of writing stale user data back.
    const generationAtStart = get().loginGeneration;
    try {
      // skip401Redirect: this is a background probe, not a navigation. If the
      // cookie has expired we DO want the global interceptor to fire on the
      // user's next *actual* navigation — not on an out-of-band /me poll.
      const res = await api.get<{ success: boolean; data: User }>("/auth/me", {
        skip401Redirect: true,
      });

      // Issues #422 / #441: bail if the auth state changed under us.
      if (get().loginGeneration !== generationAtStart) return;

      // Issues #346 + #258: role-clobber defence. If a /me response returns
      // a different role for the same user-id we already have cached,
      // treat it as a session-integrity failure and force re-auth instead
      // of silently mutating useAuthStore. This stops a server bug or
      // misrouted endpoint from quietly elevating a Reception session to
      // Doctor mid-navigation, or any page from being tricked into ADMIN
      // by a /me-shaped admin endpoint.
      const current = (useAuthStore.getState() as AuthState).user;
      const incoming = res.data ? coerceUser(res.data) : res.data;
      if (
        current &&
        incoming &&
        current.id === incoming.id &&
        current.role !== incoming.role
      ) {
        clearPersistedAuth();
        set({ user: null, token: null });
        if (typeof window !== "undefined") {
          window.location.replace("/login?reason=role_changed");
        }
        return;
      }
      // Issues #422 / #441: USER-ID clobber defence. If /me returns a
      // DIFFERENT user than we have cached, the in-memory user has
      // desynchronised from the cookie — never silently adopt the
      // server's identity. Force re-auth.
      if (
        current &&
        incoming &&
        current.id !== incoming.id
      ) {
        clearPersistedAuth();
        set({ user: null, token: null });
        // Cross-tab cookie-swap defence (#524 cluster): if WE detected
        // the swap first, alert the other tabs so they re-hydrate too
        // rather than waiting for their own next /me probe.
        broadcastAuthChanged(incoming.id, incoming.role);
        if (typeof window !== "undefined") {
          window.location.replace("/login?reason=session_mismatch");
        }
        return;
      }
      set({ user: incoming });
    } catch {
      // ignore
    }
  },

  logout: async () => {
    // Issues #422 / #441: bumping the generation invalidates any /me probe
    // that was in flight when the user clicked logout, so a late-arriving
    // response can't re-seat the user we just signed out.
    //
    // Issue #477: the actual cookie clear happens server-side via the
    // /auth/logout endpoint's clearAuthCookies(). Without this call the
    // browser's cookies would survive and the next request would re-
    // authenticate. Best-effort — if the call fails (network down, server
    // 500) we still clear local state so the user appears logged out;
    // their cookies will eventually expire on the wire.
    clearPersistedAuth();
    set((s) => ({
      user: null,
      token: null,
      loginGeneration: s.loginGeneration + 1,
    }));
    // Cross-tab cookie-swap defence (#524 cluster): tell every other
    // tab the cookies are about to be cleared so they don't continue
    // rendering authenticated UI against a now-dead session.
    broadcastAuthCleared();
    try {
      await api.post("/auth/logout", undefined, { skip401Redirect: true });
    } catch {
      // best-effort — see comment above.
    }
  },

  loadSession: async () => {
    // Issue #477: no localStorage token gate. We always probe /auth/me
    // and let the cookie answer for us. A 401 means "no valid session"
    // and we settle into the unauthenticated state cleanly.
    //
    // Issues #422 / #441: snapshot the generation; if a login/logout
    // happens while we await, the result of this app-boot probe is stale.
    const generationAtStart = get().loginGeneration;

    try {
      // skip401Redirect: app-boot session probe — bouncing the user to /login
      // before they've even tried anything would be jarring. If the cookie
      // is dead, we just settle in unauthenticated state; the next actual
      // API call will trigger the proper redirect+toast.
      const res = await api.get<{ success: boolean; data: User }>("/auth/me", {
        skip401Redirect: true,
      });

      // Issues #422 / #441: discard if the session changed under us.
      if (get().loginGeneration !== generationAtStart) {
        set({ isLoading: false });
        return;
      }

      // Issues #346 + #258: same role-clobber defence on app-boot session
      // restore. If we have a cached user and the server's role differs,
      // refuse the silent change.
      const current = (useAuthStore.getState() as AuthState).user;
      const incoming = res.data ? coerceUser(res.data) : res.data;
      if (
        current &&
        incoming &&
        current.id === incoming.id &&
        current.role !== incoming.role
      ) {
        clearPersistedAuth();
        set({ user: null, token: null, isLoading: false });
        return;
      }
      // Issues #422 / #441: same USER-ID clobber defence on app-boot. If
      // /me returns a different user than we have cached (e.g. a previous
      // tab's stale in-memory user), refuse and clear.
      if (
        current &&
        incoming &&
        current.id !== incoming.id
      ) {
        clearPersistedAuth();
        set({ user: null, token: null, isLoading: false });
        return;
      }
      // Issue #477: token sentinel only — the real one is on the cookie.
      // Pearl §8.2: write the *coerced* user, not the raw server payload —
      // otherwise SUPER_ADMIN landing through loadSession would skip the
      // role normalisation and the role-keyed permission checks across
      // the dashboard would lock the user out of every ADMIN-only page.
      set({ user: incoming, token: COOKIE_TOKEN_SENTINEL, isLoading: false });
    } catch (err) {
      // 2026-05-27: previously this `catch` unconditionally cleared the
      // auth state, which mis-classified 429 (rate-limited) and 5xx
      // (server hiccup) as "session dead" and bounced the user to
      // /login with "session expired". Now we only clear on a 401
      // (true session expiry); anything else preserves the prior `user`
      // value so the layout doesn't redirect on a transient blip.
      const status = (err as { status?: number })?.status;
      if (status === 401) {
        clearPersistedAuth();
        set({ user: null, token: null, isLoading: false });
      } else {
        // Settle isLoading so the UI stops showing skeletons, but keep
        // any cached `user` — a retry will reconcile on the next call.
        set({ isLoading: false });
      }
    }
  },
}));

/**
 * Module-scope getter used by the api-client's request interceptor so
 * non-React code can read the active tenant id without subscribing to the
 * store. Sourced from /auth/me (server-authoritative), so it always equals
 * the caller's real tenant. Sent as `X-Tenant-Id` on every API call so the
 * backend's tenantContextMiddleware scopes explicitly (it prioritises the
 * header). Returns null on the server and for tenant-less super-admins
 * (who bypass scoping). See apps/api/src/middleware/tenant.ts.
 */
export function getCurrentTenantId(): string | null {
  if (typeof window === "undefined") return null;
  return useAuthStore.getState().user?.tenantId ?? null;
}
