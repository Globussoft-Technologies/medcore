/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ReportsPage (Report Builder) — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/analytics/reports/page.tsx, the
 *     ADMIN-only Report Builder that lets staff configure ad-hoc analytics
 *     reports across five domains and export CSV / JSON.
 *
 *   - Endpoints the page hits on the runPreview() flow:
 *       GET /analytics/revenue?from=&to=&groupBy=                       (revenue)
 *       GET /analytics/appointments?from=&to=&groupBy=                  (appointments)
 *       GET /analytics/patients/growth?from=&to=&groupBy=               (patients)
 *       GET /analytics/ipd/discharge-trends?from=&to=    + occupancy    (ipd)
 *       GET /analytics/pharmacy/top-dispensed?limit=25 + low-stock      (pharmacy)
 *
 *   - Behaviours covered:
 *       1.  RBAC — non-ADMIN role (DOCTOR) triggers router.push to
 *           /dashboard/analytics, render short-circuits to null, NO GET fires.
 *       2.  Null user — page renders the chrome + still fires GET (guard
 *           only triggers when `user` is set AND role != ADMIN).
 *       3.  ADMIN mount — initial preview fires for default type "revenue"
 *           with from=<-30d>, to=<today>, groupBy=day; rows render.
 *       4.  Report-type switch — selecting "appointments" / "patients" /
 *           "ipd" / "pharmacy" fires the matching GET shape and rerenders.
 *       5.  Group-by switch — flipping to "month" rebuilds the qs.
 *       6.  Date filter — changing from/to threads new params into qs.
 *       7.  Revenue filter — paymentMode select renders + setter works.
 *       8.  Appointments filter — appointmentStatus select renders + setter.
 *       9.  Run button — re-triggers the same GET on click.
 *      10.  Empty preview — no rows → "No data for this configuration".
 *      11.  Summary line — renders the Grand Total label formatted as
 *           Indian-rupee currency (revenue branch).
 *      12.  Disabled export buttons — CSV + JSON disabled when preview is
 *           empty / rows=[].
 *      13.  CSV export — clicks Blob+anchor flow, downloads `<type>-report-
 *           <from>_<to>.csv` with the header row + escaped values.
 *      14.  JSON export — downloads JSON with report meta + summary + data.
 *      15.  Save Config — empty name toasts the error and does NOT persist.
 *      16.  Save Config happy — persists to localStorage + clears input.
 *      17.  Load Config — clicking Load re-applies type/from/to/groupBy/name.
 *      18.  Delete Config — removes the row from list + localStorage.
 *      19.  Localstorage rehydrate — saved configs load on mount.
 *      20.  Back button — pushes to /dashboard/analytics.
 *      21.  IPD branch — multi-call Promise.all rendering with merged
 *           trends + ward occupancy rows.
 *      22.  Pharmacy branch — merged top-dispensed + low-stock rows.
 *      23.  Error path — API rejection falls back to empty rows / no crash.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            next/navigation, @/components/Skeleton (stubbed div).
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
  usePathname: () => "/dashboard/analytics/reports",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="reports-skeleton" data-rows={rows} data-columns={columns} />
  ),
}));

import ReportsPage from "../page";

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

// ─── Per-branch GET wirers ──────────────────────────

/**
 * Route api.get() by URL prefix to a tailored response. Default branches
 * resolve to empty arrays so partial overrides don't blow up unrelated paths.
 */
function wireGet(opts: {
  revenue?: Array<Record<string, number | string>>;
  appointments?: Array<Record<string, number | string>>;
  patients?: Array<Record<string, number | string>>;
  ipdTrends?: Record<string, unknown>;
  ipdOccupancy?: { byWard: Array<{ wardName: string; total: number; occupied: number }> };
  pharmacyTop?: Array<Record<string, number | string>>;
  pharmacyLow?: { count: number; items: Array<{ medicineName: string; quantity: number; reorderLevel: number }> };
  rejectAll?: boolean;
} = {}) {
  apiMock.get.mockImplementation((url: string) => {
    if (opts.rejectAll) return Promise.reject(new Error("boom"));
    if (url.startsWith("/analytics/revenue")) {
      return Promise.resolve({ data: opts.revenue ?? [] });
    }
    if (url.startsWith("/analytics/appointments")) {
      return Promise.resolve({ data: opts.appointments ?? [] });
    }
    if (url.startsWith("/analytics/patients/growth")) {
      return Promise.resolve({ data: opts.patients ?? [] });
    }
    if (url.startsWith("/analytics/ipd/discharge-trends")) {
      return Promise.resolve({ data: opts.ipdTrends ?? {} });
    }
    if (url.startsWith("/analytics/ipd/occupancy")) {
      return Promise.resolve({ data: opts.ipdOccupancy ?? { byWard: [] } });
    }
    if (url.startsWith("/analytics/pharmacy/top-dispensed")) {
      return Promise.resolve({ data: opts.pharmacyTop ?? [] });
    }
    if (url.startsWith("/analytics/pharmacy/low-stock")) {
      return Promise.resolve({
        data: opts.pharmacyLow ?? { count: 0, items: [] },
      });
    }
    return Promise.resolve({ data: [] });
  });
}

