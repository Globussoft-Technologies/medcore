/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ExpensesPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/expenses/page.tsx, the ADMIN-only
 *     operational-expenses surface. Endpoints the page hits:
 *       GET    /expenses?from=&to=&category=    (rows)
 *       GET    /expenses/summary?from=&to=      (grand total + per-category)
 *       POST   /expenses                        (create — modal)
 *       DELETE /expenses/:id                    (per-row Delete)
 *
 *   - Behaviours covered:
 *       1. RBAC — non-ADMIN role (DOCTOR) triggers toast.error +
 *          router.replace("/dashboard/not-authorized?from=..."), and the
 *          fetch never fires (loader is role-gated).
 *       2. Loading branch — `expenses-loading` skeleton renders while the
 *          initial GET is pending; the heading and chrome still render.
 *       3. Happy fetch — KPI tile (grand total + transaction count), category
 *          breakdown bars, and one <tr> per ExpenseRecord render. The category
 *          GET querystring contract includes from/to/category.
 *       4. Empty branch — "No expenses found" copy when rows=[].
 *       5. Filter interactions — changing From/To/Category triggers a refetch
 *          with the new params.
 *       6. Inverted date guard — From > To toasts the inversion warning and
 *          skips the GET entirely (Issue #939).
 *       7. Add-Expense modal — opens, validates required Amount / positive
 *           Amount / required Description / future-date guard with inline
 *           errors, posts a well-shaped body, closes + reloads on success.
 *       8. POST error — surfaces error message in the modal; modal stays open.
 *       9. Delete flow — confirm() = true → DELETE fires + reload; confirm()
 *           = false → no DELETE. DELETE rejection surfaces toast.error.
 *      10. Error-path resilience — initial GET rejection still flips loading
 *           off and renders the empty branch.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            @/lib/use-dialog (useConfirm), next/navigation,
 *            @/components/Skeleton (stubbed to a div).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, routerMock, confirmMock } = vi.hoisted(
  () => ({
    apiMock: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    toastMock: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    },
    authMock: vi.fn(),
    routerMock: {
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    },
    confirmMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/expenses",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import ExpensesPage from "../page";

type ExpenseRow = {
  id: string;
  category: string;
  amount: number;
  description: string;
  date: string;
  paidTo?: string | null;
  referenceNo?: string | null;
  user: { id: string; name: string; role: string };
};

type SummaryResp = {
  grandTotal: number;
  transactionCount: number;
  byCategory: Array<{ category: string; count: number; total: number }>;
};

function rowFixture(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: "e1",
    category: "SALARY",
    amount: 50000,
    description: "Monthly payroll batch",
    date: "2026-05-10T00:00:00.000Z",
    paidTo: "Dr Mehta",
    referenceNo: "REF-001",
    user: { id: "u-admin", name: "Admin Boss", role: "ADMIN" },
    ...overrides,
  };
}

function summaryFixture(overrides: Partial<SummaryResp> = {}): SummaryResp {
  return {
    grandTotal: 72500,
    transactionCount: 3,
    byCategory: [
      { category: "SALARY", count: 1, total: 50000 },
      { category: "UTILITIES", count: 2, total: 22500 },
    ],
    ...overrides,
  };
}

function mockListAndSummary(
  rows: ExpenseRow[] = [rowFixture(), rowFixture({ id: "e2", category: "UTILITIES", amount: 22500, description: "Electric bill", paidTo: null, referenceNo: null })],
  summary: SummaryResp = summaryFixture(),
) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/expenses/summary")) {
      return Promise.resolve({ data: summary });
    }
    if (url.startsWith("/expenses")) {
      return Promise.resolve({ data: rows });
    }
    return Promise.resolve({ data: [] });
  });
}

function asAdmin() {
  authMock.mockReturnValue({
    user: {
      id: "u-admin",
      userId: "u-admin",
      role: "ADMIN",
      name: "Admin Boss",
      email: "admin@test.local",
    },
    isLoading: false,
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: {
      id: "u-doc",
      userId: "u-doc",
      role: "DOCTOR",
      name: "Dr Jane",
      email: "doc@test.local",
    },
    isLoading: false,
  });
}

