// Coverage tests for the AI KPIs (ML-ops) dashboard page.
// Modules under test: apps/web/src/app/dashboard/ai-kpis/page.tsx —
//   admin-only page that GETs /ai/kpis/feature1 and /ai/kpis/feature2 in
//   parallel on mount (with from/to date params + token), renders three
//   tabs (booking / scribe / export), shows per-KPI cards with on-target /
//   off-target / unavailable / no-samples states, formats values by unit
//   (pct / count / seconds / minutes / rating), and exports a CSV via
//   fetch() in the export tab. Non-ADMIN visits short-circuit to the
//   admin-gate placeholder (Archetype C per docs/E2E_COVERAGE_BACKLOG.md).
// Why: page was at 0% coverage. These assertions lock in the wire contract
//   (endpoints, query params, token threading), the role-gate placeholder,
//   the KpiCard formatter switch + meeting-target/unavailable/no-samples
//   branches, the tab-swap behavior, the refresh button, the date input
//   wiring, and the CSV export happy + error paths so refactors of the
//   KPI surface can't silently regress it.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

const { apiMock, authMock, toastSuccessMock, toastErrorMock } = vi.hoisted(
  () => ({
    apiMock: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    authMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    toastErrorMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (k: string, fallback?: string) => fallback ?? k,
    lang: "en",
    setLang: vi.fn(),
  }),
}));
vi.mock("@/lib/toast", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai-kpis",
}));

import AIKpisPage from "../page";

// ─── Fixtures ────────────────────────────────────────────

function kpi(overrides: Partial<any> = {}): any {
  return {
    current: 0.8,
    target: 0.7,
    target_direction: "up",
    unit: "pct",
    ...overrides,
  };
}

function feature1Bundle(overrides: Partial<any> = {}): any {
  return {
    misroutedOpdAppointments: kpi({
      current: 0.05,
      target: 0.1,
      target_direction: "down",
      unit: "pct",
      baseline: 0.15,
      sampleSize: 1234,
    }),
    bookingCompletionRate: kpi({
      current: 0.88,
      target: 0.8,
      target_direction: "up",
      unit: "pct",
    }),
    patientCsatAiFlow: kpi({
      current: 4.45,
      target: 4.0,
      target_direction: "up",
      unit: "rating",
    }),
    top1AcceptanceRate: kpi({
      current: 0.65,
      target: 0.7,
      target_direction: "up",
      unit: "pct",
    }),
    timeToConfirmedAppointment: kpi({
      current: 95, // 1m 35s
      target: 120,
      target_direction: "down",
      unit: "seconds",
    }),
    redFlagFalseNegativeRate: kpi({
      unavailable: true,
      reason: "Awaiting validation cohort",
      current: 0,
      target: 0.05,
      target_direction: "down",
    }),
    frontDeskCallVolume: kpi({
      current: 0,
      target: 100,
      target_direction: "down",
      unit: "count",
      sampleSize: 0,
    }),
    ...overrides,
  };
}

function feature2Bundle(overrides: Partial<any> = {}): any {
  return {
    doctorDocTimeReduction: kpi({
      current: 12.5,
      target: 10,
      target_direction: "up",
      unit: "minutes",
    }),
    doctorAdoption: kpi({
      current: 0.55,
      target: 0.5,
      target_direction: "up",
      unit: "pct",
    }),
    soapAcceptanceRate: kpi({
      current: 0.9,
      target: 0.85,
      target_direction: "up",
      unit: "pct",
    }),
    drugAlertInducedChanges: kpi({
      current: 42,
      target: 30,
      target_direction: "up",
      unit: "count",
    }),
    medicationErrorRateComparison: kpi({
      current: 0.02,
      target: 0.03,
      target_direction: "down",
      unit: "pct",
    }),
    doctorNpsForScribe: kpi({
      current: 45,
      target: 40,
      target_direction: "up",
      unit: "count",
    }),
    timeToSignOff: kpi({
      current: 35,
      target: 60,
      target_direction: "down",
      unit: "seconds",
    }),
    ...overrides,
  };
}

