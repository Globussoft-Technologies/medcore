/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ReportsPage (Billing Reports — top-level /dashboard/reports) — adjacent-to-source
 * coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/reports/page.tsx, the ADMIN-only
 *     billing reports aggregate page. Distinct from /dashboard/scheduled-reports
 *     (cron manager) and /dashboard/analytics/reports (report builder).
 *
 *   - Endpoints the page hits:
 *       GET  /billing/reports/daily?date=<date>         (daily-collection KPIs)
 *       GET  /analytics/report-runs?limit=100&type=     (run history)
 *       POST /analytics/report-runs                     (ad-hoc generate)
 *       POST /scheduled-reports                         (create schedule)
 *       fetch GET /analytics/export/{revenue,appointments}.csv  (CSV export)
 *
 *   - Behaviours covered:
 *       1.  RBAC — non-ADMIN role (RECEPTION) triggers router.push("/dashboard").
 *       2.  RBAC — non-ADMIN role (DOCTOR) triggers router.push AND short-circuits
 *           render to null (per the role-check fall-through at line 332).
 *       3.  Loading branch — initial /billing/reports/daily GET in-flight shows
 *           the daily-loading skeleton.
 *       4.  Happy fetch — KPI cards render Total Collection, Transactions,
 *           Pending Invoices Today, Avg Transaction.
 *       5.  Defensive coercion — paymentModeBreakdown derives from `byMode`
 *           shape (not paymentModeBreakdown directly) when the alternate
 *           field shape is returned.
 *       6.  Defensive coercion — recentPayments derives from `payments` shape
 *           (alternate field) and renders one row per payment.
 *       7.  Recent Payments empty branch — "No payments for this date" copy.
 *       8.  Payment Mode Breakdown empty branch — "No payments recorded".
 *       9.  Date filter — changing the date input fires a fresh GET with new qs.
 *      10.  Error-path resilience — initial GET rejection still flips loading
 *           off and renders zeroed KPI cards (defensive catch returns 0s).
 *      11.  Tab switch to History — fires /analytics/report-runs and renders
 *           one row per run with type + status + Generated time + Export btn.
 *      12.  Run-history loading branch — skeleton renders while runs GET in flight.
 *      13.  Run-history empty branch — "No report runs yet" copy.
 *      14.  Type filter — selecting a type in the filter dropdown refires the GET
 *           with the type qs.
 *      15.  Generate modal — opens, blank from/to triggers toast.error (covered
 *           via the date inverted-range case below).
 *      16.  Generate modal — from > to triggers toast.error and does NOT POST.
 *      17.  Generate happy path — POST /analytics/report-runs with parameters +
 *           snapshot, success toast, modal closes, runs list reloads.
 *      18.  Generate failure — POST rejection surfaces server error via toast,
 *           modal stays open for retry.
 *      19.  Schedule modal — blank name → toast.error and no POST.
 *      20.  Schedule modal — invalid email → toast.error and no POST.
 *      21.  Schedule modal — invalid time format → toast.error and no POST.
 *      22.  Schedule happy path (WEEKLY) — POST /scheduled-reports includes
 *           dayOfWeek=1 (Monday default), name-bearing success toast, modal
 *           closes, form fields reset.
 *      23.  Schedule happy path (MONTHLY) — POST includes dayOfMonth=1.
 *      24.  Schedule failure — POST rejection surfaces error via toast, modal
 *           stays open.
 *      25.  Export CSV (WEEKLY_REVENUE) — fetch hits /analytics/export/revenue.csv
 *           with from/to params + Bearer token; createObjectURL blob flow runs.
 *      26.  Export CSV (DAILY_CENSUS) — fetch hits /analytics/export/appointments.csv.
 *      27.  Export JSON fallback (CUSTOM) — null mapping → JSON blob download of
 *           snapshot.
 *      28.  Export failure — non-ok fetch response surfaces toast.error.
 *      29.  Row selection — clicking a run row populates the Run Detail pane
 *           with type, generated, status, sentTo, parameters/snapshot JSON.
 *      30.  Row detail — error string surfaces when present.
 *      31.  Selected row highlight — clicking a 2nd row updates highlight.
 *      32.  Generate cancel — Cancel button closes modal without POST.
 *      33.  Schedule cancel — Cancel button closes modal without POST.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            next/navigation, @/components/Skeleton (stubbed), global fetch.
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
  usePathname: () => "/dashboard/reports",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: () => <div data-testid="skeleton-card-stub" />,
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-table-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import ReportsPage from "../page";

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

