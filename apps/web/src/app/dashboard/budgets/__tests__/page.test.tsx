/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BudgetsPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/budgets/page.tsx, the ADMIN-only
 *     monthly budgets vs actual surface. Endpoints the page hits:
 *       GET  /expenses/budgets?year=&month=     (rows + totals + uncategorised)
 *       POST /expenses/budgets                  (upsert by category+year+month)
 *
 *   - Behaviours covered:
 *       1. RBAC — non-ADMIN role (DOCTOR) triggers router.push("/dashboard"),
 *          render short-circuits to null, and the GET never fires.
 *       2. Loading branch — `budgets-loading` skeleton renders while the
 *          initial GET is pending; heading + chrome still render.
 *       3. Happy fetch — KPI tiles render server totals (Total Budget,
 *          Total Spent, Variance) plus the uncategorised-spend subtitle
 *          when present, and one row per BudgetRow renders with the
 *          server-canonical `utilisation` value and consistent variance pill.
 *       4. Empty branch — "No budgets set for this month." copy when rows=[].
 *       5. Fallback totals — when server omits the new total fields the
 *          KPI tiles roll up from rows client-side (legacy compatibility).
 *       6. Month change — typing into the <input type="month"> triggers a
 *          refetch with the new year/month in the querystring.
 *       7. Set Budget modal — opens, validates empty/non-numeric/negative
 *          amounts via toast.warning, posts a well-shaped body, toasts
 *          success, closes, and reloads.
 *       8. Edit modal — per-row Edit button pre-populates the form, locks
 *            the category select, and the button copy switches to "Update
 *            Budget" / heading "Edit Budget — <category>".
 *       9. View Details modal — per-row View button opens a read-only KPI
 *            breakdown; the variance line uses the +/- sign and red/green
 *            class based on `variance` sign; Edit Budget pivot opens the
 *            edit form pre-populated.
 *      10. Submit error — POST rejection surfaces a toast.error with the
 *            error message; modal stays open so the user can retry.
 *      11. Error-path resilience — initial GET rejection still flips loading
 *            off and renders the empty branch.
 *      12. Uncategorised spend banner — renders one row per uncategorised
 *            category when the array is non-empty.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            next/navigation, @/components/Skeleton (stubbed to a div).
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

const { apiMock, toastMock, authMock, routerMock } = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/budgets",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import BudgetsPage from "../page";

type BudgetRow = {
  category: string;
  budget: number;
  actual: number;
  variance: number;
  utilisation: number;
};

type BudgetsResp = {
  year: number;
  month: number;
  rows: BudgetRow[];
  totalBudget?: number;
  totalSpent?: number;
  totalVarianceBudgetedOnly?: number;
  uncategorizedActual: Array<{ category: string; actual: number }>;
};

function rowFixture(overrides: Partial<BudgetRow> = {}): BudgetRow {
  return {
    category: "SALARY",
    budget: 100000,
    actual: 80000,
    variance: -20000,
    utilisation: 80,
    ...overrides,
  };
}

function respFixture(overrides: Partial<BudgetsResp> = {}): BudgetsResp {
  return {
    year: 2026,
    month: 5,
    rows: [
      rowFixture({ category: "SALARY", budget: 100000, actual: 80000, variance: -20000, utilisation: 80 }),
      rowFixture({ category: "UTILITIES", budget: 20000, actual: 25000, variance: 5000, utilisation: 125 }),
    ],
    totalBudget: 120000,
    totalSpent: 110000,
    totalVarianceBudgetedOnly: -15000,
    uncategorizedActual: [],
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: {
      id: "u-admin",
      userId: "u-admin",
      role: "ADMIN",
      name: "Admin",
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
      name: "Doc",
      email: "doc@test.local",
    },
    isLoading: false,
  });
}

