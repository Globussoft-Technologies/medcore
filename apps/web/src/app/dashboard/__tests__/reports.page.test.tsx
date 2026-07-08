/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

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

// ── Departments tab (2026-07) ────────────────────────────────────────────
// Covers the department-wise report tab added this session: the table render,
// the quick-range presets + applyQuickRange, the From/To pickers with the
// preset-clearing onChange, row-click drill-down navigation, and the authed
// CSV export (downloadDeptCsv → fetch+blob).
const deptRows = [
  {
    department: "Cardiology",
    doctorCount: 3,
    appointmentCount: 42,
    completedCount: 38,
    patientCount: 30,
    revenue: 125000,
    avgConsultMinutes: 18,
  },
  {
    department: "Dermatology",
    doctorCount: 2,
    appointmentCount: 15,
    completedCount: 12,
    patientCount: 14,
    revenue: 45000,
    avgConsultMinutes: 12,
  },
];

function asAdmin() {
  authMock.mockImplementation((selector?: any) => {
    const state = { user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" } };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("ReportsPage — Departments tab", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    routerPush.mockReset();
    asAdmin();
  });

  it("renders the department table and appointments bar chart", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/departments"))
        return Promise.resolve({ data: deptRows });
      return Promise.resolve({ data: {} });
    });
    render(<ReportsPage />);
    fireEvent.click(await screen.findByTestId("reports-tab-departments"));

    await waitFor(() => expect(screen.getByTestId("dept-table")).toBeInTheDocument());
    expect(screen.getAllByTestId("dept-row")).toHaveLength(2);
    // "Cardiology" also appears in the bar chart, so scope to the table.
    const table = screen.getByTestId("dept-table");
    expect(within(table).getByText("Cardiology")).toBeInTheDocument();
    // Revenue formatted with Indian grouping.
    expect(within(table).getByText(/1,25,000\.00/)).toBeInTheDocument();
  });

  it("shows the empty state when no department activity", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/departments")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
    render(<ReportsPage />);
    fireEvent.click(await screen.findByTestId("reports-tab-departments"));
    await waitFor(() => expect(screen.getByTestId("dept-empty")).toBeInTheDocument());
  });

  it("applies each quick-range preset and re-queries the API", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/departments")) return Promise.resolve({ data: deptRows });
      return Promise.resolve({ data: {} });
    });
    render(<ReportsPage />);
    fireEvent.click(await screen.findByTestId("reports-tab-departments"));
    await waitFor(() => expect(screen.getByTestId("dept-table")).toBeInTheDocument());

    for (const key of ["today", "7d", "1mo", "1yr", "all"]) {
      fireEvent.click(screen.getByTestId(`dept-range-${key}`));
      await waitFor(() =>
        expect(screen.getByTestId(`dept-range-${key}`)).toHaveAttribute(
          "aria-pressed",
          "true"
        )
      );
    }
    // The "all" preset stays pressed; each range fired a fresh departments fetch.
    const deptCalls = apiMock.get.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("/analytics/departments")
    );
    expect(deptCalls.length).toBeGreaterThan(1);
  });

  it("editing the From/To pickers clears the active preset", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/departments")) return Promise.resolve({ data: deptRows });
      return Promise.resolve({ data: {} });
    });
    render(<ReportsPage />);
    fireEvent.click(await screen.findByTestId("reports-tab-departments"));
    await waitFor(() => expect(screen.getByTestId("dept-table")).toBeInTheDocument());

    // "1mo" is the default preset.
    expect(screen.getByTestId("dept-range-1mo")).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByTestId("dept-from"), { target: { value: "2026-01-01" } });
    await waitFor(() =>
      expect(screen.getByTestId("dept-range-1mo")).toHaveAttribute("aria-pressed", "false")
    );
    fireEvent.change(screen.getByTestId("dept-to"), { target: { value: "2026-02-01" } });
    expect(screen.getByTestId("dept-range-1mo")).toHaveAttribute("aria-pressed", "false");
  });

  it("errors (no fetch) when From is after To", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/departments")) return Promise.resolve({ data: deptRows });
      return Promise.resolve({ data: {} });
    });
    render(<ReportsPage />);
    fireEvent.click(await screen.findByTestId("reports-tab-departments"));
    await waitFor(() => expect(screen.getByTestId("dept-table")).toBeInTheDocument());

    // From later than To → loadDepartments toasts and returns early.
    fireEvent.change(screen.getByTestId("dept-to"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByTestId("dept-from"), { target: { value: "2026-06-01" } });
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/must be before/i)
      )
    );
  });

  it("row click navigates to the department drill-down", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/departments")) return Promise.resolve({ data: deptRows });
      return Promise.resolve({ data: {} });
    });
    render(<ReportsPage />);
    fireEvent.click(await screen.findByTestId("reports-tab-departments"));
    await waitFor(() => expect(screen.getByTestId("dept-table")).toBeInTheDocument());

    // Scope to the table — "Cardiology" is also in the bar chart.
    const table = screen.getByTestId("dept-table");
    fireEvent.click(within(table).getByText("Cardiology"));
    expect(routerPush).toHaveBeenCalledWith(
      expect.stringContaining("/dashboard/reports/departments/Cardiology")
    );
  });

  it("keeps rendering when the departments API rejects", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/departments")) return Promise.reject(new Error("500"));
      return Promise.resolve({ data: {} });
    });
    render(<ReportsPage />);
    fireEvent.click(await screen.findByTestId("reports-tab-departments"));
    await waitFor(() => expect(screen.getByTestId("dept-empty")).toBeInTheDocument());
  });
});

