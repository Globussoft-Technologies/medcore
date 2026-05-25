/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/expenses",
}));

import ExpensesPage from "../expenses/page";

const sampleExpenses = [
  {
    id: "e1",
    description: "Electricity bill",
    category: "UTILITIES",
    amount: 5000,
    spentOn: new Date().toISOString(),
    notes: "",
  },
];

const sampleSummary = {
  grandTotal: 5000,
  transactionCount: 1,
  byCategory: [{ category: "UTILITIES", total: 5000, count: 1 }],
};

describe("ExpensesPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.delete.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders heading with empty data", async () => {
    apiMock.get.mockResolvedValue({ data: { grandTotal: 0, transactionCount: 0, byCategory: [] } });
    apiMock.get.mockResolvedValueOnce({ data: [] });
    render(<ExpensesPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /expenses/i })).toBeInTheDocument()
    );
  });

  it("renders populated summary + expenses", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/expenses/summary"))
        return Promise.resolve({ data: sampleSummary });
      if (url.startsWith("/expenses"))
        return Promise.resolve({ data: sampleExpenses });
      return Promise.resolve({ data: [] });
    });
    render(<ExpensesPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/electricity bill/i).length).toBeGreaterThan(0)
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<ExpensesPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /expenses/i })).toBeInTheDocument()
    );
  });

  it("clicking Add Expense opens modal", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/expenses/summary"))
        return Promise.resolve({ data: sampleSummary });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<ExpensesPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /add expense/i })
    );
    await user.click(screen.getByRole("button", { name: /add expense/i }));
    await waitFor(() =>
      expect(screen.getAllByText(/add expense/i).length).toBeGreaterThan(1)
    );
  });

  // Issue #939: inverting From > To previously fired the API and silently
  // returned zero rows. Page must now toast and skip the network call.
  it("rejects an inverted From > To range with a toast and no /expenses fetch", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/expenses/summary"))
        return Promise.resolve({ data: sampleSummary });
      if (url.startsWith("/expenses"))
        return Promise.resolve({ data: sampleExpenses });
      return Promise.resolve({ data: [] });
    });
    render(<ExpensesPage />);
    // Wait for mount-time fetches to land then drain microtasks so any
    // post-commit effect chain settles BEFORE we clear the mock spy.
    await waitFor(() =>
      expect(
        apiMock.get.mock.calls.filter((c) => String(c[0]).startsWith("/expenses")).length
      ).toBeGreaterThanOrEqual(2)
    );
    await new Promise((r) => setTimeout(r, 50));
    apiMock.get.mockClear();
    toastErrorMock.mockClear();
    const toInput = document.getElementById("expenses-filter-to") as HTMLInputElement;
    // Default `from` is firstOfMonth (~2026-04-30 or 2026-05-01 depending on
    // tz); setting `to` to a much earlier date inverts the range on the
    // single change → guard fires with no intermediate valid state.
    fireEvent.change(toInput, { target: { value: "2026-01-01" } });
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/must be on or before/i))
    );
    const expenseFetchCalls = apiMock.get.mock.calls.filter((c) =>
      String(c[0]).startsWith("/expenses")
    );
    expect(expenseFetchCalls).toHaveLength(0);
  });

  it("shows Rs. total in summary", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/expenses/summary"))
        return Promise.resolve({ data: sampleSummary });
      return Promise.resolve({ data: sampleExpenses });
    });
    render(<ExpensesPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/Rs\./).length).toBeGreaterThan(0)
    );
  });
});
