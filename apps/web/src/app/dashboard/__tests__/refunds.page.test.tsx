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
  usePathname: () => "/dashboard/refunds",
}));

import RefundsPage from "../refunds/page";

const sample = {
  refunds: [
    {
      id: "r1",
      paidAt: new Date().toISOString(),
      amount: 1500,
      mode: "CASH",
      reason: "Cancelled procedure",
      invoice: {
        id: "inv1",
        invoiceNumber: "INV-001",
        totalAmount: 5000,
        patient: {
          user: { name: "Aarav Mehta", phone: "9000000001" },
        },
      },
    },
  ],
  totalRefunded: 1500,
  count: 1,
};

describe("RefundsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Refunds heading", async () => {
    apiMock.get.mockResolvedValue({
      data: { refunds: [], totalRefunded: 0, count: 0 },
    });
    render(<RefundsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /refunds/i })
      ).toBeInTheDocument()
    );
  });

  it("renders populated refund row + total", async () => {
    apiMock.get.mockResolvedValue({ data: sample });
    render(<RefundsPage />);
    await waitFor(() => expect(screen.getByText("INV-001")).toBeInTheDocument());
    expect(screen.getByText("Aarav Mehta")).toBeInTheDocument();
    expect(screen.getAllByText(/1,500/).length).toBeGreaterThan(0);
  });

  it("shows 'No refunds in this period' empty state", async () => {
    apiMock.get.mockResolvedValue({
      data: { refunds: [], totalRefunded: 0, count: 0 },
    });
    render(<RefundsPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no refunds in this period/i)
      ).toBeInTheDocument()
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<RefundsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /refunds/i })
      ).toBeInTheDocument()
    );
  });

  it("renders Apply filter button", async () => {
    apiMock.get.mockResolvedValue({
      data: { refunds: [], totalRefunded: 0, count: 0 },
    });
    render(<RefundsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /apply/i })
      ).toBeInTheDocument()
    );
  });
});
