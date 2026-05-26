/* eslint-disable @typescript-eslint/no-explicit-any */
// Layout-focused tests for the super-admin route group shell (gap #6 piece 1).
//
// Sibling `landing.page.test.tsx` covers the high-level RBAC gate via
// <SuperAdminLayout><SuperAdminLandingPage /></SuperAdminLayout> compositions
// but stops short of the layout's chrome internals: the loading spinner, the
// user-name slot in the topbar, the brand link, the footer copy, the
// signed-out flow (logout + window.location.replace("/login")), and the
// `tenantId === undefined` branch of the gate (the `?? null` fallback).
// This file fills those gaps and pushes layout.tsx coverage toward 100%.
//
// Mock contract mirrors landing.page.test.tsx — useAuthStore as a callable
// selector + next/navigation with routerReplace as the assertion target.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { authMock, routerReplace, routerPush, toastMock, logoutMock, loadSessionMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    routerReplace: vi.fn(),
    routerPush: vi.fn(),
    toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
    logoutMock: vi.fn(async () => undefined),
    loadSessionMock: vi.fn(async () => undefined),
  }));

vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/super-admin",
}));

import SuperAdminLayout from "../layout";

type MockUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  tenantId?: string | null;
};

function mockAuth(state: {
  user: MockUser | null;
  isLoading?: boolean;
  loadSession?: () => Promise<void>;
  logout?: () => Promise<void>;
}) {
  const full = {
    user: state.user,
    isLoading: state.isLoading ?? false,
    loadSession: state.loadSession ?? loadSessionMock,
    logout: state.logout ?? logoutMock,
  };
  authMock.mockImplementation((selector?: any) =>
    typeof selector === "function" ? selector(full) : full,
  );
}

