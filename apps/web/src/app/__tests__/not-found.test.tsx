/**
 * Covers `apps/web/src/app/not-found.tsx` — Next.js 15 global 404 page.
 *
 * Issue #705 contract: render auth-state-branched CTAs so logged-in users
 * landing on a typo'd URL aren't told to "Sign in" (which used to imply
 * their session had expired). The page reads `useAuthStore((s) => s.user)`
 * and branches:
 *   - Anon  → Sign in (/login)  /  Back to home (/)
 *   - Authed → Back (router.back || /dashboard) / Home (/dashboard) /
 *              Search (/dashboard?openSearch=1)
 *
 * The Back button additionally falls back to /dashboard when
 * `window.history.length <= 1` (direct deep-link with no back history).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { authSelectorMock, pushMock, backMock } = vi.hoisted(() => ({
  // Holds whatever value the selector should return for `s.user`. Tests
  // mutate `.value` between renders. The mock implements the selector
  // contract: `useAuthStore((s) => s.user)`.
  authSelectorMock: { value: null as null | Record<string, unknown> },
  pushMock: vi.fn(),
  backMock: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  useAuthStore: (selector: (s: { user: unknown }) => unknown) =>
    selector({ user: authSelectorMock.value }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, back: backMock, replace: vi.fn() }),
}));

import NotFound from "../not-found";

describe("NotFound — anonymous visitor", () => {
  beforeEach(() => {
    authSelectorMock.value = null;
    pushMock.mockReset();
    backMock.mockReset();
  });

  it("renders the 404 page chrome (testid + heading + 404 marker + helper copy)", () => {
    render(<NotFound />);
    expect(screen.getByTestId("not-found-page")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /page not found/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(
      screen.getByText(/doesn't exist or has been moved/i),
    ).toBeInTheDocument();
  });

  it("renders the Sign in CTA pointing at /login", () => {
    render(<NotFound />);
    const signin = screen.getByTestId("not-found-signin-link");
    expect(signin).toBeInTheDocument();
    expect(signin).toHaveAttribute("href", "/login");
    expect(signin).toHaveTextContent(/sign in/i);
  });

  it("renders the Back to home CTA pointing at /", () => {
    render(<NotFound />);
    const home = screen.getByTestId("not-found-home-link");
    expect(home).toBeInTheDocument();
    expect(home).toHaveAttribute("href", "/");
    expect(home).toHaveTextContent(/back to home/i);
  });

  it("does NOT render any authed-only CTAs (Issue #705 regression guard)", () => {
    render(<NotFound />);
    expect(
      screen.queryByTestId("not-found-back-btn"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("not-found-dashboard-link"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("not-found-search-link"),
    ).not.toBeInTheDocument();
  });
});

describe("NotFound — authed visitor (Issue #705 fix)", () => {
  beforeEach(() => {
    authSelectorMock.value = { id: "u-1", role: "DOCTOR" };
    pushMock.mockReset();
    backMock.mockReset();
  });

  it("renders the Back button, Home link, and Search link", () => {
    render(<NotFound />);
    expect(screen.getByTestId("not-found-back-btn")).toBeInTheDocument();
    const dash = screen.getByTestId("not-found-dashboard-link");
    expect(dash).toHaveAttribute("href", "/dashboard");
    expect(dash).toHaveTextContent(/home/i);
    const search = screen.getByTestId("not-found-search-link");
    expect(search).toHaveAttribute("href", "/dashboard?openSearch=1");
    expect(search).toHaveTextContent(/search/i);
  });

  it("does NOT render the anon Sign in / Back to home CTAs", () => {
    render(<NotFound />);
    expect(
      screen.queryByTestId("not-found-signin-link"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("not-found-home-link"),
    ).not.toBeInTheDocument();
  });

  it("Back button calls router.back() when window.history.length > 1", async () => {
    // jsdom's history persists across tests in this file. Push enough entries
    // to guarantee length > 1 regardless of prior state.
    window.history.pushState({}, "", "/dashboard");
    window.history.pushState({}, "", "/404-target");
    expect(window.history.length).toBeGreaterThan(1);
    const user = userEvent.setup();
    render(<NotFound />);
    await user.click(screen.getByTestId("not-found-back-btn"));
    expect(backMock).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("Back button falls back to router.push('/dashboard') when history is empty", async () => {
    // Stub window.history.length to 1 (the single direct-deep-link case).
    const originalHistory = window.history;
    Object.defineProperty(window, "history", {
      configurable: true,
      value: {
        ...originalHistory,
        length: 1,
        pushState: originalHistory.pushState.bind(originalHistory),
        replaceState: originalHistory.replaceState.bind(originalHistory),
        back: originalHistory.back.bind(originalHistory),
        forward: originalHistory.forward.bind(originalHistory),
        go: originalHistory.go.bind(originalHistory),
      },
    });
    try {
      const user = userEvent.setup();
      render(<NotFound />);
      await user.click(screen.getByTestId("not-found-back-btn"));
      expect(pushMock).toHaveBeenCalledWith("/dashboard");
      expect(backMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "history", {
        configurable: true,
        value: originalHistory,
      });
    }
  });
});
