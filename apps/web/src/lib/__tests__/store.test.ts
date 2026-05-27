import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the api module BEFORE importing the store.
vi.mock("../api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import { useAuthStore } from "../store";
import { api } from "../api";

const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>;
const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>;

const USER = {
  id: "u1",
  email: "a@b.com",
  name: "Alice",
  role: "DOCTOR",
};
// Issue #477: tokens still appear in the response body (server-to-server
// migration window) but the store no longer reads them — the cookie
// transport is the source of truth. The tests assert the user state is
// updated regardless of the tokens shape.
const TOKENS = { accessToken: "acc-1", refreshToken: "ref-1" };

// Issue #477: the store now sets the in-memory `token` field to a fixed
// sentinel string after a successful auth, since the real JWT is on the
// httpOnly cookie. New tests assert on the sentinel (or on the truthier
// `user` field) rather than on a real token value.
const COOKIE_TOKEN_SENTINEL = "cookie";

describe("useAuthStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({ user: null, token: null, isLoading: true });
    mockedPost.mockReset();
    mockedGet.mockReset();
  });

  it("login sets user state on plain success (Issue #477: no localStorage write)", async () => {
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: { user: USER, tokens: TOKENS },
    });
    const res = await useAuthStore.getState().login("a@b.com", "pwd");
    expect(res.twoFactorRequired).toBeUndefined();
    // Issue #477: token is no longer the JWT — it's a sentinel marking
    // "logged-in via cookie". The real access token is on `medcore_at`
    // which JS cannot read.
    expect(useAuthStore.getState().token).toBe(COOKIE_TOKEN_SENTINEL);
    expect(useAuthStore.getState().user?.id).toBe("u1");
    // The pre-#477 keys must NOT be re-introduced by login.
    expect(window.localStorage.getItem("medcore_token")).toBeNull();
    expect(window.localStorage.getItem("medcore_refresh")).toBeNull();
  });

  it("login returns tempToken when 2FA required", async () => {
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: { twoFactorRequired: true, tempToken: "temp-123" },
    });
    const res = await useAuthStore.getState().login("a@b.com", "pwd");
    expect(res.twoFactorRequired).toBe(true);
    expect(res.tempToken).toBe("temp-123");
    // Does NOT log the user in yet
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("verify2FA completes login with user (Issue #477: cookie-only)", async () => {
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: { user: USER, tokens: TOKENS },
    });
    await useAuthStore.getState().verify2FA("temp-123", "123456");
    expect(useAuthStore.getState().user?.id).toBe("u1");
    expect(useAuthStore.getState().token).toBe(COOKIE_TOKEN_SENTINEL);
  });

  it("logout clears state and POSTs /auth/logout to clear cookies (#477)", async () => {
    mockedPost.mockResolvedValueOnce({ success: true, data: null });
    useAuthStore.setState({ user: USER as any, token: COOKIE_TOKEN_SENTINEL });
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
    // Issue #477: the server-side cookie clear happens via the /auth/logout
    // call. Without this call the browser's cookies survive and the next
    // request would re-authenticate.
    const logoutCall = mockedPost.mock.calls.find(
      (c) => c[0] === "/auth/logout",
    );
    expect(logoutCall).toBeDefined();
  });

  it("logout still clears local state if the server call rejects (#477 best-effort)", async () => {
    mockedPost.mockRejectedValueOnce(new Error("network"));
    useAuthStore.setState({ user: USER as any, token: COOKIE_TOKEN_SENTINEL });
    await useAuthStore.getState().logout();
    // Local state must be wiped regardless — cookies will eventually
    // expire on the wire, and we don't want the user stuck logged-in
    // visually because the network blipped.
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("loadSession restores user from /auth/me (cookie auto-attached)", async () => {
    mockedGet.mockResolvedValueOnce({ success: true, data: USER });
    await useAuthStore.getState().loadSession();
    expect(useAuthStore.getState().user?.id).toBe("u1");
    expect(useAuthStore.getState().token).toBe(COOKIE_TOKEN_SENTINEL);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it("loadSession settles unauthenticated when /auth/me 401s (Issue #477)", async () => {
    // Issue #477: there's no localStorage gate anymore. Even with no
    // cookie, loadSession will call /auth/me — the API returns 401 and
    // we settle into clean unauthenticated state.
    //
    // 2026-05-27: loadSession now branches on `err.status` to distinguish
    // true session expiry (401 → clear auth) from transient failure
    // (429/5xx → preserve cached user). The mock must therefore carry a
    // real `status: 401` to mirror what api.ts actually throws (it
    // attaches `.status` to the Error via `Object.assign`-style shape;
    // see lib/api.ts:222-229). Bare `new Error("401")` has no .status
    // and would now hit the preserve-cached-user branch.
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    mockedGet.mockRejectedValueOnce(err);
    await useAuthStore.getState().loadSession();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  // Issues #346 + #258: role-clobber defence — refuse to silently mutate
  // a cached user's role to a different role from /auth/me.
  it("refreshUser refuses to elevate role mid-session (Issues #346, #258)", async () => {
    useAuthStore.setState({
      user: { ...USER, role: "RECEPTION" } as any,
      token: COOKIE_TOKEN_SENTINEL,
      isLoading: false,
    });
    // Stub the window.location object — jsdom won't let us redefine
    // .replace on the existing one without a `delete` first.
    const original = window.location;
    delete (window as any).location;
    (window as any).location = {
      ...original,
      replace: vi.fn(),
      pathname: "/dashboard",
      search: "",
    };
    try {
      mockedGet.mockResolvedValueOnce({
        success: true,
        data: { ...USER, role: "DOCTOR" }, // server "elevation"
      });
      await useAuthStore.getState().refreshUser();
      // Role-clobber guard: state should be cleared.
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().token).toBeNull();
    } finally {
      (window as any).location = original;
    }
  });

  it("loadSession refuses to elevate role on app boot (Issues #346, #258)", async () => {
    // Pre-seed a cached RECEPTION session (e.g. from a previous tab).
    useAuthStore.setState({
      user: { ...USER, role: "RECEPTION" } as any,
      token: COOKIE_TOKEN_SENTINEL,
      isLoading: true,
    });
    mockedGet.mockResolvedValueOnce({
      success: true,
      data: { ...USER, role: "ADMIN" }, // attempted clobber to ADMIN
    });
    await useAuthStore.getState().loadSession();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it("refreshUser still updates non-role fields when role matches", async () => {
    useAuthStore.setState({
      user: { ...USER, name: "Old Name" } as any,
      token: COOKIE_TOKEN_SENTINEL,
      isLoading: false,
    });
    mockedGet.mockResolvedValueOnce({
      success: true,
      data: { ...USER, name: "New Name", role: "DOCTOR" },
    });
    await useAuthStore.getState().refreshUser();
    expect(useAuthStore.getState().user?.name).toBe("New Name");
    expect(useAuthStore.getState().user?.role).toBe("DOCTOR");
  });

  // ── Issues #422 / #441 — session/role bleed defence ──────────────────

  it("login clears prior auth state BEFORE the request fires (#422/#441)", async () => {
    // Pre-seed a Patient session in-memory — pre-#477 the bleed bug fired
    // when localStorage held the previous user's token; in the cookie
    // world the equivalent risk is in-memory state surviving an interrupted
    // login. Same defence: clear before the request.
    useAuthStore.setState({
      user: { ...USER, id: "patient-id", role: "PATIENT" } as any,
      token: COOKIE_TOKEN_SENTINEL,
      isLoading: false,
    });

    // Capture the state observed when the network call happens — at this
    // point the prior Patient state must already be wiped.
    let stateAtCallTime: { token: string | null; userId: string | undefined } | null = null;
    mockedPost.mockImplementationOnce(async () => {
      const s = useAuthStore.getState();
      stateAtCallTime = { token: s.token, userId: s.user?.id };
      return {
        success: true,
        data: {
          user: { ...USER, id: "doctor-id", role: "DOCTOR" },
          tokens: { accessToken: "doctor-acc", refreshToken: "doctor-ref" },
        },
      };
    });

    await useAuthStore
      .getState()
      .login("dr.sharma@medcore.local", "doctor123");

    expect(stateAtCallTime).not.toBeNull();
    // Prior token + user must be wiped from in-memory state BEFORE the
    // request runs.
    expect(stateAtCallTime!.token).toBeNull();
    expect(stateAtCallTime!.userId).toBeUndefined();
    // After login, the new Doctor seat is in place.
    expect(useAuthStore.getState().user?.id).toBe("doctor-id");
    expect(useAuthStore.getState().user?.role).toBe("DOCTOR");
    expect(useAuthStore.getState().token).toBe(COOKIE_TOKEN_SENTINEL);
  });

  it("late /me from prior user cannot clobber a new login (#422/#441)", async () => {
    // Set up a Patient session and KICK OFF refreshUser, but do NOT resolve
    // the /me promise yet. While the Patient /me probe is in flight, the
    // user navigates to /login and signs in as Doctor. The late /me must
    // NOT overwrite the Doctor user.
    useAuthStore.setState({
      user: { ...USER, id: "patient-id", role: "PATIENT" } as any,
      token: COOKIE_TOKEN_SENTINEL,
      isLoading: false,
    });

    // Defer the /me resolution so we can interleave a login.
    let releaseMe: (v: unknown) => void = () => {};
    const mePromise = new Promise((r) => {
      releaseMe = r;
    });
    mockedGet.mockReturnValueOnce(mePromise);
    const refreshP = useAuthStore.getState().refreshUser();

    // Now the user logs in as Doctor.
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: {
        user: { ...USER, id: "doctor-id", role: "DOCTOR" },
        tokens: { accessToken: "doctor-acc", refreshToken: "doctor-ref" },
      },
    });
    await useAuthStore
      .getState()
      .login("dr.sharma@medcore.local", "doctor123");
    expect(useAuthStore.getState().user?.id).toBe("doctor-id");
    expect(useAuthStore.getState().user?.role).toBe("DOCTOR");

    // Release the in-flight Patient /me — it must be discarded.
    releaseMe({
      success: true,
      data: { ...USER, id: "patient-id", role: "PATIENT" },
    });
    await refreshP;

    // Doctor seat must still be intact — no Patient bleed.
    expect(useAuthStore.getState().user?.id).toBe("doctor-id");
    expect(useAuthStore.getState().user?.role).toBe("DOCTOR");
    expect(useAuthStore.getState().token).toBe(COOKIE_TOKEN_SENTINEL);
  });

  it("refreshUser refuses to adopt a different USER-ID via /me (#422/#441)", async () => {
    useAuthStore.setState({
      user: { ...USER, id: "doctor-id", role: "DOCTOR" } as any,
      token: COOKIE_TOKEN_SENTINEL,
      isLoading: false,
    });
    const original = window.location;
    delete (window as any).location;
    (window as any).location = {
      ...original,
      replace: vi.fn(),
      pathname: "/dashboard",
      search: "",
    };
    try {
      // /me returns a totally different user (the bleed scenario).
      mockedGet.mockResolvedValueOnce({
        success: true,
        data: { ...USER, id: "patient-id", role: "PATIENT" },
      });
      await useAuthStore.getState().refreshUser();
      // Must NOT have adopted the patient identity.
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().token).toBeNull();
    } finally {
      (window as any).location = original;
    }
  });

  // ── Issue #484 — login/2FA must skip the global session-expired toast ──
  //
  // A 401 from /auth/login means "wrong credentials" — never "session
  // expired" — because the user is by definition unauthenticated when
  // they call this endpoint. Before the fix, a fresh failed login fired
  // BOTH the page-level "Invalid email or password" toast AND the
  // global "Your session has expired" toast from lib/api.ts, leaving
  // the user with two contradictory toasts. We assert that the third
  // argument to api.post on /auth/login carries `skip401Redirect: true`
  // so the global handler in api.ts is suppressed.

  it("login passes skip401Redirect to api.post on /auth/login (#484)", async () => {
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: { user: USER, tokens: TOKENS },
    });
    await useAuthStore.getState().login("a@b.com", "pwd");
    // Locate the /auth/login call and inspect its options arg.
    const call = mockedPost.mock.calls.find((c) => c[0] === "/auth/login");
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({ skip401Redirect: true });
  });

  it("verify2FA passes skip401Redirect on /auth/2fa/verify-login (#484)", async () => {
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: { user: USER, tokens: TOKENS },
    });
    await useAuthStore.getState().verify2FA("temp-123", "123456");
    const call = mockedPost.mock.calls.find(
      (c) => c[0] === "/auth/2fa/verify-login"
    );
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({ skip401Redirect: true });
  });

  it("logout invalidates an in-flight /me from the previous session (#422/#441)", async () => {
    useAuthStore.setState({
      user: { ...USER, id: "patient-id", role: "PATIENT" } as any,
      token: COOKIE_TOKEN_SENTINEL,
      isLoading: false,
    });
    let releaseMe: (v: unknown) => void = () => {};
    const mePromise = new Promise((r) => {
      releaseMe = r;
    });
    mockedGet.mockReturnValueOnce(mePromise);
    const refreshP = useAuthStore.getState().refreshUser();

    // User logs out before /me returns.
    // Issue #477: logout is now async (POSTs /auth/logout to clear
    // server-side cookies). Mock the call so it resolves cleanly.
    mockedPost.mockResolvedValueOnce({ success: true, data: null });
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().user).toBeNull();

    // Late /me arrives — must NOT re-seat the user.
    releaseMe({
      success: true,
      data: { ...USER, id: "patient-id", role: "PATIENT" },
    });
    await refreshP;

    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
  });

  // ── Issue #477 — force-logout migration ──────────────────────────────
  //
  // The pre-#477 localStorage keys (`medcore_token`, `medcore_refresh`)
  // are wiped at module-load time of `../store` and again on every
  // login/logout via `clearPersistedAuth`. The first part is a side
  // effect at import time (executed once per process; not easily
  // re-runnable from inside a vitest case without fighting the module
  // loader), so we cover the second part — login + logout both wipe
  // any stale pre-#477 keys regardless of state.

  it("login wipes pre-#477 localStorage keys even if they're seeded mid-session", async () => {
    window.localStorage.setItem("medcore_token", "stale-pre-477");
    window.localStorage.setItem("medcore_refresh", "stale-pre-477-refresh");
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: { user: USER, tokens: TOKENS },
    });
    await useAuthStore.getState().login("a@b.com", "pwd");
    expect(window.localStorage.getItem("medcore_token")).toBeNull();
    expect(window.localStorage.getItem("medcore_refresh")).toBeNull();
  });

  it("logout wipes pre-#477 localStorage keys", async () => {
    window.localStorage.setItem("medcore_token", "stale-pre-477");
    window.localStorage.setItem("medcore_refresh", "stale-pre-477-refresh");
    mockedPost.mockResolvedValueOnce({ success: true, data: null });
    useAuthStore.setState({ user: USER as any, token: COOKIE_TOKEN_SENTINEL });
    await useAuthStore.getState().logout();
    expect(window.localStorage.getItem("medcore_token")).toBeNull();
    expect(window.localStorage.getItem("medcore_refresh")).toBeNull();
  });

  // ─── Pearl §8.2 — SUPER_ADMIN role coercion (coerceUser) ───────────────
  //
  // The store normalises Role.SUPER_ADMIN → role="ADMIN" so the ~100
  // inline `user.role === "ADMIN"` checks across the dashboard pages
  // grant access automatically. The DB role is preserved in
  // `user.actualRole` so badges / labels still display "SUPER_ADMIN".
  //
  // These tests verify the coercion fires on every entry point that can
  // populate `user`: login(), verify2FA(), refreshUser(), loadSession().

  const SUPER_ADMIN_USER = {
    id: "sa1",
    email: "super@medcore.local",
    name: "Super Admin",
    role: "SUPER_ADMIN",
    tenantId: null,
  };

  it("login coerces SUPER_ADMIN → role=ADMIN, preserves actualRole (Pearl §8.2)", async () => {
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: { user: SUPER_ADMIN_USER, tokens: TOKENS },
    });
    await useAuthStore.getState().login("super@medcore.local", "pwd");
    const u = useAuthStore.getState().user;
    expect(u?.role).toBe("ADMIN");
    expect((u as any)?.actualRole).toBe("SUPER_ADMIN");
    // Sanity: the DB-level id/email are preserved.
    expect(u?.id).toBe("sa1");
  });

  it("verify2FA coerces SUPER_ADMIN after the second step (Pearl §8.2)", async () => {
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: { user: SUPER_ADMIN_USER, tokens: TOKENS },
    });
    await useAuthStore.getState().verify2FA("temp-xyz", "123456");
    const u = useAuthStore.getState().user;
    expect(u?.role).toBe("ADMIN");
    expect((u as any)?.actualRole).toBe("SUPER_ADMIN");
  });

  it("loadSession coerces SUPER_ADMIN from /auth/me on app boot (Pearl §8.2)", async () => {
    mockedGet.mockResolvedValueOnce({ success: true, data: SUPER_ADMIN_USER });
    await useAuthStore.getState().loadSession();
    const u = useAuthStore.getState().user;
    expect(u?.role).toBe("ADMIN");
    expect((u as any)?.actualRole).toBe("SUPER_ADMIN");
  });

  it("refreshUser does NOT trip role-clobber guard for a steady SUPER_ADMIN session (Pearl §8.2)", async () => {
    // Both current and incoming users are SUPER_ADMIN — after coercion
    // both roles are "ADMIN", the clobber comparison matches, and the
    // user is updated normally (NOT wiped). This is the regression we
    // would otherwise introduce if coercion were applied to only one
    // side of the comparison.
    useAuthStore.setState({
      // Simulate a previously coerced super-admin in the store.
      user: { ...SUPER_ADMIN_USER, role: "ADMIN", actualRole: "SUPER_ADMIN" } as any,
      token: COOKIE_TOKEN_SENTINEL,
      isLoading: false,
    });
    mockedGet.mockResolvedValueOnce({
      success: true,
      data: { ...SUPER_ADMIN_USER, name: "Updated Name" },
    });
    await useAuthStore.getState().refreshUser();
    const u = useAuthStore.getState().user;
    // User survived (not wiped by the role-clobber guard)…
    expect(u).not.toBeNull();
    // …carries the coerced role + actualRole…
    expect(u?.role).toBe("ADMIN");
    expect((u as any)?.actualRole).toBe("SUPER_ADMIN");
    // …and absorbed the updated name from /me.
    expect(u?.name).toBe("Updated Name");
  });

  it("leaves a plain ADMIN user untouched — no actualRole field (Pearl §8.2 mirror rule)", async () => {
    const PLAIN_ADMIN = { ...USER, role: "ADMIN" };
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: { user: PLAIN_ADMIN, tokens: TOKENS },
    });
    await useAuthStore.getState().login("a@b.com", "pwd");
    const u = useAuthStore.getState().user;
    expect(u?.role).toBe("ADMIN");
    // A normal ADMIN never gets an actualRole stamp.
    expect((u as any)?.actualRole).toBeUndefined();
  });
});