describe("Expenses dashboard page (admin-only operational expenses)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    confirmMock.mockReset();
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects non-ADMIN (DOCTOR) to /dashboard/not-authorized and never fires the list GET", async () => {
    mockListAndSummary();
    asDoctor();

    render(<ExpensesPage />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized?from="),
      );
    });
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/restricted to Admin/i),
    );
    // The DOCTOR branch role-gates the loader — no GET should have fired.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the SkeletonTable loading branch while the initial GETs are pending", () => {
    // Hang both GETs so loading=true stays true.
    apiMock.get.mockReturnValue(new Promise(() => {}));

    render(<ExpensesPage />);

    expect(
      screen.getByRole("heading", { name: /^Expenses$/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("expenses-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("hits /expenses + /expenses/summary on mount and renders KPI + breakdown + one row per ExpenseRecord", async () => {
    mockListAndSummary();

    render(<ExpensesPage />);

    // Two rows render: SALARY + UTILITIES.
    await screen.findByText(/Monthly payroll batch/i);
    expect(screen.getByText(/Electric bill/i)).toBeInTheDocument();

    // KPI tile: grand total + transaction count.
    expect(screen.getByText("Rs. 72500.00")).toBeInTheDocument();
    expect(screen.getByText(/3 transactions/i)).toBeInTheDocument();

    // Breakdown bars — SALARY/UTILITIES copy appears in BOTH the row's
    // category pill AND the breakdown legend, so use getAllByText (>=2 each).
    expect(screen.getAllByText("SALARY").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("UTILITIES").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Rs\. 50000\.00 \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Rs\. 22500\.00 \(2\)/)).toBeInTheDocument();

    // Querystring contract — /expenses GET includes from/to (no category by default).
    const listCall = apiMock.get.mock.calls.find((c) =>
      /^\/expenses\?from=/.test(c[0] as string),
    );
    expect(listCall).toBeTruthy();
    const summaryCall = apiMock.get.mock.calls.find((c) =>
      /^\/expenses\/summary\?from=/.test(c[0] as string),
    );
    expect(summaryCall).toBeTruthy();

    // Admin sees the Add-Expense CTA.
    expect(
      screen.getByRole("button", { name: /Add Expense/i }),
    ).toBeInTheDocument();
  });

  it('renders "No expenses found" when the list is empty', async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/expenses/summary")) {
        return Promise.resolve({
          data: { grandTotal: 0, transactionCount: 0, byCategory: [] },
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<ExpensesPage />);

    expect(await screen.findByText(/No expenses found/i)).toBeInTheDocument();
    // Breakdown also empty.
    expect(screen.getByText(/^No data$/i)).toBeInTheDocument();
  });

  it("refetches with the new category filter when the Category dropdown changes", async () => {
    mockListAndSummary();

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    apiMock.get.mockClear();
    // Re-arm the impl after clearing — mockReset was not called here.
    mockListAndSummary();

    const categorySelect = document.getElementById(
      "expenses-filter-category",
    ) as HTMLSelectElement;
    expect(categorySelect).toBeTruthy();

    fireEvent.change(categorySelect, { target: { value: "RENT" } });

    await waitFor(() => {
      const call = apiMock.get.mock.calls.find((c) =>
        (c[0] as string).includes("category=RENT"),
      );
      expect(call).toBeTruthy();
    });
  });

  it("refetches when From / To date inputs change", async () => {
    mockListAndSummary();

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    apiMock.get.mockClear();
    mockListAndSummary();

    const fromInput = document.getElementById(
      "expenses-filter-from",
    ) as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: "2026-01-01" } });

    await waitFor(() => {
      const call = apiMock.get.mock.calls.find((c) =>
        (c[0] as string).includes("from=2026-01-01"),
      );
      expect(call).toBeTruthy();
    });
  });

  it("refuses to fetch when From > To (Issue #939 inverted-date guard)", async () => {
    mockListAndSummary();

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    apiMock.get.mockClear();

    // Set From to a date AFTER To. The default To is `today()`, so From=2099-01-01 inverts.
    const fromInput = document.getElementById(
      "expenses-filter-from",
    ) as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: "2099-01-01" } });

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/From.*before.*To/i),
      ),
    );
    // No GET should have been issued after the inversion.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("opens the Add-Expense modal and validates required Amount (Issue #458)", async () => {
    mockListAndSummary();

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Expense/i }));

    // Heading visible.
    expect(
      screen.getByRole("heading", { name: /Add Expense/i }),
    ).toBeInTheDocument();

    // Submit immediately — Amount empty triggers the JS-mirror validation.
    const form = screen
      .getByRole("heading", { name: /Add Expense/i })
      .closest("div")
      ?.parentElement?.querySelector("form") as HTMLFormElement;
    expect(form).toBeTruthy();
    fireEvent.submit(form);

    expect(await screen.findByTestId("expense-form-error")).toHaveTextContent(
      /Amount is required/i,
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects non-positive (< 0.01) amounts with the inline error", async () => {
    mockListAndSummary();

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Expense/i }));

    const amountInput = document.getElementById(
      "add-expense-amount",
    ) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "0" } });

    const form = amountInput.closest("form") as HTMLFormElement;
    fireEvent.submit(form);

    expect(await screen.findByTestId("expense-form-error")).toHaveTextContent(
      /at least 0\.01/i,
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects an empty Description with the inline error", async () => {
    mockListAndSummary();

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Expense/i }));

    fireEvent.change(
      document.getElementById("add-expense-amount") as HTMLInputElement,
      { target: { value: "100" } },
    );
    // Description left blank.
    const form = (
      document.getElementById("add-expense-amount") as HTMLInputElement
    ).closest("form") as HTMLFormElement;
    fireEvent.submit(form);

    expect(await screen.findByTestId("expense-form-error")).toHaveTextContent(
      /Description is required/i,
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects a future-dated expense with the Issue #64 guard", async () => {
    mockListAndSummary();

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Expense/i }));

    fireEvent.change(
      document.getElementById("add-expense-amount") as HTMLInputElement,
      { target: { value: "500" } },
    );
    fireEvent.change(
      document.getElementById("add-expense-description") as HTMLInputElement,
      { target: { value: "Test" } },
    );
    // Pick a date well in the future to dodge IST/UTC boundary flakes.
    fireEvent.change(
      document.getElementById("add-expense-date") as HTMLInputElement,
      { target: { value: "2099-12-31" } },
    );

    const form = (
      document.getElementById("add-expense-amount") as HTMLInputElement
    ).closest("form") as HTMLFormElement;
    fireEvent.submit(form);

    expect(await screen.findByTestId("expense-form-error")).toHaveTextContent(
      /cannot be in the future/i,
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("posts a well-shaped body, closes the modal, and reloads on success", async () => {
    mockListAndSummary();
    apiMock.post.mockResolvedValue({ data: { id: "e-new" } });

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Expense/i }));

    // Fill required fields.
    fireEvent.change(
      document.getElementById("add-expense-amount") as HTMLInputElement,
      { target: { value: "1234.56" } },
    );
    fireEvent.change(
      document.getElementById("add-expense-description") as HTMLInputElement,
      { target: { value: "Cleaning supplies" } },
    );
    fireEvent.change(
      document.getElementById("add-expense-paid-to") as HTMLInputElement,
      { target: { value: "Acme Supplies" } },
    );
    fireEvent.change(
      document.getElementById("add-expense-reference-no") as HTMLInputElement,
      { target: { value: "INV-9001" } },
    );
    // Pick a non-OTHER category via the category button row.
    fireEvent.click(screen.getByRole("button", { name: /^CONSUMABLES$/ }));

    apiMock.get.mockClear();
    mockListAndSummary();

    const form = (
      document.getElementById("add-expense-amount") as HTMLInputElement
    ).closest("form") as HTMLFormElement;
    fireEvent.submit(form);

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));

    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/expenses");
    expect(body).toMatchObject({
      category: "CONSUMABLES",
      amount: 1234.56,
      description: "Cleaning supplies",
      paidTo: "Acme Supplies",
      referenceNo: "INV-9001",
    });
    expect((body as any).date).toEqual(expect.any(String));

    // Modal closed.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Add Expense$/i }),
      ).not.toBeInTheDocument(),
    );

    // Reload was triggered (list GET fires again).
    await waitFor(() =>
      expect(
        apiMock.get.mock.calls.some((c) =>
          /^\/expenses\?from=/.test(c[0] as string),
        ),
      ).toBe(true),
    );
  });

  it("omits paidTo / referenceNo from the POST body when those fields are empty", async () => {
    mockListAndSummary();
    apiMock.post.mockResolvedValue({ data: { id: "e-new" } });

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Expense/i }));

    fireEvent.change(
      document.getElementById("add-expense-amount") as HTMLInputElement,
      { target: { value: "10" } },
    );
    fireEvent.change(
      document.getElementById("add-expense-description") as HTMLInputElement,
      { target: { value: "Postage" } },
    );

    const form = (
      document.getElementById("add-expense-amount") as HTMLInputElement
    ).closest("form") as HTMLFormElement;
    fireEvent.submit(form);

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.post.mock.calls[0];
    expect((body as any).paidTo).toBeUndefined();
    expect((body as any).referenceNo).toBeUndefined();
  });

  it("surfaces a POST rejection via the inline modal error and keeps the modal open", async () => {
    mockListAndSummary();
    apiMock.post.mockRejectedValue(new Error("server boom"));

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Expense/i }));

    fireEvent.change(
      document.getElementById("add-expense-amount") as HTMLInputElement,
      { target: { value: "99" } },
    );
    fireEvent.change(
      document.getElementById("add-expense-description") as HTMLInputElement,
      { target: { value: "Misc" } },
    );

    const form = (
      document.getElementById("add-expense-amount") as HTMLInputElement
    ).closest("form") as HTMLFormElement;
    fireEvent.submit(form);

    expect(await screen.findByTestId("expense-form-error")).toHaveTextContent(
      /server boom/i,
    );
    // Modal stays open so the user can retry.
    expect(
      screen.getByRole("heading", { name: /^Add Expense$/i }),
    ).toBeInTheDocument();
  });

  it("Cancel button closes the Add-Expense modal without posting", async () => {
    mockListAndSummary();

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Expense/i }));
    expect(
      screen.getByRole("heading", { name: /^Add Expense$/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Add Expense$/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Delete row: confirm=true → DELETE fires + reload + success toast", async () => {
    mockListAndSummary();
    apiMock.delete.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    const deleteBtn = screen.getByTestId("expense-delete-e1");
    apiMock.get.mockClear();
    mockListAndSummary();

    fireEvent.click(deleteBtn);

    await waitFor(() =>
      expect(apiMock.delete).toHaveBeenCalledWith("/expenses/e1"),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/Expense deleted/i),
    );
    // Reload was triggered.
    await waitFor(() =>
      expect(
        apiMock.get.mock.calls.some((c) =>
          /^\/expenses\?from=/.test(c[0] as string),
        ),
      ).toBe(true),
    );
  });

  it("Delete row: confirm=false → no DELETE fires", async () => {
    mockListAndSummary();
    confirmMock.mockResolvedValue(false);

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    fireEvent.click(screen.getByTestId("expense-delete-e1"));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(apiMock.delete).not.toHaveBeenCalled();
  });

  it("Delete row: DELETE rejection surfaces toast.error with the server message", async () => {
    mockListAndSummary();
    apiMock.delete.mockRejectedValue(new Error("nope"));
    confirmMock.mockResolvedValue(true);

    render(<ExpensesPage />);
    await screen.findByText(/Monthly payroll batch/i);

    fireEvent.click(screen.getByTestId("expense-delete-e1"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("nope"),
    );
  });

  it("silently swallows the initial GET rejection and renders the empty branch", async () => {
    apiMock.get.mockRejectedValue(new Error("server down"));

    render(<ExpensesPage />);

    expect(await screen.findByText(/No expenses found/i)).toBeInTheDocument();
    // grand total falls back to 0.00.
    expect(screen.getByText("Rs. 0.00")).toBeInTheDocument();
  });

  it("renders the row's paidTo / referenceNo / formatted amount", async () => {
    mockListAndSummary();

    render(<ExpensesPage />);

    const row = await screen.findByText(/Monthly payroll batch/i);
    const tr = row.closest("tr") as HTMLTableRowElement;
    expect(within(tr).getByText("Dr Mehta")).toBeInTheDocument();
    expect(within(tr).getByText("REF-001")).toBeInTheDocument();
    expect(within(tr).getByText("Rs. 50000.00")).toBeInTheDocument();
    expect(within(tr).getByText("Admin Boss")).toBeInTheDocument();
  });
});
