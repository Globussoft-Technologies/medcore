/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, toastMock, routerPush } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  routerPush: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: any) => <>{children}</>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/reports",
}));

import ReportsPage from "../reports/page";

const dailyReport = {
  totalCollection: 12500,
  transactionCount: 5,
  pendingInvoices: 2,
  paymentModeBreakdown: { CASH: 8000, CARD: 4500 },
  recentPayments: [
    {
      id: "pm1",
      amount: 4500,
      mode: "CARD",
      paidAt: new Date().toISOString(),
      patient: { user: { name: "Aarav Mehta" } },
    },
  ],
};

describe("ReportsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    routerPush.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Billing Reports heading for ADMIN", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/billing/reports/daily"))
        return Promise.resolve({
          data: {
            totalCollection: 0,
            transactionCount: 0,
            pendingInvoices: 0,
            paymentModeBreakdown: {},
            recentPayments: [],
          },
        });
      return Promise.resolve({ data: [] });
    });
    render(<ReportsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /billing reports/i })
      ).toBeInTheDocument()
    );
  });

  it("renders Total Collection summary card with populated value", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/billing/reports/daily"))
        return Promise.resolve({ data: dailyReport });
      return Promise.resolve({ data: [] });
    });
    render(<ReportsPage />);
    await waitFor(() =>
      expect(screen.getByText(/total collection/i)).toBeInTheDocument()
    );
    expect(screen.getAllByText(/12500\.00|12,500/).length).toBeGreaterThan(0);
  });

  it("shows 'No payments recorded' when mode-breakdown empty", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/billing/reports/daily"))
        return Promise.resolve({
          data: {
            totalCollection: 0,
            transactionCount: 0,
            pendingInvoices: 0,
            paymentModeBreakdown: {},
            recentPayments: [],
          },
        });
      return Promise.resolve({ data: [] });
    });
    render(<ReportsPage />);
    await waitFor(() =>
      expect(screen.getByText(/no payments recorded/i)).toBeInTheDocument()
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<ReportsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /billing reports/i })
      ).toBeInTheDocument()
    );
  });

  it("redirects non-ADMIN role away from page", async () => {
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u9", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
    render(<ReportsPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard")
    );
  });
});