describe("Budgets dashboard page (admin-only monthly budgets vs actual)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects non-ADMIN (DOCTOR) to /dashboard and never fires the budgets GET", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });
    asDoctor();

    render(<BudgetsPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
    // The DOCTOR branch returns null — heading should never render.
    expect(
      screen.queryByRole("heading", { name: /^Budgets$/ }),
    ).not.toBeInTheDocument();
    // No fetch should have been issued (the loader is role-gated).
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the SkeletonTable loading branch while the initial GET is pending", async () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));

    render(<BudgetsPage />);

    expect(
      screen.getByRole("heading", { name: /^Budgets$/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("budgets-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("hits /expenses/budgets on mount and renders KPI tiles + one row per BudgetRow", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });

    render(<BudgetsPage />);

    await screen.findByTestId("budget-row-SALARY");
    await screen.findByTestId("budget-row-UTILITIES");

    // Querystring contract: year/month parsed from current month string;
    // we just confirm the prefix + the two params are present.
    const call = apiMock.get.mock.calls.find((c) =>
      (c[0] as string).startsWith("/expenses/budgets?"),
    );
    expect(call).toBeTruthy();
    expect(call?.[0]).toMatch(/^\/expenses\/budgets\?year=\d{4}&month=\d{1,2}$/);

    // KPI tiles use SERVER totals (not the row roll-up).
    expect(screen.getByText("Rs. 1,20,000")).toBeInTheDocument(); // Total Budget
    expect(screen.getByTestId("kpi-total-spent")).toHaveTextContent("Rs. 1,10,000");
    // Variance is -15000 → absolute = 15000.
    expect(screen.getByTestId("kpi-variance")).toHaveTextContent("Rs. 15,000");

    // Row pill: UTILITIES is over (utilisation 125 → variance pill "25%").
    const utilRow = screen.getByTestId("budget-row-UTILITIES");
    expect(within(utilRow).getByText("25%")).toBeInTheDocument();
    expect(within(utilRow).getByText(/Utilisation:\s*125%/)).toBeInTheDocument();

    // Row pill: SALARY under (utilisation 80 → variance pill "20%").
    const salRow = screen.getByTestId("budget-row-SALARY");
    expect(within(salRow).getByText("20%")).toBeInTheDocument();
    expect(within(salRow).getByText(/Utilisation:\s*80%/)).toBeInTheDocument();
  });

  it('renders "No budgets set for this month" when rows is empty', async () => {
    apiMock.get.mockResolvedValue({
      data: respFixture({ rows: [], totalBudget: 0, totalSpent: 0, totalVarianceBudgetedOnly: 0 }),
    });

    render(<BudgetsPage />);

    expect(
      await screen.findByText(/No budgets set for this month/i),
    ).toBeInTheDocument();
  });

  it("falls back to client-side roll-up when server omits totalBudget/totalSpent/variance", async () => {
    // Two rows: budget 100+50=150, actual 90+60=150, variance = actual-budget = 0.
    apiMock.get.mockResolvedValue({
      data: {
        year: 2026,
        month: 5,
        rows: [
          rowFixture({ category: "SALARY", budget: 100, actual: 90, variance: -10, utilisation: 90 }),
          rowFixture({ category: "RENT", budget: 50, actual: 60, variance: 10, utilisation: 120 }),
        ],
        uncategorizedActual: [],
      } as BudgetsResp,
    });

    render(<BudgetsPage />);

    await screen.findByTestId("budget-row-SALARY");

    // Total Budget = 150, Total Spent = 150, Variance = 0 (absolute).
    expect(screen.getAllByText("Rs. 150").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("kpi-variance")).toHaveTextContent("Rs. 0");
  });

  it("refetches with the new year/month when the month input changes", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    apiMock.get.mockClear();

    // The month input is a <input type="month"> — first one in the DOM.
    const monthInput = document.querySelector(
      'input[type="month"]',
    ) as HTMLInputElement;
    expect(monthInput).toBeTruthy();

    fireEvent.change(monthInput, { target: { value: "2026-03" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/expenses/budgets?year=2026&month=3",
      ),
    );
  });

  it("opens the Set Budget modal, validates empty amount via toast.warning, and does NOT POST", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    fireEvent.click(screen.getByRole("button", { name: /Set Budget/i }));

    // Heading visible.
    expect(
      screen.getByRole("heading", { name: /Set Monthly Budget/i }),
    ).toBeInTheDocument();

    // Save without filling amount → warning toast, no POST.
    fireEvent.click(screen.getByTestId("budget-save"));

    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.stringMatching(/Enter a budget amount/i),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects non-numeric / negative amounts via toast.warning", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    fireEvent.click(screen.getByRole("button", { name: /Set Budget/i }));

    const amountInput = document.getElementById(
      "add-budget-amount",
    ) as HTMLInputElement;
    expect(amountInput).toBeTruthy();

    // type=number inputs in jsdom reject non-numeric text; use a negative
    // numeric string to hit the `< 0` branch.
    fireEvent.change(amountInput, { target: { value: "-50" } });
    fireEvent.click(screen.getByTestId("budget-save"));

    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.stringMatching(/positive number/i),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("submits a well-shaped POST, toasts success, closes the modal, and reloads", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    fireEvent.click(screen.getByRole("button", { name: /Set Budget/i }));

    const categorySelect = document.getElementById(
      "add-budget-category",
    ) as HTMLSelectElement;
    const amountInput = document.getElementById(
      "add-budget-amount",
    ) as HTMLInputElement;
    const notesArea = document.getElementById(
      "add-budget-notes",
    ) as HTMLTextAreaElement;

    fireEvent.change(categorySelect, { target: { value: "RENT" } });
    fireEvent.change(amountInput, { target: { value: "75000" } });
    fireEvent.change(notesArea, { target: { value: "Q2 lease" } });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("budget-save"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));

    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/expenses/budgets");
    expect(body).toMatchObject({
      category: "RENT",
      amount: 75000,
      notes: "Q2 lease",
    });
    expect((body as any).year).toEqual(expect.any(Number));
    expect((body as any).month).toEqual(expect.any(Number));

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringMatching(/Budget saved/i),
      ),
    );

    // Modal heading should no longer be in the DOM (closed).
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Set Monthly Budget/i }),
      ).not.toBeInTheDocument(),
    );

    // List reload was triggered.
    expect(apiMock.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/expenses\/budgets\?year=\d{4}&month=\d{1,2}$/),
    );
  });

  it("omits `notes` from the POST body when the notes field is empty", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    fireEvent.click(screen.getByRole("button", { name: /Set Budget/i }));

    const amountInput = document.getElementById(
      "add-budget-amount",
    ) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "1000" } });
    fireEvent.click(screen.getByTestId("budget-save"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));

    const [, body] = apiMock.post.mock.calls[0];
    expect((body as any).notes).toBeUndefined();
  });

  it("surfaces a POST rejection via toast.error and keeps the modal open", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });
    apiMock.post.mockRejectedValue(new Error("server boom"));

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    fireEvent.click(screen.getByRole("button", { name: /Set Budget/i }));
    fireEvent.change(
      document.getElementById("add-budget-amount") as HTMLInputElement,
      { target: { value: "5000" } },
    );
    fireEvent.click(screen.getByTestId("budget-save"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("server boom"),
    );

    // Modal stays open so the user can retry.
    expect(
      screen.getByRole("heading", { name: /Set Monthly Budget/i }),
    ).toBeInTheDocument();
  });

  it("opens the Edit modal pre-populated with the row data and locks the category", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-UTILITIES");

    fireEvent.click(screen.getByTestId("budget-edit-UTILITIES"));

    // Heading flips to the edit copy.
    expect(
      screen.getByRole("heading", { name: /Edit Budget — UTILITIES/i }),
    ).toBeInTheDocument();

    // Category locked + value pre-filled.
    const categorySelect = document.getElementById(
      "add-budget-category",
    ) as HTMLSelectElement;
    expect(categorySelect.value).toBe("UTILITIES");
    expect(categorySelect.disabled).toBe(true);

    // Amount pre-filled with the row's budget (20000).
    const amountInput = document.getElementById(
      "add-budget-amount",
    ) as HTMLInputElement;
    expect(amountInput.value).toBe("20000");

    // Save button copy is "Update Budget" in edit mode.
    expect(screen.getByTestId("budget-save")).toHaveTextContent(/Update Budget/i);
  });

  it("Edit + Save flow toasts 'Budget updated' and clears the editing row", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    fireEvent.click(screen.getByTestId("budget-edit-SALARY"));
    fireEvent.change(
      document.getElementById("add-budget-amount") as HTMLInputElement,
      { target: { value: "150000" } },
    );
    fireEvent.click(screen.getByTestId("budget-save"));

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringMatching(/Budget updated/i),
      ),
    );

    // Modal closed.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Edit Budget/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("Cancel button closes the modal and clears the editing-row state", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    fireEvent.click(screen.getByTestId("budget-edit-SALARY"));
    expect(
      screen.getByRole("heading", { name: /Edit Budget — SALARY/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Edit Budget/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("opens the View Details modal with the row KPI breakdown", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-UTILITIES");

    fireEvent.click(screen.getByTestId("budget-view-UTILITIES"));

    const modal = await screen.findByTestId("budget-view-modal");
    // Heading shows category + month.
    expect(within(modal).getByRole("heading")).toHaveTextContent(/UTILITIES/);

    // Allocated 20000, Actual 25000, Variance +5000 (with + prefix because variance > 0),
    // Utilisation 125%.
    expect(within(modal).getByText("Rs. 20,000")).toBeInTheDocument();
    expect(within(modal).getByText("Rs. 25,000")).toBeInTheDocument();
    expect(within(modal).getByText(/^\+Rs\. 5,000$/)).toBeInTheDocument();
    expect(within(modal).getByText("125%")).toBeInTheDocument();
  });

  it("View Details renders the negative-variance branch without a + prefix", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    fireEvent.click(screen.getByTestId("budget-view-SALARY"));

    const modal = await screen.findByTestId("budget-view-modal");
    // variance = -20000 → no leading +; the negative sign is part of the number.
    expect(within(modal).getByText(/^Rs\. -20,000$/)).toBeInTheDocument();
  });

  it("View Details → Edit Budget pivot opens the edit form pre-populated", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    fireEvent.click(screen.getByTestId("budget-view-SALARY"));
    const modal = await screen.findByTestId("budget-view-modal");

    fireEvent.click(within(modal).getByRole("button", { name: /Edit Budget/i }));

    // View modal closed, edit modal open.
    await waitFor(() =>
      expect(screen.queryByTestId("budget-view-modal")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: /Edit Budget — SALARY/i }),
    ).toBeInTheDocument();
  });

  it("View Details → Close button dismisses the modal", async () => {
    apiMock.get.mockResolvedValue({ data: respFixture() });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    fireEvent.click(screen.getByTestId("budget-view-SALARY"));
    const modal = await screen.findByTestId("budget-view-modal");
    fireEvent.click(within(modal).getByRole("button", { name: /Close/i }));

    await waitFor(() =>
      expect(screen.queryByTestId("budget-view-modal")).not.toBeInTheDocument(),
    );
  });

  it("renders the uncategorised-spend banner when uncategorizedActual is non-empty", async () => {
    apiMock.get.mockResolvedValue({
      data: respFixture({
        uncategorizedActual: [
          { category: "TRAVEL", actual: 15000 },
          { category: "MISC", actual: 3000 },
        ],
      }),
    });

    render(<BudgetsPage />);
    await screen.findByTestId("budget-row-SALARY");

    expect(screen.getByText(/Spending without budgets set/i)).toBeInTheDocument();
    expect(screen.getByText("TRAVEL")).toBeInTheDocument();
    expect(screen.getByText("MISC")).toBeInTheDocument();
    // "Rs. 15,000" appears in BOTH the KPI variance tile (totalVariance abs)
    // AND the uncategorised TRAVEL row — use getAllByText.
    expect(screen.getAllByText("Rs. 15,000").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Rs. 3,000")).toBeInTheDocument();

    // Total-Spent subtitle also surfaces the uncategorised total (15000 + 3000 = 18000).
    expect(
      screen.getByText(/Includes Rs\. 18,000 in categories without a budget set/i),
    ).toBeInTheDocument();
  });

  it("silently swallows the initial GET rejection and renders the empty branch", async () => {
    apiMock.get.mockRejectedValue(new Error("server down"));

    render(<BudgetsPage />);

    expect(
      await screen.findByText(/No budgets set for this month/i),
    ).toBeInTheDocument();
    // The try/catch is silent — no toast call.
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