describe("ReportsPage — department CSV export", () => {
  const origFetch = global.fetch;
  const origCreate = global.URL.createObjectURL;
  const origRevoke = global.URL.revokeObjectURL;

  beforeEach(() => {
    apiMock.get.mockReset();
    asAdmin();
    global.URL.createObjectURL = vi.fn(() => "blob:mock");
    global.URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    global.fetch = origFetch;
    global.URL.createObjectURL = origCreate;
    global.URL.revokeObjectURL = origRevoke;
  });

  it("downloads the departments CSV via authed fetch+blob", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["dept,rev\n"], { type: "text/csv" }),
    }));
    global.fetch = fetchMock as any;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/departments")) return Promise.resolve({ data: deptRows });
      return Promise.resolve({ data: {} });
    });
    render(<ReportsPage />);
    fireEvent.click(await screen.findByTestId("reports-tab-departments"));
    await waitFor(() => expect(screen.getByTestId("dept-table")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("dept-export-csv"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // The CSV endpoint is called with credentials so the httpOnly cookie attaches.
    const [url, opts] = fetchMock.mock.calls[0] as any[];
    expect(String(url)).toContain("/analytics/export/departments.csv");
    expect(opts.credentials).toBe("include");
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("toasts when the CSV export responds non-OK", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, blob: async () => new Blob() })) as any;
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/departments")) return Promise.resolve({ data: deptRows });
      return Promise.resolve({ data: {} });
    });
    render(<ReportsPage />);
    fireEvent.click(await screen.findByTestId("reports-tab-departments"));
    await waitFor(() => expect(screen.getByTestId("dept-table")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("dept-export-csv"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/export failed/i))
    );
  });
});

// ── Report History tab (Generate / Schedule / per-row export) ────────────
const runRows = [
  {
    id: "run1",
    reportType: "WEEKLY_REVENUE",
    generatedAt: new Date().toISOString(),
    status: "SUCCESS",
    parameters: { from: "2026-06-01", to: "2026-06-07" },
    snapshot: { total: 1000 },
    scheduledReport: { id: "s1", name: "Weekly Rev" },
  },
  {
    id: "run2",
    reportType: "CUSTOM",
    generatedAt: new Date().toISOString(),
    status: "FAILED",
    error: "boom",
    snapshot: { note: "custom" },
    scheduledReport: null,
  },
];

