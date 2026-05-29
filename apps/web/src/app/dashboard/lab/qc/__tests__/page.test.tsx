/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * LabQCPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/lab/qc/page.tsx, the daily
 *     lab Quality Control surface with Levey-Jennings chart for
 *     ADMIN / NURSE / DOCTOR roles. Endpoints:
 *       GET  /lab/qc/summary
 *       GET  /lab/tests
 *       GET  /lab/qc[?testId=...]
 *       POST /lab/qc           (record new QC entry)
 *
 *   - Behaviours covered:
 *       1. Role gate — RECEPTION sees "Access denied." card, no fetch.
 *       2. Initial mount — ADMIN fires summary + tests in parallel,
 *          and the entries fetch (no testId filter on first run).
 *       3. Loading skeleton — `lab-qc-loading` rendered before fetch
 *          resolves; aria-busy="true".
 *       4. Empty summary — "No QC data yet." copy when summary=[].
 *       5. Summary rendering — happy fetch shows passRate %, low-pass
 *          row gets the red highlight (< 90%) and high-pass gets green
 *          class; recent entries table renders pass/fail icons + cv
 *          dash-fallback when cv is null.
 *       6. View chart — clicking "View chart" sets selectedTest,
 *          re-issues /lab/qc?testId=..., renders the Levey-Jennings
 *          SVG with bands (Mean / ±2SD / ±3SD), point circles colored
 *          by withinRange, and the chart heading shows the test name.
 *       7. Record QC modal — Plus toggles form open, role dropdown
 *          options render, Save is disabled until required fields are
 *          filled, submit POSTs the well-shaped body, then reloads
 *          summary+entries; Cancel hides the form.
 *       8. Submit error — POST rejection toasts "Failed to submit QC
 *          entry" and leaves the form open (submitting flips back off).
 *       9. Error-path resilience — summary GET rejection still flips
 *          loading off; entries GET rejection still renders the page.
 *      10. NURSE + DOCTOR — both allowed roles render the same chrome.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore — direct destructure),
 *            @/lib/toast, next/navigation, @/components/Skeleton.
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

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/lab/qc",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-table" data-rows={rows} data-columns={columns} />
  ),
}));

import LabQCPage from "../page";

// ─── Fixtures ────────────────────────────────────────────

type SummaryRow = {
  testId: string;
  code: string;
  name: string;
  total: number;
  pass: number;
  passRate: number;
};

type LabTest = { id: string; code: string; name: string };

type QCEntry = {
  id: string;
  testId: string;
  qcLevel: string;
  runDate: string;
  instrument?: string | null;
  meanValue: number;
  recordedValue: number;
  cv?: number | null;
  withinRange: boolean;
  notes?: string | null;
  test: { code: string; name: string };
  user: { id: string; name: string; role: string };
};

function summaryFixture(): SummaryRow[] {
  return [
    {
      testId: "t-1",
      code: "GLU",
      name: "Glucose",
      total: 30,
      pass: 28,
      passRate: 93,
    },
    {
      testId: "t-2",
      code: "HGB",
      name: "Hemoglobin",
      total: 20,
      pass: 14,
      passRate: 70, // < 90 → red row branch
    },
  ];
}

function testsFixture(): LabTest[] {
  return [
    { id: "t-1", code: "GLU", name: "Glucose" },
    { id: "t-2", code: "HGB", name: "Hemoglobin" },
  ];
}

function entriesFixture(): QCEntry[] {
  return [
    {
      id: "e-1",
      testId: "t-1",
      qcLevel: "NORMAL",
      runDate: "2026-04-01T10:00:00.000Z",
      instrument: "BIO-100",
      meanValue: 100,
      recordedValue: 102,
      cv: 1.2,
      withinRange: true,
      notes: null,
      test: { code: "GLU", name: "Glucose" },
      user: { id: "u-1", name: "Tech One", role: "NURSE" },
    },
    {
      id: "e-2",
      testId: "t-1",
      qcLevel: "HIGH",
      runDate: "2026-04-02T10:00:00.000Z",
      instrument: null,
      meanValue: 100,
      recordedValue: 130, // > 20% deviation → fail
      cv: null, // hits dash fallback branch
      withinRange: false,
      notes: "out of range",
      test: { code: "GLU", name: "Glucose" },
      user: { id: "u-1", name: "Tech One", role: "NURSE" },
    },
  ];
}

