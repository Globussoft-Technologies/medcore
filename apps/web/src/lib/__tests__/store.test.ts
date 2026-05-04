import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
const TOKENS = { accessToken: "acc-1", refreshToken: "ref-1" };

describe("useAuthStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({ user: null, token: null, isLoading: true });
    mockedPost.mockReset();
    mockedGet.mockReset();
  });

  it("login stores token and user on plain success", async () => {
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: { user: USER, tokens: TOKENS },
    });
    const res = await useAuthStore.getState().login("a@b.com", "pwd");
    expect(res.twoFactorRequired).toBeUndefined();
    expect(window.localStorage.getItem("medcore_token")).toBe("acc-1");
    expect(window.localStorage.getItem("medcore_refresh")).toBe("ref-1");
    expect(useAuthStore.getState().user?.id).toBe("u1");
    expect(useAuthStore.getState().token).toBe("acc-1");
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
    expect(window.localStorage.getItem("medcore_token")).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("verify2FA completes login with user + tokens", async () => {
    mockedPost.mockResolvedValueOnce({
      success: true,
      data: { user: USER, tokens: TOKENS },
    });
    await useAuthStore.getState().verify2FA("temp-123", "123456");
    expect(useAuthStore.getState().user?.id).toBe("u1");
    expect(window.localStorage.getItem("medcore_token")).toBe("acc-1");
  });

  it("logout clears state and localStorage", () => {
    window.localStorage.setItem("medcore_token", "x");
    window.localStorage.setItem("medcore_refresh", "y");
    useAuthStore.setState({ user: USER as any, token: "x" });
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
    expect(window.localStorage.getItem("medcore_token")).toBeNull();
    expect(window.localStorage.getItem("medcore_refresh")).toBeNull();
  });

  it("loadSession restores user when a token exists", async () => {
    window.localStorage.setItem("medcore_token", "acc-1");
    mockedGet.mockResolvedValueOnce({ success: true, data: USER });
    await useAuthStore.getState().loadSession();
    expect(useAuthStore.getState().user?.id).toBe("u1");
    expect(useAuthStore.getState().token).toBe("acc-1");
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it("loadSession with no token sets isLoading=false and no user", async () => {
    await useAuthStore.getState().loadSession();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it("loadSession clears invalid token when /auth/me fails", async () => {
    window.localStorage.setItem("medcore_token", "bad");
    mockedGet.mockRejectedValueOnce(new Error("401"));
    await useAuthStore.getState().loadSession();
    expect(useAuthStore.getState().user).toBeNull();
    expect(window.localStorage.getItem("medcore_token")).toBeNull();
  });

  // Issues #346 + #258: role-clobber defence — refuse to silently mutate
  // a cached user's role to a different role from /auth/me.
  it("refreshUser refuses to elevate role mid-session (Issues #346, #258)", async () => {
    window.localStorage.setItem("medcore_token", "acc-1");
    useAuthStore.setState({
      user: { ...USER, role: "RECEPTION" } as any,
      token: "acc-1",
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
      // Role-clobber guard: state should be cleared and token wiped.
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().token).toBeNull();
      expect(window.localStorage.getItem("medcore_token")).toBeNull();
    } finally {
      (window as any).location = original;
    }
  });

  it("loadSession refuses to elevate role on app boot (Issues #346, #258)", async () => {
    window.localStorage.setItem("medcore_token", "acc-1");
    // Pre-seed a cached RECEPTION session (e.g. from a previous tab).
    useAuthStore.setState({
      user: { ...USER, role: "RECEPTION" } as any,
      token: "acc-1",
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
    expect(window.localStorage.getItem("medcore_token")).toBeNull();
  });

  it("refreshUser still updates non-role fields when role matches", async () => {
    window.localStorage.setItem("medcore_token", "acc-1");
    useAuthStore.setState({
      user: { ...USER, name: "Old Name" } as any,
      token: "acc-1",
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
    // Pre-seed a Patient session in storage AND in-memory — the exact
    // production state before the bleed bug fired.
    window.localStorage.setItem("medcore_token", "patient-token");
    window.localStorage.setItem("medcore_refresh", "patient-refresh");
    useAuthStore.setState({
      user: { ...USER, id: "patient-id", role: "PATIENT" } as any,
      token: "patient-token",
      isLoading: false,
    });

    // Capture the state observed when the network call happens — at this
    // point the prior Patient state must already be wiped.
    let stateAtCallTime: { token: string | null; userId: string | undefined } | null = null;
    mockedPost.mockImplementationOnce(async () => {
      const s = useAuthStore.getState();
      stateAtCallTime = { token: s.token, userId: s.user?.id };
      // Also assert localStorage is empty at the time of the request.
      stateAtCallTime = {
        token: window.localStorage.getItem("medcore_token"),
        userId: s.user?.id,
      };
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
    // Prior token must be wiped from localStorage BEFORE the request runs.
    expect(stateAtCallTime!.token).toBeNull();
    // After login, the new Doctor seat is in place.
    expect(useAuthStore.getState().user?.id).toBe("doctor-id");
    expect(useAuthStore.getState().user?.role).toBe("DOCTOR");
    expect(useAuthStore.getState().token).toBe("doctor-acc");
    expect(window.localStorage.getItem("medcore_token")).toBe("doctor-acc");
  });

  it("late /me from prior user cannot clobber a new login (#422/#441)", async () => {
    // Set up a Patient session and KICK OFF refreshUser, but do NOT resolve
    // the /me promise yet. While the Patient /me probe is in flight, the
    // user navigates to /login and signs in as Doctor. The late /me must
    // NOT overwrite the Doctor user.
    window.localStorage.setItem("medcore_token", "patient-token");
    useAuthStore.setState({
      user: { ...USER, id: "patient-id", role: "PATIENT" } as any,
      token: "patient-token",
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
    expect(useAuthStore.getState().token).toBe("doctor-acc");
  });

  it("refreshUser refuses to adopt a different USER-ID via /me (#422/#441)", async () => {
    window.localStorage.setItem("medcore_token", "doctor-token");
    useAuthStore.setState({
      user: { ...USER, id: "doctor-id", role: "DOCTOR" } as any,
      token: "doctor-token",
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
      expect(window.localStorage.getItem("medcore_token")).toBeNull();
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
    window.localStorage.setItem("medcore_token", "patient-token");
    useAuthStore.setState({
      user: { ...USER, id: "patient-id", role: "PATIENT" } as any,
      token: "patient-token",
      isLoading: false,
    });
    let releaseMe: (v: unknown) => void = () => {};
    const mePromise = new Promise((r) => {
      releaseMe = r;
    });
    mockedGet.mockReturnValueOnce(mePromise);
    const refreshP = useAuthStore.getState().refreshUser();

    // User logs out before /me returns.
    useAuthStore.getState().logout();
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
});
