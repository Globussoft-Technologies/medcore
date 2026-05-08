/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { authMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/not-authorized",
}));

import NotAuthorizedPage from "../not-authorized/page";

describe("NotAuthorizedPage", () => {
  beforeEach(() => {
    // Issue #594: the page now reads `logout` off the store as well. Stub it
    // so `useAuthStore((s) => s.logout)` returns a no-op vi.fn.
    authMock.mockImplementation((selector?: any) => {
      const state: Record<string, unknown> = {
        user: { id: "u1", name: "Pat", email: "p@x.com", role: "PATIENT" },
        logout: vi.fn(),
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders the access-denied container", () => {
    render(<NotAuthorizedPage />);
    expect(screen.getByTestId("access-denied-page")).toBeInTheDocument();
  });

  it("shows the Access Denied heading", () => {
    render(<NotAuthorizedPage />);
    expect(
      screen.getByRole("heading", { name: /access denied/i })
    ).toBeInTheDocument();
  });

  it("mentions the user's role in the explanation", () => {
    render(<NotAuthorizedPage />);
    expect(screen.getByText(/PATIENT/)).toBeInTheDocument();
  });

  it("renders Back-to-Dashboard link and Sign-in switch button", () => {
    // Issue #594: "Sign in as a different user" was upgraded from a plain
    // <Link> to an actual button that calls logout() before navigating to
    // /login. The test asserts both shapes (a remaining <Link> for
    // "Back to Dashboard" and a button with the right testid for the
    // identity-switch action).
    render(<NotAuthorizedPage />);
    expect(
      screen.getByRole("link", { name: /back to dashboard/i })
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("sign-in-as-different-user")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in as a different user/i })
    ).toBeInTheDocument();
  });

  it("falls back to generic message when user is not signed in", () => {
    authMock.mockImplementation((selector?: any) => {
      const state: Record<string, unknown> = { user: null, logout: vi.fn() };
      return typeof selector === "function" ? selector(state) : state;
    });
    render(<NotAuthorizedPage />);
    expect(
      screen.getByText(/your account doesn't have access/i)
    ).toBeInTheDocument();
  });
});
