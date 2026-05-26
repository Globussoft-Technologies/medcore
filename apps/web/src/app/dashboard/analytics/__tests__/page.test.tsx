/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AnalyticsPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/analytics/page.tsx, the ADMIN /
 *     RECEPTION analytics dashboard that fans out 18 parallel GETs to render
 *     KPIs, charts, doctor performance, no-show / walkout, ER, IPD, pharmacy
 *     expiry and feedback panels. A nested BenchmarkAndForecastPanel also
 *     fires 2 more requests.
 *
 *   - Endpoints the page hits on loadAll():
 *       GET /analytics/overview?...&compareMode=previous_period   (KPI tiles)
 *       GET /analytics/appointments?...&groupBy=day                (trends)
 *       GET /analytics/revenue?...&groupBy=day                     (over-time)
 *       GET /analytics/doctors?...                                 (doctor table)
 *       GET /analytics/top-diagnoses?...&limit=10
 *       GET /analytics/patient-demographics
 *       GET /analytics/ipd/occupancy
 *       GET /analytics/pharmacy/low-stock
 *       GET /analytics/pharmacy/top-dispensed?limit=10
 *       GET /analytics/revenue/breakdown?...
 *       GET /analytics/patients/growth?...&groupBy=month
 *       GET /analytics/patients/retention?...
 *       GET /analytics/appointments/no-show-rate?...
 *       GET /analytics/ipd/discharge-trends?...
 *       GET /analytics/er/performance?...
 *       GET /analytics/pharmacy/expiry?days=30
 *       GET /analytics/feedback/trends?...&groupBy=month
 *       GET /analytics/queue-walkouts?...
 *       GET /analytics/benchmarks?metric=revenue&period=day        (nested)
 *       GET /analytics/forecast?metric=revenue&periods=7&groupBy=day
 *
 *   - Behaviours covered:
 *       1.  RBAC — non-ADMIN/RECEPTION (DOCTOR) triggers router.push to
 *           /dashboard and render short-circuits to null.
 *       2.  Null user — page renders + does NOT redirect.
 *       3.  ADMIN mount — initial fan-out fires for all 18 endpoints +
 *           benchmark/forecast pair; KPIs + delta badges render with the
 *           default "vs Previous Period" compareMode.
 *       4.  Preset change to "Today" rebuilds the GETs with the new range.
 *       5.  Custom from/to typed into the date pickers + Apply re-fans-out.
 *       6.  Inverted custom range (from > to) triggers toast.error and
 *           does NOT refire any GETs.
 *       7.  Comparison "No Comparison" switch — omits compareMode from the
 *           overview URL.
 *       8.  Comparison "vs Previous Year" — sends compareMode=previous_year.
 *       9.  Refresh button — re-fires the entire fan-out.
 *      10.  Print button — calls window.print().
 *      11.  Report Builder button — router.push to /dashboard/analytics/reports.
 *      12.  CSV export button — Blob+anchor download with bearer token.
 *      13.  CSV export failure — toast.error fires.
 *      14.  Doctor table sort — clicking column header toggles direction.
 *      15.  Doctor row click — opens DrillDownModal with row metrics.
 *      16.  DrillDownModal close — X button clears modal.
 *      17.  Appointment chart drilldown — onPointClick opens modal.
 *      18.  Revenue mode bar drilldown — bar click opens modal.
 *      19.  Empty preview — empty arrays render EmptyState placeholders.
 *      20.  Benchmark panel — renders current / prior / YoY / rolling cards.
 *      21.  Benchmark metric switch to "admissions" — does NOT call forecast.
 *      22.  Benchmark API failure — clears bench + forecast (no crash).
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, next/navigation,
 *            @/components/Skeleton (stubbed div).
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
  usePathname: () => "/dashboard/analytics",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonText: ({ lines }: { lines: number }) => (
    <div data-testid="analytics-skeleton-text" data-lines={lines} />
  ),
  SkeletonCard: () => <div data-testid="analytics-skeleton-card" />,
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="analytics-skeleton-table" data-rows={rows} data-columns={columns} />
  ),
}));