describe("ReportsPage — Report History tab", () => {
  const origCreate = global.URL.createObjectURL;
  const origRevoke = global.URL.revokeObjectURL;

  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    asAdmin();
    global.URL.createObjectURL = vi.fn(() => "blob:mock");
    global.URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    global.URL.createObjectURL = origCreate;
    global.URL.revokeObjectURL = origRevoke;
  });

  function mockRuns() {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/report-runs")) return Promise.resolve({ data: runRows });
      return Promise.resolve({ data: {} });
    });
  }

  async function openHistory() {
    render(<ReportsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /report history/i }));
    await waitFor(() => expect(screen.getByTestId("report-generate-btn")).toBeInTheDocument());
  }

  it("lists report runs and shows run detail on row click", async () => {
    mockRuns();
    await openHistory();
    await waitFor(() => expect(screen.getByText("WEEKLY_REVENUE")).toBeInTheDocument());
    // Click the row (via its Type cell) to select it for the detail panel.
    fireEvent.click(screen.getByText("WEEKLY_REVENUE"));
    const detail = screen.getByText(/run detail/i).closest("div") as HTMLElement;
    // The detail panel echoes the selected run's type.
    expect(within(detail).getByText("WEEKLY_REVENUE")).toBeInTheDocument();
  });

  it("filters runs by type", async () => {
    mockRuns();
    await openHistory();
    fireEvent.change(screen.getByTestId("report-type-filter"), {
      target: { value: "WEEKLY_REVENUE" },
    });
    await waitFor(() =>
      expect(
        apiMock.get.mock.calls.some((c: any[]) =>
          String(c[0]).includes("type=WEEKLY_REVENUE")
        )
      ).toBe(true)
    );
  });

  it("generates a report via the Generate modal", async () => {
    mockRuns();
    apiMock.post.mockResolvedValue({ data: { id: "new" } });
    await openHistory();
    fireEvent.click(screen.getByTestId("report-generate-btn"));
    expect(screen.getByTestId("report-generate-modal")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("report-generate-type"), {
      target: { value: "MONTHLY_SUMMARY" },
    });
    fireEvent.click(screen.getByTestId("report-generate-submit"));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/analytics/report-runs",
        expect.objectContaining({ reportType: "MONTHLY_SUMMARY" })
      )
    );
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("validates generate dates (from after to → error, no POST)", async () => {
    mockRuns();
    await openHistory();
    fireEvent.click(screen.getByTestId("report-generate-btn"));
    fireEvent.change(screen.getByTestId("report-generate-from"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("report-generate-to"), {
      target: { value: "2026-06-01" },
    });
    fireEvent.click(screen.getByTestId("report-generate-submit"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/before/i))
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("schedules a report via the Schedule modal", async () => {
    mockRuns();
    apiMock.post.mockResolvedValue({ data: { id: "sched" } });
    await openHistory();
    fireEvent.click(screen.getByTestId("report-schedule-btn"));
    expect(screen.getByTestId("report-schedule-modal")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("report-schedule-name"), {
      target: { value: "Nightly" },
    });
    fireEvent.change(screen.getByTestId("report-schedule-email"), {
      target: { value: "ops@x.com" },
    });
    fireEvent.change(screen.getByTestId("report-schedule-frequency"), {
      target: { value: "MONTHLY" },
    });
    fireEvent.click(screen.getByTestId("report-schedule-submit"));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/scheduled-reports",
        expect.objectContaining({ name: "Nightly", dayOfMonth: 1 })
      )
    );
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("blocks schedule save on missing name / bad email", async () => {
    mockRuns();
    await openHistory();
    fireEvent.click(screen.getByTestId("report-schedule-btn"));
    // No name → error.
    fireEvent.click(screen.getByTestId("report-schedule-submit"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/name/i))
    );
    // Name present but bad email → error.
    fireEvent.change(screen.getByTestId("report-schedule-name"), {
      target: { value: "X" },
    });
    fireEvent.change(screen.getByTestId("report-schedule-email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByTestId("report-schedule-submit"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/email/i))
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("exports a mapped run as CSV via authed fetch", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["a,b\n"], { type: "text/csv" }),
    }));
    global.fetch = fetchMock as any;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mockRuns();
    await openHistory();
    await waitFor(() => expect(screen.getByTestId("report-export-run1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("report-export-run1"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [csvUrl] = fetchMock.mock.calls[0] as any[];
    expect(String(csvUrl)).toContain("/analytics/export/revenue.csv");
    clickSpy.mockRestore();
  });

  it("exports an unmapped (CUSTOM) run as a JSON snapshot download", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    mockRuns();
    await openHistory();
    await waitFor(() => expect(screen.getByTestId("report-export-run2")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("report-export-run2"));
    // CUSTOM has no first-class CSV → falls back to blob JSON, no fetch.
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("shows empty state when there are no runs", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/report-runs")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
    await openHistory();
    await waitFor(() => expect(screen.getByText(/no report runs yet/i)).toBeInTheDocument());
  });

  it("keeps rendering when the runs API rejects", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/report-runs")) return Promise.reject(new Error("500"));
      return Promise.resolve({ data: {} });
    });
    await openHistory();
    await waitFor(() => expect(screen.getByText(/no report runs yet/i)).toBeInTheDocument());
  });

  it("run detail shows Sent to / Error for a failed scheduled run", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/report-runs"))
        return Promise.resolve({
          data: [
            {
              id: "run3",
              reportType: "DAILY_CENSUS",
              generatedAt: new Date().toISOString(),
              status: "FAILED",
              error: "smtp down",
              sentTo: ["ops@x.com", "cfo@x.com"],
              parameters: null,
              snapshot: null,
              scheduledReport: null,
            },
          ],
        });
      return Promise.resolve({ data: {} });
    });
    await openHistory();
    await waitFor(() => expect(screen.getByText("DAILY_CENSUS")).toBeInTheDocument());
    fireEvent.click(screen.getByText("DAILY_CENSUS"));
    const detail = screen.getByText(/run detail/i).closest("div") as HTMLElement;
    expect(within(detail).getByText(/ops@x.com, cfo@x.com/)).toBeInTheDocument();
    expect(within(detail).getByText(/smtp down/)).toBeInTheDocument();
  });

  it("Generate and Schedule modals close on Cancel", async () => {
    mockRuns();
    await openHistory();
    fireEvent.click(screen.getByTestId("report-generate-btn"));
    expect(screen.getByTestId("report-generate-modal")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("report-generate-cancel"));
    expect(screen.queryByTestId("report-generate-modal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("report-schedule-btn"));
    expect(screen.getByTestId("report-schedule-modal")).toBeInTheDocument();
    // Exercise the type + time onChange handlers before cancelling.
    fireEvent.change(screen.getByTestId("report-schedule-type"), {
      target: { value: "DAILY_CENSUS" },
    });
    fireEvent.change(screen.getByTestId("report-schedule-time"), {
      target: { value: "07:30" },
    });
    fireEvent.click(screen.getByTestId("report-schedule-cancel"));
    expect(screen.queryByTestId("report-schedule-modal")).not.toBeInTheDocument();
  });

  it("surfaces a server error toast when generate POST fails", async () => {
    mockRuns();
    apiMock.post.mockRejectedValue(new Error("server boom"));
    await openHistory();
    fireEvent.click(screen.getByTestId("report-generate-btn"));
    fireEvent.click(screen.getByTestId("report-generate-submit"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/server boom/i))
    );
  });

  it("surfaces a server error toast when schedule POST fails", async () => {
    mockRuns();
    apiMock.post.mockRejectedValue(new Error("sched boom"));
    await openHistory();
    fireEvent.click(screen.getByTestId("report-schedule-btn"));
    fireEvent.change(screen.getByTestId("report-schedule-name"), { target: { value: "X" } });
    fireEvent.change(screen.getByTestId("report-schedule-email"), {
      target: { value: "ops@x.com" },
    });
    fireEvent.click(screen.getByTestId("report-schedule-submit"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/sched boom/i))
    );
  });

  it("toasts when a per-row CSV export responds non-OK", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, blob: async () => new Blob() })) as any;
    mockRuns();
    await openHistory();
    await waitFor(() => expect(screen.getByTestId("report-export-run1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("report-export-run1"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/export failed/i))
    );
  });
});

// ── Daily tab date picker + payment name fallback ────────────────────────
describe("ReportsPage — daily tab interactions", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    asAdmin();
  });

  it("changing the date re-queries the daily report", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/billing/reports/daily")) return Promise.resolve({ data: dailyReport });
      return Promise.resolve({ data: [] });
    });
    render(<ReportsPage />);
    await screen.findByRole("heading", { name: /billing reports/i });
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-06-15" } });
    await waitFor(() =>
      expect(
        apiMock.get.mock.calls.some((c: any[]) => String(c[0]).includes("date=2026-06-15"))
      ).toBe(true)
    );
  });

  it("falls back to invoice.patient name when payment has no direct patient", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/billing/reports/daily"))
        return Promise.resolve({
          data: {
            ...dailyReport,
            recentPayments: [
              {
                id: "pm2",
                amount: 900,
                mode: "UPI",
                paidAt: new Date().toISOString(),
                invoice: { patient: { user: { name: "Nested Name" } } },
              },
            ],
          },
        });
      return Promise.resolve({ data: [] });
    });
    render(<ReportsPage />);
    await waitFor(() => expect(screen.getByText("Nested Name")).toBeInTheDocument());
  });
});
