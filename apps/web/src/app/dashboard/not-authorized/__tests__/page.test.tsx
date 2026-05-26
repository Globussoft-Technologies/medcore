/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NotAuthorizedPage — adjacent-to-source coverage (test-cron pick 2026-05-25).
 *
 * What / which modules / why:
 *   - Verifies every branch of `apps/web/src/app/dashboard/not-authorized/page.tsx`,
 *     a client component that the dashboard's role-gate hooks redirect to when
 *     a user lacks permission for an admin page.
 *   - Behaviours covered:
 *       1. Renders the access-denied container, ShieldAlert icon, and
 *          "Access Denied" heading.
 *       2. Role-aware explanation copy:
 *          - Shows `Your role (X) doesn't have access` when `user.role` is set.
 *          - Falls back to `Your account doesn't have access` when user is null.
 *       3. `?from=` query-param branch:
 *          - Renders the "Requested page:" hint with the URL when `from` is set.
 *          - Renders the spacer div (no hint) when `from` is absent.
 *       4. Footer CTAs:
 *          - `Back to Dashboard` is a real <Link href="/dashboard">.
 *          - `Sign in as a different user` is a <button> (NOT a Link — Issue #594)
 *            with the canonical testid.
 *       5. handleSwitchUser handler (Issue #594):
 *          - On click, awaits `logout()` THEN calls `router.replace('/login')`.
 *          - During the await, the button is disabled and shows "Signing out…".
 *          - Even if `logout()` rejects, the user is still pushed to /login
 *            (finally-block escape from the screen).
 *          - Re-entrant click while already switching is a no-op (`if (switching) return`).
 *
 *   - Source under test: apps/web/src/app/dashboard/not-authorized/page.tsx
 *   - Mocks: @/lib/store (useAuthStore), next/navigation (useRouter/useSearchParams).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { authMock, routerMock, searchParamsMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    forward: vi.fn(),
  },
  searchParamsMock: { current: new URLSearchParams() },
}));

vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => searchParamsMock.current,
  usePathname: () => "/dashboard/not-authorized",
}));

import NotAuthorizedPage from "../page";

function setUser(
  user: { id?: string; name?: string; email?: string; role?: string } | null,
  logoutImpl: () => Promise<void> = async () => {}
) {
  const state: Record<string, unknown> = { user, logout: vi.fn(logoutImpl) };
  authMock.mockImplementation((selector?: any) =>
    typeof selector === "function" ? selector(state) : state
  );
  return state;
}