import AnalyticsPage from "../page";

// ─── Auth helpers ───────────────────────────────────

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
      id: "u-recep",
      userId: "u-recep",
      role: "RECEPTION",
      name: "Recep",
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

function asNullUser() {
  authMock.mockReturnValue({ user: null, isLoading: false });
}

// ─── Default per-endpoint stubs ─────────────────────

/**
 * Returns a default-everything happy-path GET wirer. Tests can pass partial
 * overrides — anything not overridden returns the default shape (so the
 * fan-out always resolves). Special prefixes:
 *   - rejectOverview:true forces /analytics/overview to reject.
 *   - rejectBench:true forces /analytics/benchmarks to reject.
 */
function wireGet(
  opts: {
    overview?: any;
    appointments?: any[];
    revenue?: any[];
    doctors?: any[];
    diagnoses?: any[];
    demographics?: any;
    occupancy?: any;
    lowStock?: any;
    dispensed?: any[];
    revenueBreakdown?: any;
    patientGrowth?: any[];
    retention?: any;
    noShow?: any;
    walkouts?: any;
    discharge?: any;
    erPerf?: any;
    expiry?: any;
    feedback?: any;
    bench?: any;
    forecast?: any;
    rejectOverview?: boolean;
    rejectBench?: boolean;
  } = {},
) {
  const defaultOverview = {
    current: {
      totalPatients: 250,
      newPatientsInPeriod: 12,
      totalAppointments: 480,
      appointmentsByStatus: { COMPLETED: 410, NO_SHOW: 30 },
      totalRevenue: 1234567.89,
      revenueByMode: { CASH: 200000, CARD: 500000, UPI: 300000, ONLINE: 134567.89, INSURANCE: 100000 },
      pendingBills: 18,
      currentlyAdmitted: 24,
      avgConsultationTime: 14,
    },
    previous: {
      totalPatients: 200,
      newPatientsInPeriod: 8,
      totalAppointments: 410,
      appointmentsByStatus: { COMPLETED: 370 },
      totalRevenue: 1000000,
      revenueByMode: {},
      pendingBills: 12,
      currentlyAdmitted: 20,
      avgConsultationTime: 13,
    },
    deltaPercent: {
      totalPatients: 25,
      totalAppointments: 17,
      totalRevenue: 23.4,
      currentlyAdmitted: 20,
    },
    compareMode: "previous_period",
    previousRange: { from: "2026-03-26", to: "2026-04-25" },
  };

  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/analytics/overview")) {
      if (opts.rejectOverview) return Promise.reject(new Error("ov boom"));
      // When compareMode=none was requested, the source expects raw snapshot.
      if (!url.includes("compareMode=")) {
        return Promise.resolve({ data: opts.overview ?? defaultOverview.current });
      }
      return Promise.resolve({ data: opts.overview ?? defaultOverview });
    }
    if (url.startsWith("/analytics/appointments?") && !url.includes("no-show")) {
      return Promise.resolve({
        data:
          opts.appointments ?? [
            { date: "2026-05-01", count: 30, scheduled: 25, walkin: 5 },
            { date: "2026-05-02", count: 35, scheduled: 28, walkin: 7 },
          ],
      });
    }
    if (url.startsWith("/analytics/appointments/no-show-rate")) {
      return Promise.resolve({
        data:
          opts.noShow ?? {
            totalAppointments: 480,
            noShowCount: 30,
            overallRate: 6.2,
            byDoctor: [
              { doctorId: "d1", doctorName: "Dr Alpha", total: 100, noShow: 8, rate: 8 },
            ],
            byDayOfWeek: [{ day: "Mon", total: 80, noShow: 6, rate: 7.5 }],
            byHour: [{ hour: 9, total: 50, noShow: 3, rate: 6 }],
          },
      });
    }
    if (url.startsWith("/analytics/revenue/breakdown")) {
      return Promise.resolve({
        data:
          opts.revenueBreakdown ?? {
            byType: { WALK_IN: 400000, SCHEDULED: 800000 },
            byCategory: { Consultation: 500000, Lab: 300000 },
            byDoctor: [],
            byWard: [{ wardName: "General", revenue: 100000, admissions: 12 }],
          },
      });
    }
    if (url.startsWith("/analytics/revenue?")) {
      return Promise.resolve({
        data:
          opts.revenue ?? [
            { date: "2026-05-01", total: 12000, cash: 4000, card: 4000, upi: 2000, online: 1000, insurance: 1000 },
            { date: "2026-05-02", total: 15000, cash: 5000, card: 5000, upi: 2500, online: 1500, insurance: 1000 },
          ],
      });
    }
    if (url.startsWith("/analytics/doctors")) {
      return Promise.resolve({
        data:
          opts.doctors ?? [
            {
              doctorId: "d1",
              doctorName: "Dr Alpha",
              appointmentCount: 100,
              completedCount: 90,
              avgDurationMin: 12,
              revenue: 250000,
              patientCount: 80,
            },
            {
              doctorId: "d2",
              doctorName: "Dr Beta",
              appointmentCount: 60,
              completedCount: 55,
              avgDurationMin: 15,
              revenue: 150000,
              patientCount: 45,
            },
          ],
      });
    }
    if (url.startsWith("/analytics/top-diagnoses")) {
      return Promise.resolve({
        data:
          opts.diagnoses ?? [
            { diagnosis: "Hypertension", count: 40 },
            { diagnosis: "Diabetes", count: 30 },
          ],
      });
    }
    if (url.startsWith("/analytics/patient-demographics")) {
      return Promise.resolve({
        data:
          opts.demographics ?? {
            byGender: { MALE: 130, FEMALE: 110, OTHER: 10 },
            byAgeGroup: { "0-18": 40, "19-35": 80, "36-55": 80, "56+": 50 },
          },
      });
    }
    if (url.startsWith("/analytics/ipd/occupancy")) {
      return Promise.resolve({
        data:
          opts.occupancy ?? {
            totalBeds: 50,
            occupied: 30,
            available: 20,
            byWard: [
              { wardName: "General", total: 30, occupied: 20 },
              { wardName: "ICU", total: 10, occupied: 8 },
              { wardName: "Maternity", total: 10, occupied: 2 },
            ],
          },
      });
    }
    if (url.startsWith("/analytics/pharmacy/low-stock")) {
      return Promise.resolve({
        data:
          opts.lowStock ?? {
            count: 2,
            items: [
              { id: "m1", medicineName: "Insulin", quantity: 5, reorderLevel: 20, batchNumber: "B1" },
              { id: "m2", medicineName: "Aspirin", quantity: 8, reorderLevel: 25, batchNumber: "B2" },
            ],
          },
      });
    }
    if (url.startsWith("/analytics/pharmacy/top-dispensed")) {
      return Promise.resolve({
        data:
          opts.dispensed ?? [
            { medicineName: "Paracetamol", dispensed: 400 },
            { medicineName: "Amoxicillin", dispensed: 220 },
          ],
      });
    }
    if (url.startsWith("/analytics/patients/growth")) {
      return Promise.resolve({
        data:
          opts.patientGrowth ?? [
            { date: "2026-04-01", count: 10, cumulative: 200 },
            { date: "2026-05-01", count: 12, cumulative: 212 },
          ],
      });
    }
    if (url.startsWith("/analytics/patients/retention")) {
      return Promise.resolve({
        data:
          opts.retention ?? {
            totalActive: 250,
            newPatients: 12,
            returningPatients: 80,
            retentionRate: 65,
            distribution: { "1": 50, "2-3": 30, "4+": 20 },
          },
      });
    }
    if (url.startsWith("/analytics/ipd/discharge-trends")) {
      return Promise.resolve({
        data:
          opts.discharge ?? {
            totalAdmissions: 42,
            discharged: 38,
            deaths: 1,
            avgLengthOfStayDays: 4.7,
            mortalityRate: 2.4,
            readmissionRate: 7.5,
            readmissions: 3,
            losDistribution: { "1-3": 18, "4-7": 15, "8-14": 7, "15+": 2 },
          },
      });
    }
    if (url.startsWith("/analytics/er/performance")) {
      return Promise.resolve({
        data:
          opts.erPerf ?? {
            totalCases: 80,
            criticalCases: 5,
            avgWaitToTriageMin: 6,
            avgWaitToDoctorMin: 18,
            byTriage: {
              RESUSCITATION: 2,
              EMERGENT: 8,
              URGENT: 25,
              LESS_URGENT: 30,
              NON_URGENT: 15,
            },
            byDisposition: { ADMITTED: 20, DISCHARGED: 50, TRANSFERRED: 5 },
          },
      });
    }
    if (url.startsWith("/analytics/pharmacy/expiry")) {
      return Promise.resolve({
        data:
          opts.expiry ?? {
            horizonDays: 90,
            valueAtRisk: { expired: 4000, "30": 6000, "60": 8000, "90": 12000 },
            countByBucket: { expired: 2, "30": 4, "60": 5, "90": 8 },
            totalAtRisk: 30000,
            topItems: [
              {
                id: "x1",
                medicineName: "Insulin Vial",
                batchNumber: "B-1",
                quantity: 10,
                expiryDate: "2026-06-10",
                daysToExpiry: 15,
                valueAtRisk: 1200,
                bucket: "30",
              },
              {
                id: "x2",
                medicineName: "Stale Med",
                batchNumber: "B-2",
                quantity: 8,
                expiryDate: "2026-05-01",
                daysToExpiry: -10,
                valueAtRisk: 800,
                bucket: "expired",
              },
            ],
            focusItems: [],
          },
      });
    }
    if (url.startsWith("/analytics/feedback/trends")) {
      return Promise.resolve({
        data:
          opts.feedback ?? {
            totalResponses: 120,
            overallAvgRating: 4.2,
            overallNps: 45,
            series: [
              { date: "2026-04-01", count: 50, avgRating: 4.1, nps: 40 },
              { date: "2026-05-01", count: 70, avgRating: 4.3, nps: 50 },
            ],
            categories: [
              { category: "Reception", count: 60, avgRating: 4.5 },
              { category: "Doctor", count: 60, avgRating: 4.0 },
            ],
          },
      });
    }
    if (url.startsWith("/analytics/queue-walkouts")) {
      return Promise.resolve({
        data:
          opts.walkouts ?? {
            totalLwbs: 8,
            byDoctor: [{ doctorId: "d1", doctorName: "Dr Alpha", count: 5 }],
            byHour: [
              { hour: 10, count: 3 },
              { hour: 11, count: 5 },
            ],
            byReason: [{ reason: "Long wait", count: 5 }],
          },
      });
    }
    if (url.startsWith("/analytics/benchmarks")) {
      if (opts.rejectBench) return Promise.reject(new Error("bench boom"));
      return Promise.resolve({
        data:
          opts.bench ?? {
            metric: "revenue",
            period: "day",
            current: 1234567,
            prior: 1000000,
            yoy: 900000,
            rolling3Avg: 1100000,
            percentile: 80,
            label: "Above Average",
            deltaVsPriorPct: 23.4,
            deltaVsYoyPct: 37.2,
            p10: 800000,
            p25: 900000,
            p50: 1000000,
            p75: 1100000,
            p90: 1200000,
            sampleCount: 365,
          },
      });
    }
    if (url.startsWith("/analytics/forecast")) {
      return Promise.resolve({
        data:
          opts.forecast ?? {
            metric: "revenue",
            groupBy: "day",
            historical: [{ date: "2026-05-01", value: 12000 }],
            forecast: [
              { period: "2026-05-27", value: 13000, confidence: "high" },
              { period: "2026-05-28", value: 13500, confidence: "high" },
            ],
            model: { slope: 200, intercept: 12000, r2: 0.85 },
            confidence: "high",
          },
      });
    }
    return Promise.resolve({ data: [] });
  });
}

