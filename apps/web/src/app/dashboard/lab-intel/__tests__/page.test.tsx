/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * LabIntelPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/lab-intel/page.tsx`, the DOCTOR/ADMIN/NURSE
 *     Lab Result Intelligence dashboard (Sprint 2 / PRD §7.2). Endpoints
 *     the page hits in parallel on mount + on refresh / filter change:
 *       GET /ai/lab-intel/aggregates?from=&to=
 *       GET /ai/lab-intel/critical?from=&to=[&severity=...]
 *       GET /ai/lab-intel/deviations?from=&to=
 *
 *   - Behaviours covered:
 *       1. isLoading=true branch — early skeleton render, no fetch.
 *       2. Role gate — non-allowed role (RECEPTION) toast-errors,
 *          router.replace to /dashboard/not-authorized?from=..., and the
 *          render path short-circuits to null (no data fetches).
 *       3. Happy fetch — three parallel GETs fire with from/to + token;
 *          KPI tiles render aggregate values with pct / count formatting;
 *          critical rows render in the DataTable (patient link, severity
 *          pill, formatted flaggedAt, View Order action for DOCTOR/ADMIN).
 *       4. Severity filter — changing the <select> appends &severity=...
 *          to the critical-list GET on the next refresh tick.
 *       5. Refresh button — click re-issues all 3 GETs (mockClear pattern).
 *       6. NURSE read-only branch — readonly banner renders + Actions cell
 *          shows "View only" instead of the View Order link.
 *       7. Deviations rendering — Sparkline path (length >= 2) + single-
 *          value short-circuit + empty short-circuit branches all hit; up
 *          vs down direction class branch covered.
 *       8. Empty-state hooks — `lab-intel-empty` sr-only marker for
 *          criticals=[] + `lab-intel-deviations-empty` block for
 *          deviations=[].
 *       9. Error-path resilience — every endpoint `.catch(() => null)`,
 *          so a single rejection just yields null/empty state, no banner.
 *      10. Auth-skip — no token short-circuits fetchAll (0 GETs).
 *      11. formatDateTime fallback — invalid ISO renders the raw string.
 *      12. KpiTile loading=true branch — Skeleton instead of value.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            next/navigation (useRouter, usePathname).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";

const {
  apiMock,
  authMock,
  toastErrorMock,
  toastSuccessMock,
  routerReplaceMock,
  routerPushMock,
} = vi.hoisted(() => ({
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
  routerReplaceMock: vi.fn(),
  routerPushMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: routerReplaceMock,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/lab-intel",
}));

import LabIntelPage from "../page";

// ─── Fixtures ────────────────────────────────────────────

type CriticalRow = {
  id: string;
  patientId: string;
  patientName: string;
  testName: string;
  result: string;
  unit?: string | null;
  referenceRange: string;
  severity: "CRITICAL" | "HIGH";
  flaggedAt: string;
  labOrderId?: string;
};

type DeviationRow = {
  patientId: string;
  patientName: string;
  parameter: string;
  recentValues: number[];
  deviationPct: number;
  direction: "up" | "down";
};

function aggregatesFixture(overrides: any = {}) {
  return {
    criticalsThisWeek: 7,
    patientsWithTrendConcerns: 4,
    testsOutsideRefRange: 22,
    averageDeviationPct: 12.5,
    ...overrides,
  };
}

function criticalsFixture(): CriticalRow[] {
  return [
    {
      id: "c-1",
      patientId: "p-1",
      patientName: "Aanya Sharma",
      testName: "Potassium",
      result: "6.7",
      unit: "mmol/L",
      referenceRange: "3.5-5.0",
      severity: "CRITICAL",
      flaggedAt: "2026-04-01T10:00:00.000Z",
      labOrderId: "lab-order-1",
    },
    {
      id: "c-2",
      patientId: "p-2",
      patientName: "Rohit Verma",
      testName: "Hemoglobin",
      result: "7.2",
      // unit intentionally omitted to hit the "no unit" branch
      referenceRange: "",
      severity: "HIGH",
      flaggedAt: "not-a-date", // hits formatDateTime catch branch
      // labOrderId intentionally omitted to hit the dash-fallback branch
    },
  ];
}

function deviationsFixture(): DeviationRow[] {
  return [
    {
      patientId: "p-1",
      patientName: "Aanya Sharma",
      parameter: "Creatinine",
      recentValues: [1.1, 1.3, 1.6, 2.0], // ≥2 vals → real sparkline path
      deviationPct: 35.4,
      direction: "up",
    },
    {
      patientId: "p-2",
      patientName: "Rohit Verma",
      parameter: "Hemoglobin",
      recentValues: [12.5], // single value → short-circuit branch
      deviationPct: 8.2,
      direction: "down",
    },
    {
      patientId: "p-3",
      patientName: "Sara Iyer",
      parameter: "WBC",
      recentValues: [], // empty array → short-circuit dash branch
      deviationPct: 0,
      direction: "up",
    },
  ];
}

/** Route api.get by URL prefix — three parallel fetches per render cycle. */
function wireGet(opts: {
  aggregates?: any;
  criticals?: CriticalRow[];
  deviations?: DeviationRow[];
  aggregatesReject?: boolean;
  criticalsReject?: boolean;
  deviationsReject?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/ai/lab-intel/aggregates")) {
      if (opts.aggregatesReject) return Promise.reject(new Error("agg-fail"));
      return Promise.resolve({
        data: opts.aggregates ?? aggregatesFixture(),
      });
    }
    if (url.startsWith("/ai/lab-intel/critical")) {
      if (opts.criticalsReject) return Promise.reject(new Error("crit-fail"));
      return Promise.resolve({ data: opts.criticals ?? criticalsFixture() });
    }
    if (url.startsWith("/ai/lab-intel/deviations")) {
      if (opts.deviationsReject) return Promise.reject(new Error("dev-fail"));
      return Promise.resolve({ data: opts.deviations ?? deviationsFixture() });
    }
    return Promise.resolve({ data: null });
  });
}

// ─── Tests ────────────────────────────────────────────

describe("LabIntelPage dashboard surface", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    routerReplaceMock.mockReset();
    routerPushMock.mockReset();
    authMock.mockReset();
    // Default: DOCTOR with token. Individual tests override.
    authMock.mockReturnValue({
      token: "tok-doc",
      user: { id: "u-doc", role: "DOCTOR" },
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading skeleton (and skips fetch) while auth is still loading", () => {
    authMock.mockReturnValue({
      token: null,
      user: null,
      isLoading: true,
    });

    render(<LabIntelPage />);

    expect(screen.getByTestId("lab-intel-page")).toBeInTheDocument();
    // No header title yet — the early-loading branch returns a skeleton-only
    // shell. The data-driven panels MUST NOT have rendered.
    expect(screen.queryByTestId("lab-intel-title")).not.toBeInTheDocument();
    expect(screen.queryByTestId("lab-intel-from")).not.toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("redirects RECEPTION (disallowed role) to /dashboard/not-authorized with toast and skips fetch", async () => {
    authMock.mockReturnValue({
      token: "tok-rec",
      user: { id: "u-rec", role: "RECEPTION" },
      isLoading: false,
    });

    const { container } = render(<LabIntelPage />);

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Lab Result Intelligence is restricted to clinical staff.",
      );
    });
    expect(routerReplaceMock).toHaveBeenCalledWith(
      "/dashboard/not-authorized?from=%2Fdashboard%2Flab-intel",
    );
    // The component returns `null` once role is disallowed (post-isLoading).
    expect(container.innerHTML).toBe("");
    // No data fetches attempted — fetchAll bails early on disallowed role.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("does not fetch when no token is present, even for an allowed role", async () => {
    authMock.mockReturnValue({
      token: null,
      user: { id: "u-doc", role: "DOCTOR" },
      isLoading: false,
    });

    render(<LabIntelPage />);

    // Page chrome renders (header, filters, KPI tiles with default 0s),
    // but fetchAll short-circuits at `!token`.
    expect(screen.getByTestId("lab-intel-title")).toBeInTheDocument();
    await waitFor(() => {
      expect(apiMock.get).not.toHaveBeenCalled();
    });
    // KPI tiles show the `?? 0` defaults.
    expect(screen.getByTestId("lab-intel-kpi-criticals")).toHaveTextContent("0");
    expect(screen.getByTestId("lab-intel-kpi-avg-deviation")).toHaveTextContent(
      "0.0%",
    );
  });

  it("issues three parallel GETs (aggregates + critical + deviations) with from/to + token on mount for DOCTOR", async () => {
    wireGet({});

    render(<LabIntelPage />);

    expect(screen.getByTestId("lab-intel-title")).toHaveTextContent(
      "Lab Result Intelligence",
    );

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    const urls = apiMock.get.mock.calls.map(([u]) => String(u));
    const aggUrl = urls.find((u) => u.startsWith("/ai/lab-intel/aggregates"));
    const critUrl = urls.find((u) => u.startsWith("/ai/lab-intel/critical"));
    const devUrl = urls.find((u) => u.startsWith("/ai/lab-intel/deviations"));

    expect(aggUrl).toBeTruthy();
    expect(critUrl).toBeTruthy();
    expect(devUrl).toBeTruthy();
    expect(aggUrl!).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    // No severity filter on first render — querystring should NOT contain it.
    expect(critUrl!).not.toMatch(/severity=/);

    // Token threaded through opts on every call.
    for (const call of apiMock.get.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ token: "tok-doc" }));
    }
  });

  it("renders KPI tiles with formatted aggregate values (count vs pct)", async () => {
    wireGet({ aggregates: aggregatesFixture({ averageDeviationPct: 8.75 }) });

    render(<LabIntelPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    await waitFor(() => {
      expect(screen.getByTestId("lab-intel-kpi-criticals")).toHaveTextContent("7");
    });
    expect(screen.getByTestId("lab-intel-kpi-deviations")).toHaveTextContent("4");
    expect(screen.getByTestId("lab-intel-kpi-outside-range")).toHaveTextContent(
      "22",
    );
    // pct formatter — `${value.toFixed(1)}%`
    expect(screen.getByTestId("lab-intel-kpi-avg-deviation")).toHaveTextContent(
      "8.8%",
    );
  });

  it("renders critical rows in the DataTable with patient link, severity pill, formatted flaggedAt, and View Order action for DOCTOR", async () => {
    wireGet({});

    render(<LabIntelPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    // The DataTable renders both desktop AND mobile responsive variants of
    // each row — the row-link testid is the unique anchor.
    const rowLinks = await screen.findAllByTestId("lab-intel-row-c-1");
    expect(rowLinks.length).toBeGreaterThan(0);
    expect(rowLinks[0].closest("a")).toHaveAttribute(
      "href",
      "/dashboard/patients/p-1",
    );
    expect(rowLinks[0]).toHaveTextContent("Aanya Sharma");

    // Severity pill text appears for both rows (CRITICAL + HIGH branches).
    expect(screen.getAllByText("CRITICAL").length).toBeGreaterThan(0);
    expect(screen.getAllByText("HIGH").length).toBeGreaterThan(0);

    // Test names visible somewhere in the DataTable (desktop OR mobile clone).
    expect(screen.getAllByText("Potassium").length).toBeGreaterThan(0);
    // Two "Hemoglobin"s: one in criticals, one in deviations. Both fine.
    expect(screen.getAllByText("Hemoglobin").length).toBeGreaterThan(0);

    // Unit suffix on c-1, dash fallback for empty referenceRange on c-2,
    // and raw ISO fallback when flaggedAt is unparseable.
    expect(screen.getAllByText("mmol/L").length).toBeGreaterThan(0);
    expect(screen.getAllByText("not-a-date").length).toBeGreaterThan(0);
    expect(screen.getAllByText("3.5-5.0").length).toBeGreaterThan(0);

    // DOCTOR sees the View Order action for the row that has labOrderId.
    const viewOrders = screen.getAllByRole("link", { name: /View Order/i });
    expect(viewOrders.length).toBeGreaterThan(0);
    expect(viewOrders[0]).toHaveAttribute("href", "/dashboard/lab/lab-order-1");

    // The plural-vs-singular footer copy: 2 criticals → "2 results".
    expect(screen.getByText("2 results")).toBeInTheDocument();
  });

  it("appends &severity=CRITICAL to the critical-list GET when the severity filter is changed", async () => {
    wireGet({});

    render(<LabIntelPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));
    apiMock.get.mockClear();
    wireGet({});

    fireEvent.change(screen.getByTestId("lab-intel-severity"), {
      target: { value: "CRITICAL" },
    });

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map(([u]) => String(u));
      expect(
        urls.some((u) =>
          /\/ai\/lab-intel\/critical\?.+severity=CRITICAL/.test(u),
        ),
      ).toBe(true);
    });
  });

  it("re-issues all three GETs when the refresh button is clicked", async () => {
    wireGet({});

    render(<LabIntelPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));
    apiMock.get.mockClear();
    wireGet({});

    fireEvent.click(screen.getByTestId("lab-intel-refresh"));

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));
    const urls = apiMock.get.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.startsWith("/ai/lab-intel/aggregates"))).toBe(
      true,
    );
    expect(urls.some((u) => u.startsWith("/ai/lab-intel/critical"))).toBe(true);
    expect(urls.some((u) => u.startsWith("/ai/lab-intel/deviations"))).toBe(
      true,
    );
  });

  it("re-fetches with the new range when from/to date inputs change (+48h to avoid IST/UTC midnight traps)", async () => {
    wireGet({});

    render(<LabIntelPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));
    apiMock.get.mockClear();
    wireGet({});

    fireEvent.change(screen.getByTestId("lab-intel-from"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(screen.getByTestId("lab-intel-to"), {
      target: { value: "2026-01-03" }, // +48h, not +24h
    });

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map(([u]) => String(u));
      expect(
        urls.some(
          (u) =>
            u.startsWith("/ai/lab-intel/aggregates") &&
            u.includes("from=2026-01-01") &&
            u.includes("to=2026-01-03"),
        ),
      ).toBe(true);
    });
  });

  it("shows the read-only banner for NURSE and renders 'View only' in the Actions column instead of View Order", async () => {
    authMock.mockReturnValue({
      token: "tok-nurse",
      user: { id: "u-nurse", role: "NURSE" },
      isLoading: false,
    });
    wireGet({});

    render(<LabIntelPage />);

    expect(
      await screen.findByTestId("lab-intel-readonly-banner"),
    ).toBeInTheDocument();

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));
    // Wait for the criticals row to render (responsive desktop+mobile twins
    // → findAllByTestId; both must be present for the row to exist).
    await screen.findAllByTestId("lab-intel-row-c-1");

    // NO View Order link should render — NURSE sees "View only" copy.
    expect(
      screen.queryByRole("link", { name: /View Order/i }),
    ).not.toBeInTheDocument();
    // The "View only" text appears at least once (row with labOrderId).
    expect(screen.getAllByText("View only").length).toBeGreaterThan(0);
  });

  it("renders the deviations list with sparkline (≥2 values), single-value short-circuit, empty short-circuit, and up vs down direction pills", async () => {
    wireGet({});

    render(<LabIntelPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    // Each deviation row keys on patientId.
    await waitFor(() => {
      expect(screen.getByTestId("lab-intel-deviation-p-1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("lab-intel-deviation-p-2")).toBeInTheDocument();
    expect(screen.getByTestId("lab-intel-deviation-p-3")).toBeInTheDocument();

    // Row p-1: real sparkline path → polyline svg renders with `points`.
    const p1Row = screen.getByTestId("lab-intel-deviation-p-1");
    expect(p1Row.querySelector("svg polyline")).toBeTruthy();

    // Row p-2: single value → no polyline, the literal number "12.5" prints.
    const p2Row = screen.getByTestId("lab-intel-deviation-p-2");
    expect(p2Row.querySelector("svg polyline")).toBeFalsy();
    expect(p2Row.textContent).toContain("12.5");

    // Row p-3: empty values → dash fallback.
    const p3Row = screen.getByTestId("lab-intel-deviation-p-3");
    expect(p3Row.querySelector("svg polyline")).toBeFalsy();
    expect(p3Row.textContent).toContain("—");

    // Direction pills: p-1/p-3 are "up" (red class), p-2 is "down" (blue class).
    expect(p1Row.innerHTML).toMatch(/text-red-700|bg-red-50|dark:bg-red-900/);
    expect(p2Row.innerHTML).toMatch(/text-blue-700|bg-blue-50|dark:bg-blue-900/);

    // Deviation pct printed to 1 dp on each row.
    expect(p1Row.textContent).toContain("35.4%");
    expect(p2Row.textContent).toContain("8.2%");
  });

  it("renders both empty-state hooks when criticals=[] AND deviations=[]", async () => {
    wireGet({ criticals: [], deviations: [] });

    render(<LabIntelPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    expect(await screen.findByTestId("lab-intel-empty")).toBeInTheDocument();
    expect(
      screen.getByTestId("lab-intel-deviations-empty"),
    ).toBeInTheDocument();
    // Singular copy when criticals.length === 0 → "0 results" (length===1 is
    // the other branch; this hits the !== 1 plural branch).
    expect(screen.getByText("0 results")).toBeInTheDocument();
  });

  it("does NOT render the global error banner when one endpoint rejects — each fetch is .catch'd to null and the page degrades gracefully", async () => {
    wireGet({ aggregatesReject: true });

    render(<LabIntelPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    // The component swallows individual rejections via per-call .catch(() => null).
    // So no `lab-intel-error` banner — instead, aggregates falls back to `?? 0`,
    // and the criticals + deviations sections still render their respective data.
    expect(screen.queryByTestId("lab-intel-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("lab-intel-kpi-criticals")).toHaveTextContent("0");
    // Criticals + deviations still loaded → "Aanya Sharma" appears in BOTH
    // sections, so we assert at least one occurrence.
    await waitFor(() => {
      expect(screen.getAllByText("Aanya Sharma").length).toBeGreaterThan(0);
    });
  });

  it("renders for ADMIN role identically to DOCTOR (full action access, no readonly banner)", async () => {
    authMock.mockReturnValue({
      token: "tok-admin",
      user: { id: "u-admin", role: "ADMIN" },
      isLoading: false,
    });
    wireGet({});

    render(<LabIntelPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));
    expect(
      screen.queryByTestId("lab-intel-readonly-banner"),
    ).not.toBeInTheDocument();
    // ADMIN sees View Order link (responsive desktop+mobile twins → ≥1).
    const viewOrders = await screen.findAllByRole("link", {
      name: /View Order/i,
    });
    expect(viewOrders.length).toBeGreaterThan(0);
  });
});
