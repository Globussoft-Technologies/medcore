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
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Pat", email: "p@x.com", role: "PATIENT" },
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

  it("renders Back-to-Dashboard and Sign-in links", () => {
    render(<NotAuthorizedPage />);
    expect(
      screen.getByRole("link", { name: /back to dashboard/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /sign in as a different user/i })
    ).toBeInTheDocument();
  });

  it("falls back to generic message when user is not signed in", () => {
    authMock.mockImplementation((selector?: any) => {
      const state = { user: null };
      return typeof selector === "function" ? selector(state) : state;
    });
    render(<NotAuthorizedPage />);
    expect(
      screen.getByText(/your account doesn't have access/i)
    ).toBeInTheDocument();
  });
});