describe("SuperAdminLayout — chrome + gate internals", () => {
  // Capture original window.location so we can restore between sign-out tests
  // that re-stub it (jsdom forbids direct assignment without a redefine dance).
  let originalLocation: Location;

  beforeEach(() => {
    authMock.mockReset();
    routerReplace.mockReset();
    routerPush.mockReset();
    toastMock.error.mockReset();
    logoutMock.mockReset();
    logoutMock.mockResolvedValue(undefined);
    loadSessionMock.mockReset();
    loadSessionMock.mockResolvedValue(undefined);
    originalLocation = window.location;
  });

  afterEach(() => {
    // Restore window.location after sign-out tests that replaced it.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it("renders the loading spinner while hydrating (user=null, isLoading=true)", () => {
    mockAuth({ user: null, isLoading: true });
    render(
      <SuperAdminLayout>
        <div data-testid="child">child</div>
      </SuperAdminLayout>,
    );
    const loader = screen.getByTestId("super-admin-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("role", "status");
    expect(loader).toHaveAttribute("aria-busy", "true");
    expect(loader).toHaveAttribute("aria-live", "polite");
    expect(loader.textContent).toMatch(/loading super-admin/i);
    // The shell + children are NOT mounted while hydrating.
    expect(screen.queryByTestId("super-admin-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();
  });

  it("renders children for an ADMIN with tenantId === null (happy path)", async () => {
    mockAuth({
      user: {
        id: "u1",
        name: "Pearl Ops",
        email: "ops@pearl-erp.in",
        role: "ADMIN",
        tenantId: null,
      },
    });
    render(
      <SuperAdminLayout>
        <div data-testid="child">hello super-admin</div>
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("super-admin-shell")).toBeInTheDocument();
    });
    expect(screen.getByTestId("child")).toHaveTextContent("hello super-admin");
    expect(routerReplace).not.toHaveBeenCalled();
    // Topbar essentials present.
    expect(screen.getByTestId("super-admin-topbar")).toBeInTheDocument();
    expect(screen.getByTestId("super-admin-brand")).toHaveAttribute(
      "href",
      "/super-admin",
    );
    expect(screen.getByTestId("super-admin-user-name").textContent).toBe(
      "Pearl Ops",
    );
    // Footer copy carries the Pearl §8 attribution.
    expect(
      screen.getByText(/super-admin console — pearl §8/i),
    ).toBeInTheDocument();
  });

  it("treats `tenantId === undefined` as null (super-admin) — exercises the ?? null fallback", async () => {
    mockAuth({
      user: {
        id: "u1",
        name: "Pearl Ops",
        email: "ops@pearl-erp.in",
        role: "ADMIN",
        // tenantId intentionally omitted (=== undefined). The layout's
        // (user.tenantId ?? null) === null check MUST treat this as super-admin.
      },
    });
    render(
      <SuperAdminLayout>
        <div data-testid="child">ok</div>
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("super-admin-shell")).toBeInTheDocument();
    });
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("redirects ADMIN with tenantId set (tenant operator, not super-admin)", async () => {
    mockAuth({
      user: {
        id: "u2",
        name: "St. Johns Admin",
        email: "admin@stjohns.local",
        role: "ADMIN",
        tenantId: "tenant-stjohns",
      },
    });
    render(
      <SuperAdminLayout>
        <div data-testid="child">should not render</div>
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized"),
      );
    });
    // Belt-and-suspenders render-time guard returns null → no shell, no child.
    expect(screen.queryByTestId("super-admin-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();
    // Toast fired with the operator-friendly explanation.
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/super-admin access required/i),
    );
    // The redirect URL carries the `from` param so /dashboard/not-authorized
    // can surface where the user came from.
    const target = routerReplace.mock.calls[0][0] as string;
    expect(target).toContain("from=");
    expect(decodeURIComponent(target)).toContain("/super-admin");
  });

  it("redirects a non-ADMIN role (DOCTOR) to /dashboard/not-authorized", async () => {
    mockAuth({
      user: {
        id: "u3",
        name: "Dr. Default",
        email: "doc@stjohns.local",
        role: "DOCTOR",
        tenantId: null,
      },
    });
    render(
      <SuperAdminLayout>
        <div data-testid="child">forbidden</div>
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized"),
      );
    });
    expect(screen.queryByTestId("super-admin-shell")).not.toBeInTheDocument();
  });

  it("redirects an unauthenticated visitor (user=null) to /login with redirect param carrying current URL", async () => {
    // Override the location pathname so we can verify the redirect param
    // carries the actual entry URL (not just the default).
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        ...originalLocation,
        pathname: "/super-admin/tenants",
        search: "?foo=bar",
        hash: "#section",
      },
    });
    mockAuth({ user: null });
    render(
      <SuperAdminLayout>
        <div data-testid="child">never</div>
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith(
        expect.stringContaining("/login?redirect="),
      );
    });
    const url = routerReplace.mock.calls[0][0] as string;
    // Encoded redirect target must contain the full entry URL.
    expect(decodeURIComponent(url)).toContain("/super-admin/tenants?foo=bar#section");
  });

  it("does NOT fire a toast on the unauthenticated bounce (no session to expire)", async () => {
    mockAuth({ user: null });
    render(
      <SuperAdminLayout>
        <div data-testid="child">never</div>
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalled();
    });
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("calls loadSession once on mount (even if user is already populated)", async () => {
    mockAuth({
      user: {
        id: "u1",
        name: "Pearl Ops",
        email: "ops@pearl-erp.in",
        role: "ADMIN",
        tenantId: null,
      },
      loadSession: loadSessionMock,
    });
    render(
      <SuperAdminLayout>
        <div data-testid="child">ok</div>
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("super-admin-shell")).toBeInTheDocument();
    });
    expect(loadSessionMock).toHaveBeenCalledTimes(1);
  });

  it("swallows loadSession errors and still settles into a render (error-path resilience)", async () => {
    const erroringLoad = vi.fn(async () => {
      throw new Error("session probe failed");
    });
    mockAuth({
      user: {
        id: "u1",
        name: "Pearl Ops",
        email: "ops@pearl-erp.in",
        role: "ADMIN",
        tenantId: null,
      },
      loadSession: erroringLoad,
    });
    render(
      <SuperAdminLayout>
        <div data-testid="child">ok</div>
      </SuperAdminLayout>,
    );
    // After the catch, hydrating flips false and the gate proceeds — the
    // shell renders because the store already had a valid super-admin user.
    await waitFor(() => {
      expect(screen.getByTestId("super-admin-shell")).toBeInTheDocument();
    });
    expect(erroringLoad).toHaveBeenCalledTimes(1);
  });

  it("Sign-out button calls logout() then window.location.replace('/login')", async () => {
    // Stub window.location.replace so we can assert it was called without
    // jsdom complaining about navigation.
    const locationReplace = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        ...originalLocation,
        replace: locationReplace,
        pathname: "/super-admin",
        search: "",
        hash: "",
      },
    });
    mockAuth({
      user: {
        id: "u1",
        name: "Pearl Ops",
        email: "ops@pearl-erp.in",
        role: "ADMIN",
        tenantId: null,
      },
      logout: logoutMock,
    });
    render(
      <SuperAdminLayout>
        <div>ok</div>
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("super-admin-sign-out")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("super-admin-sign-out"));
    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(locationReplace).toHaveBeenCalledWith("/login");
    });
  });

  it("Sign-out still navigates to /login even when logout() rejects (finally branch)", async () => {
    // Swallow the unhandled rejection that propagates out of the inline async
    // onClick handler (the source's try/finally has no .catch on the await —
    // by design, since the finally always navigates). Both jsdom-level and
    // process-level listeners are installed because vitest checks both.
    const swallow = (event: any) => {
      if (event?.preventDefault) event.preventDefault();
    };
    const processSwallow = () => undefined;
    if (typeof window !== "undefined") {
      window.addEventListener("unhandledrejection", swallow);
    }
    process.on("unhandledRejection", processSwallow);

    const locationReplace = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        ...originalLocation,
        replace: locationReplace,
        pathname: "/super-admin",
        search: "",
        hash: "",
      },
    });
    const failingLogout = vi.fn(() => Promise.reject(new Error("logout API 500")));
    mockAuth({
      user: {
        id: "u1",
        name: "Pearl Ops",
        email: "ops@pearl-erp.in",
        role: "ADMIN",
        tenantId: null,
      },
      logout: failingLogout,
    });
    render(
      <SuperAdminLayout>
        <div>ok</div>
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("super-admin-sign-out")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("super-admin-sign-out"));
    await waitFor(() => {
      expect(failingLogout).toHaveBeenCalledTimes(1);
    });
    // finally clause runs regardless — the user still ends up on /login.
    await waitFor(() => {
      expect(locationReplace).toHaveBeenCalledWith("/login");
    });

    // Unregister the listeners (per-test scoping).
    if (typeof window !== "undefined") {
      window.removeEventListener("unhandledrejection", swallow);
    }
    process.off("unhandledRejection", processSwallow);
  });

  it("topbar carries the ShieldCheck-anchored brand link and a Sign Out button with correct accessible label", async () => {
    mockAuth({
      user: {
        id: "u1",
        name: "Pearl Ops",
        email: "ops@pearl-erp.in",
        role: "ADMIN",
        tenantId: null,
      },
    });
    render(
      <SuperAdminLayout>
        <div>ok</div>
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("super-admin-shell")).toBeInTheDocument();
    });
    // The brand link text contains the literal "MedCore Super-Admin" string.
    const brand = screen.getByTestId("super-admin-brand");
    expect(brand.textContent).toMatch(/medcore super-admin/i);
    // The Sign Out button carries visible text + type=button (not a submit).
    const signOut = screen.getByTestId("super-admin-sign-out");
    expect(signOut).toHaveAttribute("type", "button");
    expect(signOut.textContent).toMatch(/sign out/i);
  });

  it("renders a <main> region wrapping the children (semantic landmark)", async () => {
    mockAuth({
      user: {
        id: "u1",
        name: "Pearl Ops",
        email: "ops@pearl-erp.in",
        role: "ADMIN",
        tenantId: null,
      },
    });
    render(
      <SuperAdminLayout>
        <div data-testid="payload">payload-content</div>
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("super-admin-shell")).toBeInTheDocument();
    });
    const main = screen.getByRole("main");
    expect(main).toBeInTheDocument();
    expect(main).toContainElement(screen.getByTestId("payload"));
  });
});
