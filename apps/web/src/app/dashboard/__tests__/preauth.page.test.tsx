/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/preauth",
}));

import PreAuthPage from "../preauth/page";

const sample = [
  {
    id: "pa1",
    requestNumber: "PA-001",
    insuranceProvider: "Acme Health",
    policyNumber: "POL-1",
    procedureName: "Knee Replacement",
    estimatedCost: 250000,
    status: "PENDING",
    submittedAt: new Date().toISOString(),
    patient: {
      id: "p1",
      mrNumber: "MR-1",
      user: { name: "Aarav Mehta", phone: "9000000001" },
    },
  },
];

describe("PreAuthPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Pre-Authorization heading", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PreAuthPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /pre-authorization/i })
      ).toBeInTheDocument()
    );
  });

  it("renders populated request rows", async () => {
    apiMock.get.mockResolvedValue({ data: sample });
    render(<PreAuthPage />);
    await waitFor(() => expect(screen.getByText("PA-001")).toBeInTheDocument());
    expect(screen.getByText("Aarav Mehta")).toBeInTheDocument();
  });

  it("shows 'No requests in this category' empty state", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PreAuthPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no requests in this category/i)
      ).toBeInTheDocument()
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<PreAuthPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /pre-authorization/i })
      ).toBeInTheDocument()
    );
  });

  it("renders New Request button", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PreAuthPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /new request/i })
      ).toBeInTheDocument()
    );
  });
});
