/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, routerMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/abdm",
}));

import AbdmPage from "./page";

describe("AbdmPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerMock.push.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Dr Asha", role: "DOCTOR" },
      isLoading: false,
    });
  });

  it("renders the heading, SANDBOX banner and the three tabs", () => {
    render(<AbdmPage />);
    expect(screen.getByRole("heading", { name: /abdm.*abha/i })).toBeInTheDocument();
    expect(screen.getByText(/SANDBOX MODE/i)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /link abha/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /consents/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /care contexts/i })).toBeInTheDocument();
  });

  it("shows a loading spinner while the auth store is loading", () => {
    authMock.mockReturnValue({ user: null, isLoading: true });
    const { container } = render(<AbdmPage />);
    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();
  });

  it("redirects a NURSE user away from the page", async () => {
    authMock.mockReturnValue({
      user: { id: "u1", name: "Nurse", role: "NURSE" },
      isLoading: false,
    });
    render(<AbdmPage />);
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("shows an error when the ABHA verify call fails", async () => {
    apiMock.post.mockRejectedValueOnce(new Error("Network down"));
    const user = userEvent.setup();
    render(<AbdmPage />);
    const input = screen.getByPlaceholderText(/rahul@sbx/i);
    await user.type(input, "test@sbx");
    await user.click(screen.getByRole("button", { name: /verify abha/i }));
    await waitFor(() => expect(screen.getByText(/network down/i)).toBeInTheDocument());
  });
});