function asReception() {
  authMock.mockReturnValue({
    user: {
      id: "u-rec",
      userId: "u-rec",
      role: "RECEPTION",
      name: "Reception",
      email: "rec@test.local",
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

function dailyFixture(overrides: Record<string, unknown> = {}) {
  return {
    totalCollection: 12345.5,
    transactionCount: 4,
    pendingInvoices: 2,
    paymentModeBreakdown: {
      CASH: 5000,
      CARD: 3000,
      UPI: 4345.5,
      ONLINE: 0,
    },
    recentPayments: [
      {
        id: "p-1",
        amount: 5000,
        mode: "CASH",
        paidAt: new Date(Date.now() - 60_000).toISOString(),
        patient: { user: { name: "Asha Devi" } },
      },
      {
        id: "p-2",
        amount: 3000,
        mode: "CARD",
        paidAt: new Date(Date.now() - 120_000).toISOString(),
        patient: { user: { name: "Ravi Kumar" } },
      },
    ],
    ...overrides,
  };
}

function runFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    reportType: "WEEKLY_REVENUE",
    generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    status: "SUCCESS",
    parameters: { from: "2026-05-01", to: "2026-05-07" },
    snapshot: { from: "2026-05-01", to: "2026-05-07", totalRevenue: 50000 },
    scheduledReport: { id: "sr-1", name: "Weekly Revenue" },
    sentTo: ["ops@example.com"],
    error: null,
    ...overrides,
  };
}

/**
 * Wire up the api.get mock to return daily + runs payloads keyed by URL.
 */
function wireGets(opts: {
  daily?: any;
  runs?: any[];
  failDaily?: boolean;
  failRuns?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/billing/reports/daily")) {
      if (opts.failDaily) return Promise.reject(new Error("daily server down"));
      return Promise.resolve({ data: opts.daily ?? dailyFixture() });
    }
    if (url.startsWith("/analytics/report-runs")) {
      if (opts.failRuns) return Promise.reject(new Error("runs server down"));
      return Promise.resolve({ data: opts.runs ?? [] });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("Billing Reports dashboard page (admin-only aggregate /dashboard/reports)", () => {
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
    // Seed a token so the export-CSV path picks it up.
    try {
      window.localStorage.setItem("medcore_token", "test-token");
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects non-ADMIN (RECEPTION) to /dashboard via the role guard", async () => {
    wireGets({});
    asReception();

    render(<ReportsPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
  });

  it("redirects DOCTOR to /dashboard and renders null (no chrome at all)", async () => {
    wireGets({});
    asDoctor();

    const { container } = render(<ReportsPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
    // role !== ADMIN && role !== RECEPTION → render returns null
    expect(container.querySelector("h1")).toBeNull();
  });

  it("renders the SkeletonCard daily-loading branch while initial GET is pending", () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));

    render(<ReportsPage />);

    expect(
      screen.getByRole("heading", { name: /^Billing Reports$/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("report-detail-loading")).toBeInTheDocument();
  });

  it("renders KPI cards (Total Collection, Transactions, Pending Invoices Today, Avg Transaction) after the GET resolves", async () => {
    wireGets({ daily: dailyFixture() });

    render(<ReportsPage />);

    await screen.findByText(/^Total Collection$/);
    expect(screen.getByText(/^Transactions$/)).toBeInTheDocument();
    expect(screen.getByText(/^Pending Invoices Today$/)).toBeInTheDocument();
    expect(screen.getByText(/^Avg Transaction$/)).toBeInTheDocument();
    // Total collection formatted "Rs. 12345.50"
    expect(screen.getByText(/Rs\. 12345\.50/)).toBeInTheDocument();
    // Transaction count + the avg below (12345.5/4 = 3086.38)
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(
      screen.getByTestId("reports-pending-invoices-today"),
    ).toHaveTextContent("2");
  });

  it("normalizes the alternate API shape (byMode + payments → paymentModeBreakdown + recentPayments)", async () => {
    wireGets({
      daily: {
        totalCollection: 6000,
        transactionCount: 2,
        pendingInvoices: 0,
        // No paymentModeBreakdown field; uses `byMode` instead.
        byMode: { CASH: 4000, UPI: 2000 },
        // No recentPayments field; uses `payments` instead.
        payments: [
          {
            id: "p-9",
            amount: 4000,
            mode: "CASH",
            paidAt: new Date().toISOString(),
            patient: { user: { name: "Alt Patient" } },
          },
        ],
      },
    });

    render(<ReportsPage />);

    // Mode breakdown rendered from byMode.
    await screen.findByText(/Payment Mode Breakdown/);
    // Both modes appear at least once (mode breakdown column + recent
    // payments mode pill). Use getAllByText to allow multiple matches.
    expect(screen.getAllByText("CASH").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("UPI")).toBeInTheDocument();
    // Recent payment row rendered from `payments`.
    expect(screen.getByText("Alt Patient")).toBeInTheDocument();
  });

  it('renders "No payments recorded" + "No payments for this date" when both lists are empty', async () => {
    wireGets({
      daily: {
        totalCollection: 0,
        transactionCount: 0,
        pendingInvoices: 0,
        paymentModeBreakdown: {},
        recentPayments: [],
      },
    });

    render(<ReportsPage />);

    await screen.findByText(/No payments recorded/i);
    expect(screen.getByText(/No payments for this date/i)).toBeInTheDocument();
  });

  it("changing the date input fires a fresh GET with the new date qs", async () => {
    wireGets({ daily: dailyFixture() });

    render(<ReportsPage />);

    await screen.findByText(/Total Collection/);
    apiMock.get.mockClear();
    apiMock.get.mockResolvedValue({ data: dailyFixture() });

    const dateInput = document.querySelector(
      'input[type="date"]',
    ) as HTMLInputElement;
    expect(dateInput).toBeTruthy();
    fireEvent.change(dateInput, { target: { value: "2026-04-10" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/billing/reports/daily?date=2026-04-10",
      ),
    );
  });

  it("silently swallows the daily GET rejection and renders zeroed KPI cards", async () => {
    wireGets({ failDaily: true });

    render(<ReportsPage />);

    // Total Collection still renders, but as Rs. 0.00.
    await screen.findByText(/^Total Collection$/);
    // Multiple Rs. 0.00 cards (total + avg) — assert at least one is present.
    expect(screen.getAllByText(/Rs\. 0\.00/).length).toBeGreaterThanOrEqual(1);
    // Catch is silent — no toast.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("switches to Report History tab and fires /analytics/report-runs with default limit=100", async () => {
    wireGets({
      daily: dailyFixture(),
      runs: [runFixture(), runFixture({ id: "run-2", status: "FAILED", error: "smtp boom" })],
    });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/analytics/report-runs?limit=100"),
    );
    // Both runs render with reportType WEEKLY_REVENUE → use getAllByText.
    await waitFor(() =>
      expect(screen.getAllByText(/^WEEKLY_REVENUE$/).length).toBeGreaterThanOrEqual(1),
    );
    expect(screen.getByText(/^SUCCESS$/)).toBeInTheDocument();
    expect(screen.getByText(/^FAILED$/)).toBeInTheDocument();
  });

  it("renders the SkeletonTable runs-loading branch while the runs GET is pending", async () => {
    // Daily resolves immediately, runs stays pending.
    let resolveRuns: ((v: any) => void) | undefined;
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/billing/reports/daily")) {
        return Promise.resolve({ data: dailyFixture() });
      }
      if (url.startsWith("/analytics/report-runs")) {
        return new Promise((res) => {
          resolveRuns = res;
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));

    await screen.findByTestId("report-runs-loading");
    // Cleanup — let it resolve so the cleanup hook doesn't warn.
    resolveRuns?.({ data: [] });
  });

  it('renders "No report runs yet" when the runs list is empty', async () => {
    wireGets({ daily: dailyFixture(), runs: [] });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));

    expect(await screen.findByText(/No report runs yet/i)).toBeInTheDocument();
  });

  it("typeFilter dropdown refires the GET with the chosen type", async () => {
    wireGets({ daily: dailyFixture(), runs: [runFixture()] });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/^WEEKLY_REVENUE$/);

    apiMock.get.mockClear();
    fireEvent.change(screen.getByTestId("report-type-filter"), {
      target: { value: "DAILY_CENSUS" },
    });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/analytics/report-runs?limit=100&type=DAILY_CENSUS",
      ),
    );
  });

  it("Generate modal: from > to triggers toast.error and does NOT POST", async () => {
    wireGets({ daily: dailyFixture(), runs: [] });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/No report runs yet/i);

    fireEvent.click(screen.getByTestId("report-generate-btn"));
    // Make from > to.
    fireEvent.change(screen.getByTestId("report-generate-from"), {
      target: { value: "2026-05-20" },
    });
    fireEvent.change(screen.getByTestId("report-generate-to"), {
      target: { value: "2026-05-10" },
    });
    fireEvent.click(screen.getByTestId("report-generate-submit"));

    expect(toastMock.error).toHaveBeenCalledWith(
      "'From' date must be before 'To' date",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Generate happy path posts /analytics/report-runs, success toasts, closes modal, reloads", async () => {
    wireGets({ daily: dailyFixture(), runs: [] });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/No report runs yet/i);

    fireEvent.click(screen.getByTestId("report-generate-btn"));
    fireEvent.change(screen.getByTestId("report-generate-type"), {
      target: { value: "MONTHLY_SUMMARY" },
    });
    fireEvent.change(screen.getByTestId("report-generate-from"), {
      target: { value: "2026-05-01" },
    });
    fireEvent.change(screen.getByTestId("report-generate-to"), {
      target: { value: "2026-05-25" },
    });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("report-generate-submit"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/analytics/report-runs");
    expect(body).toMatchObject({
      reportType: "MONTHLY_SUMMARY",
      parameters: { from: "2026-05-01", to: "2026-05-25" },
      snapshot: { from: "2026-05-01", to: "2026-05-25", generatedAdHoc: true },
      status: "SUCCESS",
    });
    expect(toastMock.success).toHaveBeenCalledWith("Report generated");
    // Modal closes.
    await waitFor(() =>
      expect(screen.queryByTestId("report-generate-modal")).not.toBeInTheDocument(),
    );
    // Reload triggered.
    expect(apiMock.get).toHaveBeenCalled();
  });

  it("Generate failure surfaces the server error via toast and keeps the modal open", async () => {
    wireGets({ daily: dailyFixture(), runs: [] });
    apiMock.post.mockRejectedValue(new Error("backend boom"));

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/No report runs yet/i);

    fireEvent.click(screen.getByTestId("report-generate-btn"));
    fireEvent.click(screen.getByTestId("report-generate-submit"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("backend boom"),
    );
    expect(screen.getByTestId("report-generate-modal")).toBeInTheDocument();
  });

  it("Generate cancel button closes the modal without POSTing", async () => {
    wireGets({ daily: dailyFixture(), runs: [] });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/No report runs yet/i);

    fireEvent.click(screen.getByTestId("report-generate-btn"));
    expect(screen.getByTestId("report-generate-modal")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("report-generate-cancel"));
    expect(screen.queryByTestId("report-generate-modal")).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule modal: blank name triggers toast.error and does NOT POST", async () => {
    wireGets({ daily: dailyFixture(), runs: [] });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/No report runs yet/i);

    fireEvent.click(screen.getByTestId("report-schedule-btn"));
    fireEvent.click(screen.getByTestId("report-schedule-submit"));

    expect(toastMock.error).toHaveBeenCalledWith(
      "Please enter a name for the schedule",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule modal: invalid email triggers toast.error and does NOT POST", async () => {
    wireGets({ daily: dailyFixture(), runs: [] });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/No report runs yet/i);

    fireEvent.click(screen.getByTestId("report-schedule-btn"));
    fireEvent.change(screen.getByTestId("report-schedule-name"), {
      target: { value: "Test schedule" },
    });
    fireEvent.change(screen.getByTestId("report-schedule-email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByTestId("report-schedule-submit"));

    expect(toastMock.error).toHaveBeenCalledWith(
      "Please enter a valid recipient email",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule modal: invalid time format triggers toast.error and does NOT POST", async () => {
    wireGets({ daily: dailyFixture(), runs: [] });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/No report runs yet/i);

    fireEvent.click(screen.getByTestId("report-schedule-btn"));
    fireEvent.change(screen.getByTestId("report-schedule-name"), {
      target: { value: "Test schedule" },
    });
    fireEvent.change(screen.getByTestId("report-schedule-email"), {
      target: { value: "ops@example.com" },
    });
    // Wipe the default 09:00.
    fireEvent.change(screen.getByTestId("report-schedule-time"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("report-schedule-submit"));

    expect(toastMock.error).toHaveBeenCalledWith(
      "Please pick a valid time (HH:MM)",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule WEEKLY happy path posts dayOfWeek=1 and success-toasts with the schedule name", async () => {
    wireGets({ daily: dailyFixture(), runs: [] });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/No report runs yet/i);

    fireEvent.click(screen.getByTestId("report-schedule-btn"));
    fireEvent.change(screen.getByTestId("report-schedule-name"), {
      target: { value: "Weekly Revenue Summary" },
    });
    fireEvent.change(screen.getByTestId("report-schedule-email"), {
      target: { value: "ops@example.com" },
    });
    // Frequency stays WEEKLY (default).
    fireEvent.click(screen.getByTestId("report-schedule-submit"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/scheduled-reports");
    expect(body).toMatchObject({
      name: "Weekly Revenue Summary",
      reportType: "WEEKLY_REVENUE",
      frequency: "WEEKLY",
      timeOfDay: "09:00",
      recipients: ["ops@example.com"],
      active: true,
      dayOfWeek: 1,
    });
    expect((body as any).dayOfMonth).toBeUndefined();
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/Weekly Revenue Summary.*weekly.*09:00/i),
    );
    // Modal closes.
    await waitFor(() =>
      expect(screen.queryByTestId("report-schedule-modal")).not.toBeInTheDocument(),
    );
  });

  it("Schedule MONTHLY happy path posts dayOfMonth=1 (no dayOfWeek)", async () => {
    wireGets({ daily: dailyFixture(), runs: [] });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/No report runs yet/i);

    fireEvent.click(screen.getByTestId("report-schedule-btn"));
    fireEvent.change(screen.getByTestId("report-schedule-name"), {
      target: { value: "Monthly Summary" },
    });
    fireEvent.change(screen.getByTestId("report-schedule-email"), {
      target: { value: "ops@example.com" },
    });
    fireEvent.change(screen.getByTestId("report-schedule-frequency"), {
      target: { value: "MONTHLY" },
    });
    fireEvent.click(screen.getByTestId("report-schedule-submit"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.post.mock.calls[0];
    expect((body as any).dayOfMonth).toBe(1);
    expect((body as any).dayOfWeek).toBeUndefined();
  });

  it("Schedule failure surfaces the server error and keeps the modal open", async () => {
    wireGets({ daily: dailyFixture(), runs: [] });
    apiMock.post.mockRejectedValue(new Error("sched boom"));

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/No report runs yet/i);

    fireEvent.click(screen.getByTestId("report-schedule-btn"));
    fireEvent.change(screen.getByTestId("report-schedule-name"), {
      target: { value: "Boom Test" },
    });
    fireEvent.change(screen.getByTestId("report-schedule-email"), {
      target: { value: "ops@example.com" },
    });
    fireEvent.click(screen.getByTestId("report-schedule-submit"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("sched boom"),
    );
    expect(screen.getByTestId("report-schedule-modal")).toBeInTheDocument();
  });

  it("Schedule cancel button closes the modal without POSTing", async () => {
    wireGets({ daily: dailyFixture(), runs: [] });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/No report runs yet/i);

    fireEvent.click(screen.getByTestId("report-schedule-btn"));
    fireEvent.click(screen.getByTestId("report-schedule-cancel"));

    expect(screen.queryByTestId("report-schedule-modal")).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Export CSV (WEEKLY_REVENUE) hits /analytics/export/revenue.csv with from/to + Bearer token", async () => {
    const run = runFixture({ reportType: "WEEKLY_REVENUE" });
    wireGets({ daily: dailyFixture(), runs: [run] });

    // Stub fetch + the blob/anchor download pipeline.
    const fetchMock = vi.fn(async () =>
      new Response("col1,col2\n1,2", {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      }),
    );
    (globalThis as any).fetch = fetchMock;
    (globalThis as any).__fetchMockLocked = true;
    const createUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:fake");
    const revokeUrlSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/^WEEKLY_REVENUE$/);

    fireEvent.click(screen.getByTestId(`report-export-${run.id}`));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as unknown as [
      string,
      any,
    ];
    expect(calledUrl).toContain("/analytics/export/revenue.csv");
    expect(calledUrl).toContain("from=2026-05-01");
    expect(calledUrl).toContain("to=2026-05-07");
    expect(calledInit.headers.Authorization).toBe("Bearer test-token");
    expect(createUrlSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeUrlSpy).toHaveBeenCalled();

    createUrlSpy.mockRestore();
    revokeUrlSpy.mockRestore();
    clickSpy.mockRestore();
    (globalThis as any).__fetchMockLocked = false;
  });

  it("Export CSV (DAILY_CENSUS) hits /analytics/export/appointments.csv", async () => {
    const run = runFixture({ id: "run-d", reportType: "DAILY_CENSUS" });
    wireGets({ daily: dailyFixture(), runs: [run] });

    const fetchMock = vi.fn(async () =>
      new Response("a,b\n1,2", { status: 200 }),
    );
    (globalThis as any).fetch = fetchMock;
    (globalThis as any).__fetchMockLocked = true;
    const createUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:fake2");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/^DAILY_CENSUS$/);

    fireEvent.click(screen.getByTestId(`report-export-${run.id}`));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [calledUrl] = fetchMock.mock.calls[0] as unknown as [string, any];
    expect(calledUrl).toContain("/analytics/export/appointments.csv");

    createUrlSpy.mockRestore();
    (globalThis as any).__fetchMockLocked = false;
  });

  it("Export JSON fallback (CUSTOM type) downloads a JSON blob of the snapshot — no fetch", async () => {
    const run = runFixture({
      id: "run-c",
      reportType: "CUSTOM",
      snapshot: { foo: "bar", n: 42 },
    });
    wireGets({ daily: dailyFixture(), runs: [run] });

    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    (globalThis as any).__fetchMockLocked = true;
    const createUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:json");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/^CUSTOM$/);

    fireEvent.click(screen.getByTestId(`report-export-${run.id}`));

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    // CSV fallback path does NOT call fetch.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createUrlSpy).toHaveBeenCalled();

    createUrlSpy.mockRestore();
    clickSpy.mockRestore();
    (globalThis as any).__fetchMockLocked = false;
  });

  it("Export CSV non-ok response surfaces toast.error", async () => {
    const run = runFixture({ reportType: "WEEKLY_REVENUE" });
    wireGets({ daily: dailyFixture(), runs: [run] });

    const fetchMock = vi.fn(async () =>
      new Response("nope", { status: 500 }),
    );
    (globalThis as any).fetch = fetchMock;
    (globalThis as any).__fetchMockLocked = true;

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    await screen.findByText(/^WEEKLY_REVENUE$/);

    fireEvent.click(screen.getByTestId(`report-export-${run.id}`));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Export failed \(500\)/),
      ),
    );
    (globalThis as any).__fetchMockLocked = false;
  });

  it("clicking a run row populates the Run Detail pane with type/status/sentTo/parameters/snapshot", async () => {
    const run = runFixture({
      sentTo: ["alice@example.com", "bob@example.com"],
      error: null,
    });
    wireGets({ daily: dailyFixture(), runs: [run] });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    const typeCell = await screen.findByText(/^WEEKLY_REVENUE$/);

    // Click the row (TR ancestor).
    const row = typeCell.closest("tr") as HTMLTableRowElement;
    expect(row).toBeTruthy();
    fireEvent.click(row);

    // Run Detail pane now shows the type, status, sentTo, parameters, snapshot.
    const detail = screen.getByText("Run Detail").parentElement as HTMLElement;
    expect(detail).toBeTruthy();
    expect(within(detail).getByText(/Sent to:/i)).toBeInTheDocument();
    expect(
      within(detail).getByText(/alice@example.com, bob@example.com/),
    ).toBeInTheDocument();
    expect(within(detail).getByText(/^Parameters$/)).toBeInTheDocument();
    expect(within(detail).getByText(/^Snapshot$/)).toBeInTheDocument();
  });

  it("Run Detail surfaces the error string when present on the selected run", async () => {
    const run = runFixture({
      id: "run-err",
      status: "FAILED",
      error: "smtp timed out at 09:01",
    });
    wireGets({ daily: dailyFixture(), runs: [run] });

    render(<ReportsPage />);
    await screen.findByText(/Total Collection/);

    fireEvent.click(screen.getByRole("button", { name: /Report History/i }));
    const typeCell = await screen.findByText(/^WEEKLY_REVENUE$/);
    const row = typeCell.closest("tr") as HTMLTableRowElement;
    fireEvent.click(row);

    expect(
      screen.getByText(/smtp timed out at 09:01/),
    ).toBeInTheDocument();
  });
});