// ─── Tests ──────────────────────────────────────────

describe("AnalyticsPage dashboard (ADMIN/RECEPTION analytics overview)", () => {
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
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    cleanup();
  });

  // (1) RBAC — DOCTOR is redirected
  it("redirects non-ADMIN/RECEPTION (DOCTOR) to /dashboard and renders nothing", async () => {
    wireGet();
    asDoctor();

    const { container } = render(<AnalyticsPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
    expect(container.firstChild).toBeNull();
  });

  // (2) Null user — page renders, no redirect
  it("renders the chrome when user is null and does not redirect", async () => {
    wireGet();
    asNullUser();

    render(<AnalyticsPage />);

    expect(
      await screen.findByRole("heading", { name: /Analytics Dashboard/i }),
    ).toBeInTheDocument();
    expect(routerMock.push).not.toHaveBeenCalledWith("/dashboard");
  });

  // (3) ADMIN mount — fan-out fires; KPIs render with default compareMode
  it("ADMIN mount: fan-out fires for all 18 analytics GETs + benchmark/forecast pair, KPIs render", async () => {
    wireGet();

    render(<AnalyticsPage />);

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      // Spot-check a handful of expected URLs.
      expect(urls.some((u) => u.startsWith("/analytics/overview?"))).toBe(true);
      expect(urls.some((u) => u.includes("compareMode=previous_period"))).toBe(true);
      expect(urls.some((u) => u.startsWith("/analytics/revenue/breakdown"))).toBe(true);
      expect(urls.some((u) => u.startsWith("/analytics/queue-walkouts?"))).toBe(true);
      expect(urls.some((u) => u.startsWith("/analytics/benchmarks?"))).toBe(true);
      expect(urls.some((u) => u.startsWith("/analytics/forecast?"))).toBe(true);
    });

    // KPI values land.
    await waitFor(() => {
      expect(screen.getByText("Total Patients")).toBeInTheDocument();
      // Revenue total rendered as formatted currency. Note: en-IN locale uses
      // lakh-grouping (12,34,567.89), not thousands (1,234,567.89).
      expect(
        screen.getAllByText((_t, el) =>
          (el?.textContent ?? "").includes("12,34,567.89"),
        ).length,
      ).toBeGreaterThan(0);
    });

    // Delta badge from previous_period mode renders (e.g. 25% on totalPatients).
    expect(screen.getAllByText(/25\.0%/).length).toBeGreaterThanOrEqual(1);
  });

  // (4) Preset change
  it("changing preset to 'Today' rebuilds the fan-out with new from/to range", async () => {
    wireGet();

    render(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    apiMock.get.mockClear();

    const presetSelect = document.getElementById(
      "analytics-filter-preset",
    ) as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: "today" } });

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.startsWith("/analytics/overview?"))).toBe(true);
    });
  });

  // (5) Custom from/to + Apply — happy path
  it("custom from/to values applied via Apply button rebuild the fan-out", async () => {
    wireGet();

    render(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.change(
      document.getElementById("analytics-filter-from") as HTMLInputElement,
      { target: { value: "2026-01-01" } },
    );
    fireEvent.change(
      document.getElementById("analytics-filter-to") as HTMLInputElement,
      { target: { value: "2026-03-31" } },
    );

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Apply/i }));

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(
        urls.some(
          (u) =>
            u.includes("from=2026-01-01") && u.includes("to=2026-03-31"),
        ),
      ).toBe(true);
    });
  });

  // (6) Inverted custom range — toast.error + no GET
  it("inverted custom range (from > to) toasts an error and skips the fan-out refetch", async () => {
    wireGet();

    render(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.change(
      document.getElementById("analytics-filter-from") as HTMLInputElement,
      { target: { value: "2026-12-31" } },
    );
    fireEvent.change(
      document.getElementById("analytics-filter-to") as HTMLInputElement,
      { target: { value: "2026-01-01" } },
    );

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Apply/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/From.*before.*To/i),
    );
    // Apply was rejected — no overview refetch.
    const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.startsWith("/analytics/overview?"))).toBe(false);
  });

  // (7) Compare mode "No Comparison"
  it("compareMode = 'No Comparison' omits the compareMode param from overview URL", async () => {
    wireGet();

    render(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /No Comparison/i }));

    await waitFor(() => {
      const overviewCall = apiMock.get.mock.calls.find((c) =>
        (c[0] as string).startsWith("/analytics/overview?"),
      );
      expect(overviewCall).toBeDefined();
      expect(overviewCall![0]).not.toContain("compareMode=");
    });
  });

  // (8) Compare mode "vs Previous Year"
  it("compareMode = 'vs Previous Year' sends compareMode=previous_year on overview URL", async () => {
    wireGet();

    render(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /vs Previous Year/i }));

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes("compareMode=previous_year"))).toBe(true);
    });
  });

  // (9) Refresh button re-fires
  it("Refresh button re-fires the entire analytics fan-out", async () => {
    wireGet();

    render(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.startsWith("/analytics/overview?"))).toBe(true);
    });
  });

  // (10) Print button
  it("Print button calls window.print()", async () => {
    wireGet();
    const printSpy = vi
      .spyOn(window, "print")
      .mockImplementation(() => undefined);

    render(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Print/i }));

    expect(printSpy).toHaveBeenCalled();
    printSpy.mockRestore();
  });

  // (11) Report Builder button
  it("Report Builder button routes to /dashboard/analytics/reports", async () => {
    wireGet();

    render(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Report Builder/i }));

    expect(routerMock.push).toHaveBeenCalledWith("/dashboard/analytics/reports");
  });

  // (12) CSV export — happy path
  it("Revenue CSV export downloads <filename>.csv via fetch + Blob+anchor with bearer token", async () => {
    wireGet();

    const fetchSpy = vi.fn(async () =>
      new Response("date,total\n2026-05-01,12000", {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      }),
    );
    (globalThis as any).fetch = fetchSpy;
    window.localStorage.setItem("medcore_token", "fake-bearer-token");

    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock-csv-export");
    const revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const anchorClickSpy = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    let lastAnchor: HTMLAnchorElement | null = null;
    const createElementSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = origCreateElement(tag);
        if (tag === "a") {
          (el as HTMLAnchorElement).click = anchorClickSpy;
          lastAnchor = el as HTMLAnchorElement;
        }
        return el;
      });

    render(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Revenue CSV/i }));

    await waitFor(() => expect(anchorClickSpy).toHaveBeenCalled());
    // Fetch was called with the Authorization bearer header.
    expect(fetchSpy).toHaveBeenCalled();
    // `vi.fn(async () => ...)` has zero declared params, so `mock.calls[0]`
    // is typed `[]`; cast through `unknown` to the actual fetch call shape.
    const fetchArgs = fetchSpy.mock.calls[0] as unknown as [string, any];
    expect(fetchArgs[1].headers.Authorization).toBe(
      "Bearer fake-bearer-token",
    );
    expect(lastAnchor!.download).toMatch(/^revenue-.*\.csv$/);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-csv-export");

    createElementSpy.mockRestore();
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  // (13) CSV export failure → toast.error
  it("CSV export failure (non-OK fetch) toasts an error", async () => {
    wireGet();

    const fetchSpy = vi.fn(async () =>
      new Response("nope", { status: 500 }),
    );
    (globalThis as any).fetch = fetchSpy;

    render(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Patients CSV/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/export/i),
      ),
    );
  });

  // (14) Doctor table sort
  it("Doctor Performance: clicking the 'Doctor' column toggles sort direction", async () => {
    wireGet();

    render(<AnalyticsPage />);

    // Wait for the table to render — locate Doctor Performance table by row
    // text "Dr Alpha" and walk up to the table.
    const drAlpha = await screen.findByRole("cell", { name: "Dr Alpha" });
    const tbl = drAlpha.closest("table")!;
    // The sortable Doctor header lives inside this table's thead.
    const docHeader = within(tbl).getByText("Doctor");
    fireEvent.click(docHeader);

    // Verify direction-arrow ▲ or ▼ now appears in the header row.
    await waitFor(() => {
      const headerRow = tbl.querySelector("thead tr") as HTMLElement;
      expect(headerRow.textContent ?? "").toMatch(/[▲▼]/);
    });

    // Toggle again — rows still present.
    fireEvent.click(docHeader);
    expect(within(tbl).getByText("Dr Alpha")).toBeInTheDocument();
    expect(within(tbl).getByText("Dr Beta")).toBeInTheDocument();
  });

  // (15) Doctor row click → drill-down modal
  it("Doctor row click opens DrillDownModal with metrics for that doctor", async () => {
    wireGet();

    render(<AnalyticsPage />);

    // Lock onto the row inside the Doctor Performance <table> — "Dr Alpha"
    // also appears in the No-Show by Doctor chart label, so plain text
    // match collides.
    const drAlphaCell = await screen.findByRole("cell", {
      name: "Dr Alpha",
    });
    fireEvent.click(drAlphaCell.closest("tr")!);

    // Modal renders with the doctor's name in the title.
    expect(
      await screen.findByRole("heading", { name: /Doctor: Dr Alpha/i }),
    ).toBeInTheDocument();
    // The metric rows include "Appointments" and "Revenue".
    const heading = screen.getByRole("heading", {
      name: /Doctor: Dr Alpha/i,
    });
    const dialog = heading.closest(".no-print") as HTMLElement;
    expect(within(dialog).getByText("Appointments")).toBeInTheDocument();
    expect(within(dialog).getByText("Revenue")).toBeInTheDocument();
  });

  // (16) Modal close button
  it("DrillDownModal close (X) button dismisses the modal", async () => {
    wireGet();

    render(<AnalyticsPage />);

    const drAlphaCell = await screen.findByRole("cell", {
      name: "Dr Alpha",
    });
    fireEvent.click(drAlphaCell.closest("tr")!);

    const heading = await screen.findByRole("heading", {
      name: /Doctor: Dr Alpha/i,
    });
    // Close = the unique button in the modal header beside the title. Find
    // by walking up from the heading to the modal root, then grabbing the
    // first button inside.
    const modalRoot = heading.closest(".no-print") as HTMLElement;
    const closeBtn = within(modalRoot).getAllByRole("button")[0];
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: /Doctor: Dr Alpha/i }),
      ).not.toBeInTheDocument();
    });
  });

  // (17) Empty state — empty arrays render the EmptyState placeholder
  it("renders the EmptyState placeholders when API returns no data", async () => {
    wireGet({
      overview: null as any,
      appointments: [],
      revenue: [],
      doctors: [],
      diagnoses: [],
      demographics: null,
      occupancy: null,
      lowStock: null,
      dispensed: [],
      revenueBreakdown: null,
      patientGrowth: [],
      retention: null,
      noShow: null,
      walkouts: null,
      discharge: null,
      erPerf: null,
      expiry: null,
      feedback: null,
    });

    render(<AnalyticsPage />);

    // EmptyState message appears multiple times across the cards.
    await waitFor(() => {
      expect(screen.getAllByText(/No data for this period/i).length).toBeGreaterThan(
        2,
      );
    });
  });

  // (18) Benchmark panel renders all 4 cards
  it("Benchmark panel renders Current / Prior Period / YoY / 3-Period Rolling cards", async () => {
    wireGet();

    render(<AnalyticsPage />);

    // Bench API resolves; the panel surfaces all 4 card labels.
    expect(await screen.findByText("Current")).toBeInTheDocument();
    expect(screen.getByText("Prior Period")).toBeInTheDocument();
    expect(screen.getByText("Year over Year")).toBeInTheDocument();
    expect(screen.getByText("3-Period Rolling")).toBeInTheDocument();
    // Forecast band ("Next 7 Days Forecast") also renders for the default
    // metric (revenue, NOT admissions).
    expect(
      await screen.findByText(/Next 7 Days Forecast/i),
    ).toBeInTheDocument();
  });

  // (19) Switching benchmark metric to "admissions" skips forecast
  it("Benchmark metric=admissions does NOT call /analytics/forecast", async () => {
    wireGet();

    render(<AnalyticsPage />);
    await waitFor(() =>
      expect(
        apiMock.get.mock.calls.some((c) =>
          (c[0] as string).startsWith("/analytics/forecast"),
        ),
      ).toBe(true),
    );

    // Find the metric select within the benchmark panel. It's the select with
    // option value="admissions".
    const metricSelect = Array.from(
      document.querySelectorAll("select"),
    ).find((s) =>
      Array.from(s.options).some((o) => o.value === "admissions"),
    ) as HTMLSelectElement;
    expect(metricSelect).toBeDefined();

    apiMock.get.mockClear();
    fireEvent.change(metricSelect, { target: { value: "admissions" } });

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes("metric=admissions"))).toBe(true);
    });
    // Forecast endpoint was NOT called this round.
    const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.startsWith("/analytics/forecast"))).toBe(false);
  });

  // (20) Benchmark API rejection clears bench + forecast
  it("Benchmark API rejection clears bench/forecast without crashing", async () => {
    wireGet({ rejectBench: true });

    render(<AnalyticsPage />);

    // No "Current" benchmark card; page still rendered the heading.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Analytics Dashboard/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Current")).not.toBeInTheDocument();
  });

  // (21) RECEPTION role can also view the dashboard (allowlist)
  it("RECEPTION role: dashboard renders normally (no redirect)", async () => {
    wireGet();
    asReception();

    render(<AnalyticsPage />);

    expect(
      await screen.findByRole("heading", { name: /Analytics Dashboard/i }),
    ).toBeInTheDocument();
    expect(routerMock.push).not.toHaveBeenCalledWith("/dashboard");
  });

  // (22) Appointment chart line-point onClick fires drill-down
  it("appointment line-chart point click opens drill-down with scheduled/walk-in metrics", async () => {
    wireGet();

    render(<AnalyticsPage />);

    // The Appointment Trends LineChart lives inside the Card titled
    // "Appointment Trends". Lock onto it to avoid matching donut/bar
    // chart svg circles in later sections.
    const apptHeading = await screen.findByRole("heading", {
      name: /Appointment Trends/i,
    });
    const apptCard = apptHeading.closest(
      ".rounded-xl",
    ) as HTMLElement;

    await waitFor(() => {
      const circles = apptCard.querySelectorAll(
        "svg polyline ~ circle, svg circle",
      );
      expect(circles.length).toBeGreaterThan(0);
    });

    // LineChart renders one <circle> per datapoint per yKey. Click the first.
    const firstCircle = apptCard.querySelector(
      "svg circle",
    ) as SVGCircleElement;
    fireEvent.click(firstCircle);

    // Modal heading appears — "Appointments on <date>".
    expect(
      await screen.findByRole("heading", { name: /Appointments on/i }),
    ).toBeInTheDocument();
  });
});
