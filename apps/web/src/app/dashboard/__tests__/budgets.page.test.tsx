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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/budgets",
}));

import BudgetsPage from "../budgets/page";

function asAdmin() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asReception() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u2", name: "Rec", email: "r@x.com", role: "RECEPTION" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("BudgetsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerPush.mockReset();
  });

  it("smoke renders the page heading for ADMIN", async () => {
    asAdmin();
    apiMock.get.mockResolvedValue({
      data: { year: 2026, month: 5, rows: [], uncategorizedActual: [] },
    });
    render(<BudgetsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /budgets/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the no-budgets-set hint when rows are empty", async () => {
    asAdmin();
    apiMock.get.mockResolvedValue({
      data: { year: 2026, month: 5, rows: [], uncategorizedActual: [] },
    });
    render(<BudgetsPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no budgets set for this month/i)
      ).toBeInTheDocument()
    );
  });

  it("renders rows when budgets exist", async () => {
    asAdmin();
    apiMock.get.mockResolvedValue({
      data: {
        year: 2026,
        month: 5,
        totalBudget: 50000,
        totalSpent: 30000,
        rows: [
          {
            category: "SALARY",
            budget: 50000,
            actual: 30000,
            variance: -20000,
            utilisation: 60,
          },
        ],
        uncategorizedActual: [],
      },
    });
    render(<BudgetsPage />);
    await waitFor(() =>
      expect(screen.getByText(/SALARY/i)).toBeInTheDocument()
    );
    expect(screen.getByTestId("kpi-total-spent").textContent).toMatch(/30,000/);
  });

  it("redirects RECEPTION away (admin-only page)", async () => {
    asReception();
    render(<BudgetsPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("keeps rendering when the budgets endpoint rejects", async () => {
    asAdmin();
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<BudgetsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /budgets/i })
      ).toBeInTheDocument()
    );
  });
});