describe("AI KPIs dashboard page", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    authMock.mockReturnValue({
      token: "tok-admin",
      user: { id: "u-admin", role: "ADMIN" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the admin-gate placeholder for non-ADMIN users and skips the KPI fetch", async () => {
    authMock.mockReturnValue({
      token: "tok-doc",
      user: { id: "u-doc", role: "DOCTOR" },
    });

    render(<AIKpisPage />);

    expect(
      screen.getByTestId("ai-kpis-admin-gate"),
    ).toBeInTheDocument();
    expect(screen.getByText(/aiKpis\.adminOnly/i)).toBeInTheDocument();
    // The KPI title / fetch wiring should not have rendered.
    expect(screen.queryByTestId("ai-kpis-title")).not.toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("issues parallel GETs to /ai/kpis/feature1 + /ai/kpis/feature2 with from/to + token on mount for ADMIN", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: { bundle: feature1Bundle() } })
      .mockResolvedValueOnce({ data: { bundle: feature2Bundle() } });

    render(<AIKpisPage />);

    // Header chrome.
    expect(screen.getByTestId("ai-kpis-title")).toBeInTheDocument();

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));

    const f1Call = apiMock.get.mock.calls.find(([url]) =>
      String(url).startsWith("/ai/kpis/feature1"),
    );
    const f2Call = apiMock.get.mock.calls.find(([url]) =>
      String(url).startsWith("/ai/kpis/feature2"),
    );

    expect(f1Call).toBeTruthy();
    expect(f2Call).toBeTruthy();
    // Date query params are wired in.
    expect(String(f1Call![0])).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    expect(String(f2Call![0])).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    // Token threaded through opts.
    expect(f1Call![1]).toEqual(
      expect.objectContaining({ token: "tok-admin" }),
    );
    expect(f2Call![1]).toEqual(
      expect.objectContaining({ token: "tok-admin" }),
    );
  });

  it("renders Feature 1 KPI cards with on-target / off-target / unavailable / no-samples states + formatted values", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: { bundle: feature1Bundle() } })
      .mockResolvedValueOnce({ data: { bundle: feature2Bundle() } });

    render(<AIKpisPage />);

    // Default tab is "booking" → feature1 panel.
    await waitFor(() =>
      expect(screen.getByTestId("ai-kpis-feature1-panel")).toBeInTheDocument(),
    );

    // On-target (down-target met): misrouted 5% ≤ 10%.
    const misrouted = screen.getByTestId("kpi-misrouted");
    expect(misrouted).toHaveAttribute("data-state", "on-target");
    // pct formatter → 5.0%
    expect(screen.getByTestId("kpi-misrouted-current")).toHaveTextContent("5.0%");
    // baseline rendered
    expect(screen.getByTestId("kpi-misrouted-baseline")).toHaveTextContent("15.0%");
    // sampleSize rendered
    expect(screen.getByTestId("kpi-misrouted-sample")).toHaveTextContent("n = 1,234");
    // target line shows "≤ 10.0%" since direction=down
    expect(screen.getByTestId("kpi-misrouted-target")).toHaveTextContent("≤ 10.0%");

    // Off-target (up-target unmet): top1 65% < 70%.
    expect(screen.getByTestId("kpi-top1-acceptance")).toHaveAttribute(
      "data-state",
      "off-target",
    );
    expect(screen.getByTestId("kpi-top1-acceptance-target")).toHaveTextContent("≥ 70.0%");

    // Seconds formatter: 95s → "1m 35s".
    expect(screen.getByTestId("kpi-time-to-confirm-current")).toHaveTextContent("1m 35s");

    // Rating formatter: 4.45 → "4.45".
    expect(screen.getByTestId("kpi-csat-current")).toHaveTextContent("4.45");

    // Unavailable card (red-flag false-negative): rendered as unavailable
    // with the reason and "—" placeholder, NOT the current/target numbers.
    const redFlag = screen.getByTestId("kpi-red-flag-fn");
    expect(redFlag).toHaveAttribute("data-state", "unavailable");
    expect(redFlag).toHaveTextContent(/Awaiting validation cohort/);
    expect(redFlag).toHaveTextContent("—");
    expect(
      screen.queryByTestId("kpi-red-flag-fn-current"),
    ).not.toBeInTheDocument();

    // No-samples card (frontDesk sampleSize=0): also renders as unavailable
    // with the noSamples fallback copy.
    const frontDesk = screen.getByTestId("kpi-front-desk");
    expect(frontDesk).toHaveAttribute("data-state", "unavailable");
    expect(frontDesk).toHaveTextContent(/No data yet/i);
  });

  it("switches to the Feature 2 panel when the scribe tab is clicked, with minutes/seconds/count formatting", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: { bundle: feature1Bundle() } })
      .mockResolvedValueOnce({ data: { bundle: feature2Bundle() } });

    render(<AIKpisPage />);

    await waitFor(() =>
      expect(screen.getByTestId("ai-kpis-feature1-panel")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("ai-kpis-tab-scribe"));

    expect(
      await screen.findByTestId("ai-kpis-feature2-panel"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("ai-kpis-feature1-panel"),
    ).not.toBeInTheDocument();

    // Minutes formatter: 12.5 → "12.5m".
    expect(screen.getByTestId("kpi-doc-time-current")).toHaveTextContent("12.5m");
    // Count formatter: 42 → "42".
    expect(screen.getByTestId("kpi-rx-changes-current")).toHaveTextContent("42");
    // Seconds <60: 35 → "35s".
    expect(screen.getByTestId("kpi-time-to-signoff-current")).toHaveTextContent("35s");

    // aria-selected wires through.
    expect(screen.getByTestId("ai-kpis-tab-scribe")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("ai-kpis-tab-booking")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("updates from/to date inputs and re-fetches with the new range when refresh is clicked", async () => {
    apiMock.get.mockResolvedValue({ data: { bundle: feature1Bundle() } });

    render(<AIKpisPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));
    apiMock.get.mockClear();

    fireEvent.change(screen.getByTestId("ai-kpis-from"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(screen.getByTestId("ai-kpis-to"), {
      target: { value: "2026-02-01" },
    });

    // The useEffect re-fires on from/to (via fetchBundles memo dep), so we
    // may have intermediate calls; clear + click refresh and assert the
    // LATEST call carries the new range.
    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("ai-kpis-refresh"));

    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    const calls = apiMock.get.mock.calls.map(([u]) => String(u));
    expect(
      calls.some(
        (u) =>
          u.includes("from=2026-01-01") && u.includes("to=2026-02-01"),
      ),
    ).toBe(true);
  });

  it("renders the error banner when one of the bundle fetches rejects", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: { bundle: feature1Bundle() } })
      .mockRejectedValueOnce(new Error("503 backend down"));

    render(<AIKpisPage />);

    expect(
      await screen.findByTestId("ai-kpis-error"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("ai-kpis-error"),
    ).toHaveTextContent(/503 backend down/);
  });

  it("falls back to the generic 'Failed to load KPIs' copy when the rejection has no message", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: { bundle: feature1Bundle() } })
      .mockRejectedValueOnce({});

    render(<AIKpisPage />);

    expect(
      await screen.findByTestId("ai-kpis-error"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("ai-kpis-error"),
    ).toHaveTextContent(/Failed to load KPIs/i);
  });

  it("does not fetch when the auth token is null (unauth visit) and renders nothing in the panels", async () => {
    authMock.mockReturnValue({
      token: null,
      user: { id: "u-admin", role: "ADMIN" },
    });

    render(<AIKpisPage />);

    // useEffect tries to fire because role=ADMIN, but fetchBundles short-
    // circuits on !token. So 0 GETs, no loading + no error.
    await waitFor(() => {
      expect(apiMock.get).not.toHaveBeenCalled();
    });
    expect(screen.queryByTestId("ai-kpis-feature1-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-kpis-error")).not.toBeInTheDocument();
  });

  it("downloads the CSV export via fetch() on the export tab when the export button is clicked", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: { bundle: feature1Bundle() } })
      .mockResolvedValueOnce({ data: { bundle: feature2Bundle() } });

    // Stub global fetch for the CSV blob path.
    const fetchMock = vi.fn(async () =>
      new Response("a,b,c\n1,2,3\n", {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      }),
    );
    (globalThis as any).__fetchMockLocked = true;
    vi.stubGlobal("fetch", fetchMock);

    // URL.createObjectURL / revokeObjectURL aren't on jsdom by default.
    const createUrlMock = vi.fn(() => "blob:fake");
    const revokeUrlMock = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createUrlMock,
      revokeObjectURL: revokeUrlMock,
    });

    try {
      render(<AIKpisPage />);

      await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getByTestId("ai-kpis-tab-export"));
      expect(
        await screen.findByTestId("ai-kpis-export-panel"),
      ).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByTestId("ai-kpis-export-btn"));
      });

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toMatch(/\/ai\/kpis\/export\?from=.+&to=.+/);
      expect((opts.headers as Record<string, string>).Authorization).toBe(
        "Bearer tok-admin",
      );

      expect(createUrlMock).toHaveBeenCalled();
      expect(revokeUrlMock).toHaveBeenCalled();
      await waitFor(() =>
        expect(toastSuccessMock).toHaveBeenCalledWith("CSV downloaded"),
      );
    } finally {
      delete (globalThis as any).__fetchMockLocked;
    }
  });

  it("toasts an error when the CSV export fetch returns a non-OK status", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: { bundle: feature1Bundle() } })
      .mockResolvedValueOnce({ data: { bundle: feature2Bundle() } });

    const fetchMock = vi.fn(async () =>
      new Response("forbidden", { status: 403 }),
    );
    (globalThis as any).__fetchMockLocked = true;
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<AIKpisPage />);
      await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getByTestId("ai-kpis-tab-export"));
      await act(async () => {
        fireEvent.click(
          await screen.findByTestId("ai-kpis-export-btn"),
        );
      });

      await waitFor(() =>
        expect(toastErrorMock).toHaveBeenCalledWith("HTTP 403"),
      );
    } finally {
      delete (globalThis as any).__fetchMockLocked;
    }
  });

  it("no-ops the export action when no auth token is present", async () => {
    authMock.mockReturnValue({
      token: null,
      user: { id: "u-admin", role: "ADMIN" },
    });

    const fetchMock = vi.fn();
    (globalThis as any).__fetchMockLocked = true;
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<AIKpisPage />);

      fireEvent.click(screen.getByTestId("ai-kpis-tab-export"));
      fireEvent.click(
        await screen.findByTestId("ai-kpis-export-btn"),
      );

      // The early `if (!token) return;` guard prevents fetch from firing.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(toastErrorMock).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as any).__fetchMockLocked;
    }
  });
});