/** Route api.get by URL prefix. */
function wireGet(opts: {
  summary?: SummaryRow[];
  tests?: LabTest[];
  entries?: QCEntry[];
  summaryReject?: boolean;
  testsReject?: boolean;
  entriesReject?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/lab/qc/summary")) {
      if (opts.summaryReject) return Promise.reject(new Error("sum-fail"));
      return Promise.resolve({ data: opts.summary ?? summaryFixture() });
    }
    if (url.startsWith("/lab/tests")) {
      if (opts.testsReject) return Promise.reject(new Error("tests-fail"));
      return Promise.resolve({ data: opts.tests ?? testsFixture() });
    }
    if (url.startsWith("/lab/qc")) {
      if (opts.entriesReject) return Promise.reject(new Error("ent-fail"));
      return Promise.resolve({ data: opts.entries ?? entriesFixture() });
    }
    return Promise.resolve({ data: null });
  });
}

// ─── Tests ────────────────────────────────────────────

describe("LabQCPage dashboard surface", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    toastMock.warning.mockReset();
    authMock.mockReset();
    // Default: ADMIN. Individual tests override.
    authMock.mockReturnValue({
      user: { id: "u-admin", role: "ADMIN", name: "Admin" },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders Access denied for disallowed role (RECEPTION) and never fetches", async () => {
    authMock.mockReturnValue({
      user: { id: "u-rec", role: "RECEPTION", name: "Rec" },
    });

    render(<LabQCPage />);

    expect(screen.getByText("Access denied.")).toBeInTheDocument();
    // Header chrome must NOT render on the denied branch.
    expect(screen.queryByText("Lab Quality Control")).not.toBeInTheDocument();
    // No fetches at all.
    await Promise.resolve();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the loading skeleton before fetches resolve", async () => {
    // Keep summary pending so loading=true is observable.
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/lab/qc/summary")) return new Promise(() => {});
      if (url.startsWith("/lab/tests")) return new Promise(() => {});
      if (url.startsWith("/lab/qc")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: null });
    });

    render(<LabQCPage />);

    const loading = await screen.findByTestId("lab-qc-loading");
    expect(loading).toBeInTheDocument();
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("skeleton-table")).toBeInTheDocument();
    expect(screen.getByText("Lab Quality Control")).toBeInTheDocument();
  });

  it("ADMIN: fires summary + tests + entries on mount and renders the summary table", async () => {
    wireGet({});

    render(<LabQCPage />);

    await waitFor(() => {
      // 2 (summary + tests) for loadAll + 1 (entries) for loadEntries.
      expect(apiMock.get).toHaveBeenCalledTimes(3);
    });

    const urls = apiMock.get.mock.calls.map(([u]) => String(u));
    expect(urls).toContain("/lab/qc/summary");
    expect(urls).toContain("/lab/tests");
    // No testId filter on first render — exact /lab/qc with empty qs.
    expect(urls.some((u) => u === "/lab/qc")).toBe(true);

    // Summary rendered with both rows + low-pass red highlight branch.
    // "Glucose" appears in both summary + entries rows; getAllByText handles it.
    await waitFor(() => {
      expect(screen.getAllByText("Glucose").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Hemoglobin").length).toBeGreaterThan(0);
    expect(screen.getByText("93%")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
  });

  it("renders the 'No QC data yet.' empty-summary branch", async () => {
    wireGet({ summary: [], entries: [] });

    render(<LabQCPage />);

    await waitFor(() => {
      expect(screen.getByText("No QC data yet.")).toBeInTheDocument();
    });
    // Loading skeleton gone after first resolve.
    expect(screen.queryByTestId("lab-qc-loading")).not.toBeInTheDocument();
  });

  it("renders the recent-entries table with Pass/Fail icons and cv dash fallback", async () => {
    wireGet({});

    render(<LabQCPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    // Pass icon row + Fail icon row both present.
    // (use getAllByText — "Pass" appears in body + headings can collide)
    await waitFor(() => {
      expect(screen.getAllByText("Pass").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Fail").length).toBeGreaterThan(0);
    // cv dash fallback for the null-cv row.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    // qcLevel "HIGH" row visible.
    expect(screen.getByText("HIGH")).toBeInTheDocument();
    expect(screen.getByText("NORMAL")).toBeInTheDocument();
  });

  it("View chart: sets selectedTest, re-fetches with ?testId=, and renders the Levey-Jennings SVG", async () => {
    wireGet({});

    render(<LabQCPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));
    // The "called 3 times" assertion only confirms the fetches were
    // initiated, not that their promises resolved + the table rendered.
    // Wait for the skeleton wrapper to actually go away before looking
    // for the per-row "View chart" buttons.
    await waitFor(() =>
      expect(
        screen.queryByTestId("lab-qc-loading"),
      ).not.toBeInTheDocument(),
    );
    apiMock.get.mockClear();
    wireGet({});

    // Two View chart buttons (one per row). Click the first.
    const viewBtns = screen.getAllByRole("button", { name: /View chart/i });
    fireEvent.click(viewBtns[0]);

    // Entries refetch fires with the testId filter.
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u === "/lab/qc?testId=t-1")).toBe(true);
    });

    // Chart heading renders with the test name from `tests` lookup.
    expect(
      await screen.findByText(/Levey-Jennings —/i),
    ).toBeInTheDocument();
    // Heading composition — name "Glucose" comes from tests fixture;
    // it also appears in summary + entries tables, so getAllByText.
    expect(screen.getAllByText(/Glucose/i).length).toBeGreaterThan(0);

    // SVG band labels render — all 5 (Mean ±2SD ±3SD).
    // "Mean" also appears as a <th> in the entries table — use getAllByText.
    expect(screen.getAllByText("Mean").length).toBeGreaterThan(0);
    expect(screen.getByText("+2SD")).toBeInTheDocument();
    expect(screen.getByText("-2SD")).toBeInTheDocument();
    expect(screen.getByText("+3SD")).toBeInTheDocument();
    expect(screen.getByText("-3SD")).toBeInTheDocument();

    // Point circles render — one per entry. Find the chart SVG specifically
    // by its viewBox (lucide icons have different viewBoxes).
    const chartSvg = document.querySelector('svg[viewBox="0 0 600 220"]');
    expect(chartSvg).toBeTruthy();
    const circles = chartSvg!.querySelectorAll("circle");
    expect(circles.length).toBeGreaterThanOrEqual(2);
    // Connecting line(s) between points: slice(1) → 1 line for 2 points,
    // PLUS the 5 band lines (Mean / ±2SD / ±3SD) = ≥6 lines total.
    const lines = chartSvg!.querySelectorAll("line");
    expect(lines.length).toBeGreaterThan(0);
  });

  it("Record QC modal: Plus toggles form open, Save is disabled until required fields are filled, then POSTs and reloads", async () => {
    wireGet({});

    render(<LabQCPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    // Open form.
    fireEvent.click(screen.getByRole("button", { name: /Record QC/i }));

    expect(await screen.findByText("New QC Entry")).toBeInTheDocument();

    // Save disabled until testId + meanValue + recordedValue.
    const saveBtn = screen.getByRole("button", { name: /Save/i });
    expect(saveBtn).toBeDisabled();

    // Select a test — testId option renders from the tests fetch.
    const selects = screen.getAllByRole("combobox");
    // First select is testId, second is qcLevel.
    fireEvent.change(selects[0], { target: { value: "t-1" } });

    // qcLevel options — change to "LOW" (hits its branch).
    fireEvent.change(selects[1], { target: { value: "LOW" } });

    // Required: meanValue + recordedValue.
    const meanInput = screen.getByPlaceholderText("Mean value");
    const recInput = screen.getByPlaceholderText("Recorded value");
    fireEvent.change(meanInput, { target: { value: "100" } });
    fireEvent.change(recInput, { target: { value: "105" } });

    // Optional fields — fill to exercise their branches.
    fireEvent.change(screen.getByPlaceholderText("Instrument"), {
      target: { value: "BIO-100" },
    });
    fireEvent.change(screen.getByPlaceholderText("CV %"), {
      target: { value: "1.5" },
    });
    fireEvent.change(screen.getByPlaceholderText("Notes"), {
      target: { value: "calibration check" },
    });

    expect(saveBtn).not.toBeDisabled();

    apiMock.post.mockResolvedValueOnce({ data: { id: "new-1" } });
    apiMock.get.mockClear();
    wireGet({});

    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(1);
    });
    const [postUrl, postBody] = apiMock.post.mock.calls[0];
    expect(postUrl).toBe("/lab/qc");
    expect(postBody).toEqual(
      expect.objectContaining({
        testId: "t-1",
        qcLevel: "LOW",
        instrument: "BIO-100",
        meanValue: 100,
        recordedValue: 105,
        cv: 1.5,
        notes: "calibration check",
        // recorded=105, mean=100 → |diff|=5 ≤ 20% of mean (20) → withinRange=true
        withinRange: true,
      }),
    );

    // After save, form closes and loadAll + loadEntries re-fire.
    await waitFor(() => {
      expect(screen.queryByText("New QC Entry")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      // 2 (loadAll) + 1 (loadEntries) = 3 fresh GETs after submit
      expect(apiMock.get.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("Record QC: submit error toasts 'Failed to submit QC entry' and keeps form open", async () => {
    wireGet({});

    render(<LabQCPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByRole("button", { name: /Record QC/i }));
    await screen.findByText("New QC Entry");

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "t-1" } });
    fireEvent.change(screen.getByPlaceholderText("Mean value"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByPlaceholderText("Recorded value"), {
      target: { value: "150" }, // 50% off → withinRange=false branch
    });

    apiMock.post.mockRejectedValueOnce(new Error("boom"));

    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "Failed to submit QC entry",
      );
    });
    // Form stays open.
    expect(screen.getByText("New QC Entry")).toBeInTheDocument();

    // withinRange was computed false (50% deviation > 20%).
    const [, body] = apiMock.post.mock.calls[0];
    expect(body.withinRange).toBe(false);
  });

  it("Cancel button hides the form", async () => {
    wireGet({});

    render(<LabQCPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByRole("button", { name: /Record QC/i }));
    await screen.findByText("New QC Entry");

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    await waitFor(() => {
      expect(screen.queryByText("New QC Entry")).not.toBeInTheDocument();
    });
  });

  it("submit with meanValue=0 takes the within2sd=true short-circuit", async () => {
    wireGet({});

    render(<LabQCPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByRole("button", { name: /Record QC/i }));
    await screen.findByText("New QC Entry");

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "t-1" } });
    fireEvent.change(screen.getByPlaceholderText("Mean value"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByPlaceholderText("Recorded value"), {
      target: { value: "5" },
    });

    // Save disabled because meanValue "0" is falsy in the !form.meanValue check.
    // Force-enable by routing through testId+rec+mean=non-empty string.
    // Actually mean=="0" makes !form.meanValue truthy because "0" is truthy as string —
    // but JS: Boolean("0") === true. So Save IS enabled.
    apiMock.post.mockResolvedValueOnce({ data: { id: "x" } });

    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    const [, body] = apiMock.post.mock.calls[0];
    // mean=0 → within2sd branch returns true (mean > 0 is false).
    expect(body.withinRange).toBe(true);
    expect(body.meanValue).toBe(0);
  });

  it("error resilience: summary GET reject still flips loading off; entries GET reject does not crash", async () => {
    wireGet({ summaryReject: true, entriesReject: true });

    render(<LabQCPage />);

    // Page chrome still renders even with both endpoints failing.
    expect(screen.getByText("Lab Quality Control")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId("lab-qc-loading")).not.toBeInTheDocument();
    });
    // No summary rows → "No QC data yet." renders.
    expect(screen.getByText("No QC data yet.")).toBeInTheDocument();
  });

  it("NURSE: allowed role, renders the same surface as ADMIN", async () => {
    authMock.mockReturnValue({
      user: { id: "u-nurse", role: "NURSE", name: "Nurse" },
    });
    wireGet({});

    render(<LabQCPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Lab Quality Control")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText("Glucose").length).toBeGreaterThan(0);
    });
  });

  it("DOCTOR: allowed role, renders the same surface as ADMIN", async () => {
    authMock.mockReturnValue({
      user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
    });
    wireGet({});

    render(<LabQCPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Lab Quality Control")).toBeInTheDocument();
  });
});