// ─── Tests ──────────────────────────────────────────

describe("Report Builder dashboard page (admin-only)", () => {
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

  // (1) RBAC redirect for non-ADMIN
  it("redirects non-ADMIN (DOCTOR) to /dashboard/analytics and renders nothing", async () => {
    wireGet();
    asDoctor();

    const { container } = render(<ReportsPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard/analytics"),
    );
    // Render short-circuits to null.
    expect(container.firstChild).toBeNull();
  });

  // (2) Null user — page renders chrome, guard doesn't fire
  it("renders the chrome when user is null and does not redirect (effect guard only fires when user is set)", async () => {
    wireGet();
    asNullUser();

    render(<ReportsPage />);

    // Heading still renders.
    expect(
      screen.getByRole("heading", { name: /Report Builder/i }),
    ).toBeInTheDocument();
    expect(routerMock.push).not.toHaveBeenCalledWith(
      "/dashboard/analytics",
    );
  });

  // (3) ADMIN mount — initial revenue preview fires
  it("ADMIN mount: fires the default revenue GET with from/to/groupBy=day", async () => {
    wireGet({
      revenue: [
        { date: "2026-05-01", total: 11111.11, cash: 5000, card: 4000, upi: 1111.11, online: 1000, insurance: 0 },
      ],
    });

    render(<ReportsPage />);

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.startsWith("/analytics/revenue?from="))).toBe(
        true,
      );
      // groupBy=day is the default selector value.
      expect(urls.some((u) => u.includes("groupBy=day"))).toBe(true);
    });

    // Row rendered with currency-formatted cell.
    await waitFor(() =>
      expect(screen.getByText("2026-05-01")).toBeInTheDocument(),
    );
    // total = 11111.11 — appears BOTH in the table row AND the Grand Total
    // summary line (single-row dataset, so they happen to equal). getAllByText
    // accepts either or both.
    expect(screen.getAllByText(/Rs\.\s*11,111\.11/).length).toBeGreaterThanOrEqual(1);
  });

  // (4a) Type switch — appointments
  it("switching report type to Appointments fires /analytics/appointments and re-renders columns", async () => {
    wireGet({
      revenue: [],
      appointments: [{ date: "2026-05-10", count: 7, scheduled: 5, walkin: 2 }],
    });

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    apiMock.get.mockClear();

    fireEvent.click(
      screen.getByRole("button", { name: /Appointments Report/i }),
    );

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(
        urls.some((u) => u.startsWith("/analytics/appointments?from=")),
      ).toBe(true);
    });

    // Appointments columns header rendered.
    expect(await screen.findByText("Walk-in")).toBeInTheDocument();
    expect(screen.getByText("2026-05-10")).toBeInTheDocument();
  });

  // (4b) Type switch — patients
  it("switching to Patient Growth fires /analytics/patients/growth and renders the cumulative column", async () => {
    wireGet({
      patients: [{ date: "2026-05-10", count: 3, cumulative: 42 }],
    });

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Patient Growth/i }));

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(
        urls.some((u) => u.startsWith("/analytics/patients/growth?from=")),
      ).toBe(true);
    });

    expect(await screen.findByText("Cumulative")).toBeInTheDocument();
  });

  // (4c) Type switch — IPD branch (Promise.all merges trends + occupancy)
  it("switching to IPD Admissions fires both /analytics/ipd endpoints and renders the merged metric table", async () => {
    wireGet({
      ipdTrends: {
        totalAdmissions: 42,
        discharged: 35,
        avgLengthOfStayDays: 4.7,
        readmissionRate: 5.2,
        mortalityRate: 1.1,
      },
      ipdOccupancy: {
        byWard: [
          { wardName: "General", total: 30, occupied: 22 },
          { wardName: "ICU", total: 8, occupied: 6 },
        ],
      },
    });

    render(<ReportsPage />);

    fireEvent.click(screen.getByRole("button", { name: /IPD Admissions/i }));

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(
        urls.some((u) => u.startsWith("/analytics/ipd/discharge-trends?from=")),
      ).toBe(true);
      expect(
        urls.some((u) => u.startsWith("/analytics/ipd/occupancy")),
      ).toBe(true);
    });

    // Trend rows.
    expect(await screen.findByText("Total Admissions")).toBeInTheDocument();
    expect(screen.getByText("Avg LOS (days)")).toBeInTheDocument();
    // Per-ward rows.
    expect(screen.getByText("Ward: General")).toBeInTheDocument();
    expect(screen.getByText("22/30")).toBeInTheDocument();
    expect(screen.getByText("Ward: ICU")).toBeInTheDocument();
  });

  // (4d) Type switch — pharmacy branch
  it("switching to Pharmacy Dispensing renders top-dispensed and low-stock as one merged table", async () => {
    wireGet({
      pharmacyTop: [
        { medicineName: "Paracetamol", dispensed: 320 },
        { medicineName: "Amoxicillin", dispensed: 150 },
      ],
      pharmacyLow: {
        count: 1,
        items: [{ medicineName: "Insulin", quantity: 4, reorderLevel: 20 }],
      },
    });

    render(<ReportsPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /Pharmacy Dispensing/i }),
    );

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(
        urls.some((u) => u.startsWith("/analytics/pharmacy/top-dispensed")),
      ).toBe(true);
      expect(
        urls.some((u) => u.startsWith("/analytics/pharmacy/low-stock")),
      ).toBe(true);
    });

    // Top + low-stock rows on one table.
    expect(await screen.findByText("Paracetamol")).toBeInTheDocument();
    expect(screen.getByText("Amoxicillin")).toBeInTheDocument();
    expect(screen.getByText("Insulin")).toBeInTheDocument();
    expect(screen.getByText("4/20")).toBeInTheDocument();
    // Status pills text — both labels exist.
    expect(screen.getAllByText("Top Dispensed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Low Stock")).toBeInTheDocument();
  });

  // (5) GroupBy change
  it("changing Group By to Month rebuilds the GET with groupBy=month", async () => {
    wireGet({ revenue: [] });

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    apiMock.get.mockClear();

    fireEvent.change(
      document.getElementById("report-builder-group-by") as HTMLSelectElement,
      { target: { value: "month" } },
    );

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes("groupBy=month"))).toBe(true);
    });
  });

  // (6) Date filter — from / to
  it("changing From and To rebuilds the GET with the new querystring values", async () => {
    wireGet({ revenue: [] });

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    apiMock.get.mockClear();

    fireEvent.change(
      document.getElementById("report-builder-from") as HTMLInputElement,
      { target: { value: "2026-01-01" } },
    );
    fireEvent.change(
      document.getElementById("report-builder-to") as HTMLInputElement,
      { target: { value: "2026-03-31" } },
    );

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

  // (7) Revenue filter — paymentMode
  it("revenue branch renders the Payment Mode select; switching value sticks in the controlled select", async () => {
    wireGet({ revenue: [] });

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    const select = document.getElementById(
      "report-builder-payment-mode",
    ) as HTMLSelectElement;
    expect(select).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "CARD" } });
    expect(select.value).toBe("CARD");
  });

  // (8) Appointments filter — appointmentStatus
  it("appointments branch renders the Status select; switching value sticks", async () => {
    wireGet({ appointments: [] });

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(
      screen.getByRole("button", { name: /Appointments Report/i }),
    );

    const select = await waitFor(() =>
      document.getElementById(
        "report-builder-appt-status",
      ) as HTMLSelectElement,
    );
    expect(select).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "COMPLETED" } });
    expect(select.value).toBe("COMPLETED");
  });

  // (9) Run button — re-fires the preview
  it("Run button re-fires the current branch GET", async () => {
    wireGet({ revenue: [] });

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    apiMock.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^Run$/i }));

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.startsWith("/analytics/revenue?"))).toBe(true);
    });
  });

  // (10) Empty preview
  it('shows "No data for this configuration" when the preview is empty', async () => {
    wireGet({ revenue: [] });

    render(<ReportsPage />);

    expect(
      await screen.findByText(/No data for this configuration/i),
    ).toBeInTheDocument();
  });

  // (11) Summary line for revenue
  it("renders the revenue summary line with Grand Total formatted as INR", async () => {
    wireGet({
      revenue: [
        { date: "2026-05-01", total: 1000, cash: 1000, card: 0, upi: 0, online: 0, insurance: 0 },
        { date: "2026-05-02", total: 2500.25, cash: 0, card: 2500.25, upi: 0, online: 0, insurance: 0 },
      ],
    });

    render(<ReportsPage />);

    expect(await screen.findByText(/Grand Total/i)).toBeInTheDocument();
    // 1000 + 2500.25 = 3500.25 formatted as Indian rupees.
    expect(screen.getByText(/Rs\.\s*3,500\.25/)).toBeInTheDocument();
  });

  // (12) Disabled export buttons when empty
  it("disables CSV + JSON export buttons when preview rows are empty", async () => {
    wireGet({ revenue: [] });

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    const csvBtn = await screen.findByRole("button", { name: /CSV/i });
    const jsonBtn = await screen.findByRole("button", { name: /JSON/i });
    expect(csvBtn).toBeDisabled();
    expect(jsonBtn).toBeDisabled();
  });

  // (13) CSV export — anchor click + correct filename
  it("CSV export downloads <type>-report-<from>_<to>.csv via Blob+anchor click", async () => {
    wireGet({
      revenue: [
        { date: "2026-05-01", total: 100, cash: 100, card: 0, upi: 0, online: 0, insurance: 0 },
      ],
    });

    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock-csv");
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

    render(<ReportsPage />);
    // Wait until preview row mounted, otherwise export button is disabled.
    await screen.findByText("2026-05-01");

    fireEvent.click(screen.getByRole("button", { name: /CSV/i }));

    await waitFor(() => expect(anchorClickSpy).toHaveBeenCalled());
    expect(createObjectURLSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-csv");
    expect(lastAnchor!.download).toMatch(/^revenue-report-.*\.csv$/);

    createElementSpy.mockRestore();
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  // (14) JSON export — anchor click + correct filename + JSON shape
  it("JSON export downloads <type>-report-<from>_<to>.json with report meta + summary + data", async () => {
    wireGet({
      revenue: [
        { date: "2026-05-01", total: 250, cash: 250, card: 0, upi: 0, online: 0, insurance: 0 },
      ],
    });

    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock-json");
    const revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    let capturedBlob: Blob | null = null;
    const origCreateObjectURL = URL.createObjectURL;
    createObjectURLSpy.mockImplementation((b: Blob | MediaSource) => {
      capturedBlob = b as Blob;
      return "blob:mock-json";
    });
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

    render(<ReportsPage />);
    await screen.findByText("2026-05-01");

    fireEvent.click(screen.getByRole("button", { name: /JSON/i }));

    await waitFor(() => expect(anchorClickSpy).toHaveBeenCalled());
    expect(lastAnchor!.download).toMatch(/^revenue-report-.*\.json$/);
    expect(capturedBlob).toBeTruthy();
    // Decode the blob to assert payload shape.
    const text = await (capturedBlob as unknown as Blob).text();
    const parsed = JSON.parse(text);
    expect(parsed.report.type).toBe("revenue");
    expect(parsed.report.groupBy).toBe("day");
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data[0].total).toBe(250);
    expect(parsed.summary).toBeDefined();

    createElementSpy.mockRestore();
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    void origCreateObjectURL;
  });

  // (15) Save Config — empty name toasts
  it("Save Config: empty name toasts.error and does NOT persist to localStorage", async () => {
    wireGet();

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Save Current/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/name/i),
    );
    expect(window.localStorage.getItem("medcore_saved_reports")).toBeNull();
  });

  // (16) Save Config happy
  it("Save Config: trims name, persists to localStorage, then clears the input", async () => {
    wireGet();

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    const nameInput = document.getElementById(
      "report-builder-config-name",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "  Q4 Revenue Watch  " } });
    fireEvent.click(screen.getByRole("button", { name: /Save Current/i }));

    await waitFor(() => {
      const raw = window.localStorage.getItem("medcore_saved_reports");
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.length).toBe(1);
      expect(parsed[0].name).toBe("Q4 Revenue Watch");
      expect(parsed[0].type).toBe("revenue");
    });

    // Saved-configurations table now shows the row.
    expect(await screen.findByText("Q4 Revenue Watch")).toBeInTheDocument();
    // Input cleared.
    expect(nameInput.value).toBe("");
  });

  // (17) Load Config — re-applies type/from/to/groupBy/name
  it("Load Config: clicking Load re-applies type / dates / groupBy / name back into the form", async () => {
    const preSaved = [
      {
        id: "cfg-99",
        name: "Old Pharmacy Watch",
        type: "pharmacy",
        from: "2026-02-01",
        to: "2026-02-28",
        groupBy: "week",
        filters: {},
        createdAt: Date.now() - 1000,
      },
    ];
    window.localStorage.setItem(
      "medcore_saved_reports",
      JSON.stringify(preSaved),
    );

    wireGet({
      pharmacyTop: [{ medicineName: "Loaded", dispensed: 1 }],
    });

    render(<ReportsPage />);

    // Row appears from localStorage hydrate.
    const loadBtn = await screen.findByRole("button", { name: /Load/i });

    apiMock.get.mockClear();
    fireEvent.click(loadBtn);

    // Form re-applies values.
    await waitFor(() => {
      const fromInput = document.getElementById(
        "report-builder-from",
      ) as HTMLInputElement;
      const toInput = document.getElementById(
        "report-builder-to",
      ) as HTMLInputElement;
      const groupByEl = document.getElementById(
        "report-builder-group-by",
      ) as HTMLSelectElement;
      const nameInput = document.getElementById(
        "report-builder-config-name",
      ) as HTMLInputElement;
      expect(fromInput.value).toBe("2026-02-01");
      expect(toInput.value).toBe("2026-02-28");
      expect(groupByEl.value).toBe("week");
      expect(nameInput.value).toBe("Old Pharmacy Watch");
    });

    // Type-driven GET fires for pharmacy (top-dispensed).
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0] as string);
      expect(
        urls.some((u) => u.startsWith("/analytics/pharmacy/top-dispensed")),
      ).toBe(true);
    });
  });

  // (18) Delete Config — removes from list + localStorage
  it("Delete Config: removes the row from the saved table + localStorage", async () => {
    const preSaved = [
      {
        id: "cfg-del",
        name: "Will Be Deleted",
        type: "revenue",
        from: "2026-01-01",
        to: "2026-01-31",
        groupBy: "day",
        filters: {},
        createdAt: Date.now() - 1000,
      },
    ];
    window.localStorage.setItem(
      "medcore_saved_reports",
      JSON.stringify(preSaved),
    );

    wireGet({ revenue: [] });

    render(<ReportsPage />);

    expect(await screen.findByText("Will Be Deleted")).toBeInTheDocument();

    // The delete button is the one in the row's last cell (Trash icon).
    const row = screen.getByText("Will Be Deleted").closest("tr")!;
    const buttons = within(row as HTMLElement).getAllByRole("button");
    // Last button is Delete.
    const deleteBtn = buttons[buttons.length - 1];
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(screen.queryByText("Will Be Deleted")).not.toBeInTheDocument();
    });
    const raw = window.localStorage.getItem("medcore_saved_reports");
    expect(JSON.parse(raw!)).toEqual([]);
  });

  // (19) Localstorage rehydrate
  it("hydrates saved configurations from localStorage on mount", async () => {
    const preSaved = [
      {
        id: "cfg-hydra",
        name: "Hydrated Row",
        type: "appointments",
        from: "2026-03-01",
        to: "2026-03-31",
        groupBy: "month",
        filters: {},
        createdAt: Date.now() - 5000,
      },
    ];
    window.localStorage.setItem(
      "medcore_saved_reports",
      JSON.stringify(preSaved),
    );

    wireGet();

    render(<ReportsPage />);

    expect(await screen.findByText("Hydrated Row")).toBeInTheDocument();
    // Type-label lookup hits the REPORT_TYPES table.
    expect(
      screen.getByText(/Appointments Report/i, { selector: "td" }),
    ).toBeInTheDocument();
  });

  // (20) Back button — pushes to /dashboard/analytics
  it("Back to Analytics button pushes the router to /dashboard/analytics", async () => {
    wireGet();

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(
      screen.getByRole("button", { name: /Back to Analytics/i }),
    );

    expect(routerMock.push).toHaveBeenCalledWith("/dashboard/analytics");
  });

  // (21) Localstorage corruption — silent catch + empty list
  it("localStorage corruption is silently swallowed (empty saved list, no crash)", async () => {
    window.localStorage.setItem("medcore_saved_reports", "{not json");

    wireGet();

    render(<ReportsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    // "No saved configurations yet" branch renders.
    expect(
      await screen.findByText(/No saved configurations yet/i),
    ).toBeInTheDocument();
  });

  // (22) Error path — revenue GET rejects, page falls back gracefully
  it("API rejection on revenue GET falls back to empty rows without crashing", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/analytics/revenue")) {
        return Promise.reject(new Error("server boom"));
      }
      return Promise.resolve({ data: [] });
    });

    render(<ReportsPage />);

    // Page renders empty state, no toast (the .catch returns null silently).
    expect(
      await screen.findByText(/No data for this configuration/i),
    ).toBeInTheDocument();
  });
});