describe("NotAuthorizedPage", () => {
  beforeEach(() => {
    cleanup();
    authMock.mockReset();
    routerMock.push.mockReset();
    routerMock.replace.mockReset();
    routerMock.back.mockReset();
    searchParamsMock.current = new URLSearchParams();
    setUser({ id: "u1", name: "Pat", email: "p@x.com", role: "PATIENT" });
  });

  it("renders the access-denied container with the ShieldAlert icon and Access Denied heading", () => {
    render(<NotAuthorizedPage />);
    expect(screen.getByTestId("access-denied-page")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /access denied/i, level: 1 })
    ).toBeInTheDocument();
    // ShieldAlert renders an aria-hidden svg; assert presence via the container.
    const container = screen.getByTestId("access-denied-page");
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("shows the user's role in the explanation copy when user.role is set", () => {
    setUser({ id: "u1", role: "RECEPTION" });
    render(<NotAuthorizedPage />);
    expect(
      screen.getByText(/your role \(RECEPTION\) doesn't have access to this page/i)
    ).toBeInTheDocument();
  });

  it("falls back to the generic 'Your account doesn't have access' copy when user is null", () => {
    setUser(null);
    render(<NotAuthorizedPage />);
    expect(
      screen.getByText(/your account doesn't have access to this page/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/your role \(/i)).not.toBeInTheDocument();
  });

  it("falls back to the generic copy when user is present but role is missing", () => {
    setUser({ id: "u1" }); // no role
    render(<NotAuthorizedPage />);
    expect(
      screen.getByText(/your account doesn't have access to this page/i)
    ).toBeInTheDocument();
  });

  it("renders the 'Requested page:' hint with the URL when ?from= is set", () => {
    searchParamsMock.current = new URLSearchParams("from=/dashboard/admin-console");
    render(<NotAuthorizedPage />);
    expect(screen.getByText(/requested page:/i)).toBeInTheDocument();
    // The <code> element holds the URL.
    const code = screen.getByText("/dashboard/admin-console");
    expect(code.tagName).toBe("CODE");
  });

  it("omits the 'Requested page:' hint when ?from= is absent (spacer-div branch)", () => {
    render(<NotAuthorizedPage />);
    expect(screen.queryByText(/requested page:/i)).not.toBeInTheDocument();
  });

  it("renders 'Back to Dashboard' as a Link to /dashboard", () => {
    render(<NotAuthorizedPage />);
    const link = screen.getByRole("link", { name: /back to dashboard/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/dashboard");
  });

  it("renders 'Sign in as a different user' as a button (NOT a link) — Issue #594", () => {
    render(<NotAuthorizedPage />);
    const btn = screen.getByTestId("sign-in-as-different-user");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("type", "button");
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent(/sign in as a different user/i);
  });

  it("on click: awaits logout() THEN replaces with /login (Issue #594 happy path)", async () => {
    const callOrder: string[] = [];
    const logout = vi.fn(async () => {
      callOrder.push("logout");
    });
    routerMock.replace.mockImplementation(() => callOrder.push("replace"));
    setUser({ id: "u1", role: "PATIENT" }, logout);

    render(<NotAuthorizedPage />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("sign-in-as-different-user"));

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/login");
    });
    expect(logout).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["logout", "replace"]);
  });

  it("disables the button and shows 'Signing out…' while logout is in flight", async () => {
    let resolveLogout!: () => void;
    const logout = vi.fn(
      () => new Promise<void>((res) => (resolveLogout = res))
    );
    setUser({ id: "u1", role: "PATIENT" }, logout);

    render(<NotAuthorizedPage />);
    const btn = screen.getByTestId("sign-in-as-different-user");
    const user = userEvent.setup();
    await user.click(btn);

    // While the promise is pending the button should be disabled and the
    // pending-label rendered.
    await waitFor(() => {
      expect(btn).toBeDisabled();
      expect(btn).toHaveTextContent(/signing out/i);
    });
    expect(routerMock.replace).not.toHaveBeenCalled();

    // Resolve the in-flight logout and let the finally-block fire.
    resolveLogout();
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/login");
    });
  });

  it("still navigates to /login when logout() rejects (finally-block escape)", async () => {
    // The component's `handleSwitchUser` uses try/finally with no `.catch`,
    // and React invokes onClick without awaiting the returned Promise — so a
    // rejecting logout produces an unhandled rejection. The behaviour under
    // test (finally still runs router.replace) is correct; we just need to
    // swallow the expected rejection so it doesn't fail the suite.
    const expectedErr = new Error("network down");
    const swallow = (reason: unknown) => {
      if (reason === expectedErr) return; // expected — ignore
      throw reason as Error;
    };
    process.on("unhandledRejection", swallow);

    try {
      const logout = vi.fn(async () => {
        throw expectedErr;
      });
      setUser({ id: "u1", role: "PATIENT" }, logout);

      render(<NotAuthorizedPage />);
      const user = userEvent.setup();
      await user.click(screen.getByTestId("sign-in-as-different-user"));

      await waitFor(() => {
        expect(routerMock.replace).toHaveBeenCalledWith("/login");
      });
      expect(logout).toHaveBeenCalledTimes(1);
      // Let the microtask queue flush the unhandled-rejection event so our
      // handler captures it before the test exits.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", swallow);
    }
  });

  it("ignores a re-entrant click while already switching (early `if (switching) return`)", async () => {
    let resolveLogout!: () => void;
    const logout = vi.fn(
      () => new Promise<void>((res) => (resolveLogout = res))
    );
    setUser({ id: "u1", role: "PATIENT" }, logout);

    render(<NotAuthorizedPage />);
    const btn = screen.getByTestId("sign-in-as-different-user");
    const user = userEvent.setup();

    await user.click(btn);
    // The button is now disabled — userEvent.click will short-circuit, but
    // to truly cover the `if (switching) return` early-out we also call the
    // underlying onClick once more via .click() bypassing the disabled check.
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Still only one logout invocation despite the extra dispatched clicks.
    expect(logout).toHaveBeenCalledTimes(1);

    resolveLogout();
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/login");
    });
  });
});
