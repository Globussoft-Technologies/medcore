// Issue #346 / #258: see below for role-clobber defence in refreshUser/loadSession.
// Issues #422 / #441 (2026-04-30): session/role bleed defence — clear prior auth
// state BEFORE every login attempt and tag every login with a monotonic
// generation counter so an in-flight `/auth/me` from the previous user cannot
// overwrite the new user. See `loginGeneration` and the staleness checks in
// refreshUser/loadSession below.
import { create } from "zustand";
import { api } from "./api";

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
}

interface LoginResult {
  twoFactorRequired?: boolean;
  tempToken?: string;
}

interface AuthState {
  user: User | null;
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
    rememberMe?: boolean
  ) => Promise<LoginResult>;
  verify2FA: (tempToken: string, code: string) => Promise<void>;
  logout: () => void;
  loadSession: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

/**
 * Issues #422 / #441: hard-clear ALL persisted auth state. Called before any
 * fresh login attempt so the new request:
 *   1. cannot accidentally attach the previous user's bearer token (api.ts
 *      falls back to localStorage when no explicit token is passed);
 *   2. cannot leave a stale token in localStorage if the new login throws
 *      mid-flight — the user must end up either fully logged-in as the new
 *      principal or fully logged-out, never a hybrid.
 */
function clearPersistedAuth(): void {
  try {
    localStorage.removeItem("medcore_token");
    localStorage.removeItem("medcore_refresh");
  } catch {
    // localStorage may be unavailable in private mode — best-effort.
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isLoading: true,
  loginGeneration: 0,

  login: async (email: string, password: string, rememberMe: boolean = false) => {
    // Issues #422 / #441: bump the generation FIRST so any /auth/me probe
    // already in flight (e.g. from a dashboard page that mounted before the
    // user navigated to /login) is invalidated and cannot write back stale
    // user data after our new `set({ user })` lands.
    const generation = get().loginGeneration + 1;
    // Wipe prior user/token from both storage AND in-memory state BEFORE
    // making the request. This is the actual #422/#441 fix: previously, if
    // login() threw or raced, the previous user's token sat in localStorage
    // and the previous user's `useAuthStore.user` stayed cached, so the
    // dashboard rendered the wrong role's shell.
    clearPersistedAuth();
    set({
      user: null,
      token: null,
      loginGeneration: generation,
    });

    // Only send `rememberMe` when true, so unchecked-box requests remain
    // byte-identical to the pre-Issue-#1 payload and existing tests/mocks
    // that assert on the exact body shape keep passing.
    const body: { email: string; password: string; rememberMe?: boolean } = {
      email,
      password,
    };
    if (rememberMe) body.rememberMe = true;
    // Pass an empty `token: ""` would be wrong — instead we rely on the
    // localStorage being already cleared above, so api.ts will not attach
    // any Authorization header. The login endpoint does not require one.
    //
    // Issue #484: skip the global "Your session has expired" toast for the
    // login endpoint. A 401 here means "wrong credentials" — never
    // "session expired" — because the user is by definition not yet
    // authenticated. The page-level catch in `app/login/page.tsx` already
    // surfaces "Invalid email or password." and used to fire IN ADDITION
    // to the global session-expired toast, leaving the user with two
    // contradictory toasts on a fresh failed login.
    const res = await api.post<{
      success: boolean;
      data:
        | {
            user: User;
            tokens: { accessToken: string; refreshToken: string };
          }
        | { twoFactorRequired: true; tempToken: string };
    }>("/auth/login", body, { skip401Redirect: true });

    // Issues #422 / #441: if another login/logout happened while we awaited,
    // discard our result entirely — the user has clearly moved on, and
    // committing this user would be the bleed bug we're fixing.
    if (get().loginGeneration !== generation) {
      return {};
    }

    const data = res.data as any;
    if (data.twoFactorRequired) {
      return { twoFactorRequired: true, tempToken: data.tempToken };
    }

    const { user, tokens } = data;
    localStorage.setItem("medcore_token", tokens.accessToken);
    localStorage.setItem("medcore_refresh", tokens.refreshToken);
    set({ user, token: tokens.accessToken, isLoading: false });
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

    const { user, tokens } = res.data;
    localStorage.setItem("medcore_token", tokens.accessToken);
    localStorage.setItem("medcore_refresh", tokens.refreshToken);
    set({ user, token: tokens.accessToken, isLoading: false });
  },

  refreshUser: async () => {
    const token = localStorage.getItem("medcore_token");
    if (!token) return;
    // Issues #422 / #441: snapshot the generation at start so we can
    // detect a logout/login that happened while /me was in flight and
    // discard the result instead of writing stale user data back.
    const generationAtStart = get().loginGeneration;
    try {
      // skip401Redirect: this is a background probe, not a navigation. If the
      // token has expired we DO want the global interceptor to fire on the
      // user's next *actual* navigation — not on an out-of-band /me poll.
      const res = await api.get<{ success: boolean; data: User }>("/auth/me", {
        token,
        skip401Redirect: true,
      });

      // Issues #422 / #441: bail if the auth state changed under us.
      if (get().loginGeneration !== generationAtStart) return;
      // Also bail if the token in localStorage has changed (e.g. a
      // concurrent login swapped it) — writing the old user against
      // the new token would re-introduce the bleed.
      if (localStorage.getItem("medcore_token") !== token) return;

      // Issues #346 + #258: role-clobber defence. If a /me response returns
      // a different role for the same user-id we already have cached,
      // treat it as a session-integrity failure and force re-auth instead
      // of silently mutating useAuthStore. This stops a server bug or
      // misrouted endpoint from quietly elevating a Reception session to
      // Doctor mid-navigation, or any page from being tricked into ADMIN
      // by a /me-shaped admin endpoint.
      const current = (useAuthStore.getState() as AuthState).user;
      if (
        current &&
        res.data &&
        current.id === res.data.id &&
        current.role !== res.data.role
      ) {
        clearPersistedAuth();
        set({ user: null, token: null });
        if (typeof window !== "undefined") {
          window.location.replace("/login?reason=role_changed");
        }
        return;
      }
      // Issues #422 / #441: USER-ID clobber defence. If /me returns a
      // DIFFERENT user than we have cached, the token in localStorage
      // and the in-memory user have desynchronised — never silently
      // adopt the server's identity. Force re-auth.
      if (
        current &&
        res.data &&
        current.id !== res.data.id
      ) {
        clearPersistedAuth();
        set({ user: null, token: null });
        if (typeof window !== "undefined") {
          window.location.replace("/login?reason=session_mismatch");
        }
        return;
      }
      set({ user: res.data });
    } catch {
      // ignore
    }
  },

  logout: () => {
    // Issues #422 / #441: bumping the generation invalidates any /me probe
    // that was in flight when the user clicked logout, so a late-arriving
    // response can't re-seat the user we just signed out.
    clearPersistedAuth();
    set((s) => ({
      user: null,
      token: null,
      loginGeneration: s.loginGeneration + 1,
    }));
  },

  loadSession: async () => {
    const token = localStorage.getItem("medcore_token");
    if (!token) {
      set({ isLoading: false });
      return;
    }

    // Issues #422 / #441: snapshot the generation; if a login/logout happens
    // while we await, the result of this app-boot probe is stale.
    const generationAtStart = get().loginGeneration;

    try {
      // skip401Redirect: app-boot session probe — bouncing the user to /login
      // before they've even tried anything would be jarring. If the stored
      // token is dead, we just clear it locally and stay on the current page;
      // the next actual API call will trigger the proper redirect+toast.
      const res = await api.get<{ success: boolean; data: User }>("/auth/me", {
        token,
        skip401Redirect: true,
      });

      // Issues #422 / #441: discard if the session changed under us.
      if (get().loginGeneration !== generationAtStart) {
        set({ isLoading: false });
        return;
      }
      if (localStorage.getItem("medcore_token") !== token) {
        // Another tab/login wrote a different token — let that flow win.
        set({ isLoading: false });
        return;
      }

      // Issues #346 + #258: same role-clobber defence on app-boot session
      // restore. If we have a cached user and the server's role differs,
      // refuse the silent change.
      const current = (useAuthStore.getState() as AuthState).user;
      if (
        current &&
        res.data &&
        current.id === res.data.id &&
        current.role !== res.data.role
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
        res.data &&
        current.id !== res.data.id
      ) {
        clearPersistedAuth();
        set({ user: null, token: null, isLoading: false });
        return;
      }
      set({ user: res.data, token, isLoading: false });
    } catch {
      clearPersistedAuth();
      set({ user: null, token: null, isLoading: false });
    }
  },
}));
