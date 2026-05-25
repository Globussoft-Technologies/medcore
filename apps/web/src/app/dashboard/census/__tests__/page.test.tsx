/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * CensusPage — adjacent-to-source coverage (test-cron pick 2026-05-25).
 *
 * What / which modules / why:
 *   - Verifies the branches of `apps/web/src/app/dashboard/census/page.tsx`,
 *     a client component that renders the IPD bed-census report by fetching
 *     either `GET /api/v1/admissions/census/daily?date=…` (Daily mode) or
 *     `GET /api/v1/admissions/census/range?from=…&to=…` (Weekly/Monthly mode).
 *     The page maintains a tri-state mode toggle (day | week | month), a date
 *     picker shown only in Daily mode, three summary tiles (new admissions,
 *     discharges, deaths, average occupancy), an optional bar-chart trend
 *     section (only when `data.length > 1`) with an empty-state for
 *     all-zero windows (issue #332), and a tabular per-day breakdown.
 *   - Behaviours covered:
 *       1. Loading branch — the skeleton table renders while the fetch is
 *          in flight (data-testid="census-loading", aria-busy="true").
 *       2. Default mount fetches the Weekly range endpoint and renders the
 *          per-day table rows + chart (>1 row), aggregated totals on tiles.
 *       3. Switching to Daily mode shows the date input, fires the daily
 *          endpoint, and renders a single row (no chart since data.length<=1).
 *       4. Daily mode date input change re-issues the fetch with the new date.
 *       5. Switching to Monthly mode fires a 30-day range request.
 *       6. Empty fetch — Daily mode where `res.data` is null/undefined keeps
 *          the table body empty and tiles at zero.
 *       7. Error path — when api.get rejects, data is cleared, tiles stay at
 *          zero, and the table is empty (no crash).
 *       8. Chart empty-state (issue #332) — when every row's occupancyPercent
 *          is 0, the "No occupancy recorded" copy renders instead of bars.
 *       9. Occupancy badge color tiers — green (<75), amber (75-89), red (90+).
 *
 *   - Source under test: apps/web/src/app/dashboard/census/page.tsx
 *   - Mocks: @/lib/api (api.get), @/components/Skeleton (passthrough SkeletonTable).
 *   - No auth/router mocks needed — the page is ungated client-side (RBAC
 *     lives entirely on the API side per the project-wide A1 follow-up).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows?: number; columns?: number }) => (
    <div
      data-testid="skeleton-table"
      data-rows={rows ?? 0}
      data-columns={columns ?? 0}
    />
  ),
}));

import CensusPage from "../page";

interface CensusDay {
  date: string;
  totalBeds: number;
  admittedAtStartOfDay: number;
  newAdmissions: number;
  discharges: number;
  deaths: number;
  admittedAtEndOfDay: number;
  occupancyPercent: number;
}

function censusDay(overrides: Partial<CensusDay> = {}): CensusDay {
  return {
    date: "2026-05-20",
    totalBeds: 100,
    admittedAtStartOfDay: 50,
    newAdmissions: 10,
    discharges: 5,
    deaths: 1,
    admittedAtEndOfDay: 54,
    occupancyPercent: 54,
    ...overrides,
  };
}

describe("CensusPage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the skeleton-table loading state while the initial range fetch is in flight", async () => {
    // Never-settling promise keeps the page in the loading branch.
    apiMock.get.mockImplementation(() => new Promise(() => {}));

    render(<CensusPage />);

    const loading = await screen.findByTestId("census-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("skeleton-table")).toBeInTheDocument();
    // Header + mode buttons still render around the loading block.
    expect(
      screen.getByRole("heading", { name: /census report/i })
    ).toBeInTheDocument();
  });

  it("defaults to Weekly mode and renders the per-day table, chart, and aggregated tiles", async () => {
    const rows = [
      censusDay({ date: "2026-05-18", newAdmissions: 4, discharges: 2, deaths: 0, occupancyPercent: 60 }),
      censusDay({ date: "2026-05-19", newAdmissions: 6, discharges: 3, deaths: 1, occupancyPercent: 70 }),
      censusDay({ date: "2026-05-20", newAdmissions: 10, discharges: 5, deaths: 1, occupancyPercent: 80 }),
    ];
    apiMock.get.mockResolvedValue({ data: rows });

    render(<CensusPage />);

    // Wait for the loading skeleton to disappear and the table to render.
    await waitFor(() =>
      expect(screen.queryByTestId("census-loading")).not.toBeInTheDocument()
    );

    // The default-mode fetch goes to the range endpoint with a 7-day window.
    const rangeCall = apiMock.get.mock.calls.find((c: any[]) =>
      String(c[0]).startsWith("/admissions/census/range")
    );
    expect(rangeCall?.[0]).toMatch(
      /^\/admissions\/census\/range\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/
    );

    // Totals: new=20, discharge=10, deaths=2; avgOccupancy=70.
    // Scope tile asserts to the summary-cards row (the 4 .p-4 tiles wrap a
    // grid above the chart) so we don't ambiguity-match against the table
    // body rows / table column headers, which repeat the same digits and
    // labels (e.g. "Deaths" appears as both a tile label and a column head).
    const cards = document.querySelectorAll(".grid > .p-4");
    expect(cards).toHaveLength(4);
    // Tile order in source: New Admissions, Discharges, Deaths, Avg. Occupancy.
    expect(cards[0].textContent).toMatch(/New Admissions/);
    expect(cards[0].textContent).toMatch(/20/);
    expect(cards[1].textContent).toMatch(/Discharges/);
    expect(cards[1].textContent).toMatch(/10/);
    expect(cards[2].textContent).toMatch(/Deaths/);
    expect(cards[2].textContent?.trim().endsWith("2")).toBe(true);
    expect(cards[3].textContent).toMatch(/Avg\. Occupancy/);
    expect(cards[3].textContent).toMatch(/70%/);

    // Chart renders (data.length>1) — header copy visible.
    expect(screen.getByText(/occupancy trend/i)).toBeInTheDocument();

    // Three table data rows present (one per row in the response).
    const table = screen.getByRole("table");
    const bodyRows = within(table).getAllByRole("row");
    // 1 header row + 3 data rows = 4.
    expect(bodyRows).toHaveLength(4);
    expect(within(table).getByText("2026-05-18")).toBeInTheDocument();
    expect(within(table).getByText("2026-05-19")).toBeInTheDocument();
    expect(within(table).getByText("2026-05-20")).toBeInTheDocument();
  });

  it("switching to Daily mode reveals the date input and fires the daily endpoint", async () => {
    // First fetch (default weekly) → empty; second (after Daily click) → 1 row.
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/admissions/census/daily")) {
        return Promise.resolve({
          data: censusDay({ date: "2026-05-21", occupancyPercent: 88 }),
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<CensusPage />);

    // Wait for initial weekly load to settle.
    await waitFor(() =>
      expect(screen.queryByTestId("census-loading")).not.toBeInTheDocument()
    );

    // Click the Daily toggle.
    fireEvent.click(screen.getByRole("button", { name: /^daily$/i }));

    // The daily endpoint is hit with the singleDate ISO param.
    await waitFor(() => {
      const dailyCall = apiMock.get.mock.calls.find((c: any[]) =>
        String(c[0]).startsWith("/admissions/census/daily")
      );
      expect(dailyCall?.[0]).toMatch(
        /^\/admissions\/census\/daily\?date=\d{4}-\d{2}-\d{2}$/
      );
    });

    // The date input is visible.
    expect(
      document.querySelector('input[type="date"]')
    ).toBeInTheDocument();

    // Single data row → no chart (chart only renders when data.length > 1).
    await waitFor(() =>
      expect(screen.queryByText(/occupancy trend/i)).not.toBeInTheDocument()
    );

    // Table has the single row + occupancy badge in the amber tier (75-89).
    const table = screen.getByRole("table");
    expect(within(table).getByText("2026-05-21")).toBeInTheDocument();
    const badge = within(table).getByText("88%");
    expect(badge.className).toMatch(/amber/);
  });

  it("changing the date in Daily mode re-issues the daily fetch with the new date", async () => {
    apiMock.get.mockResolvedValue({ data: censusDay() });

    render(<CensusPage />);

    // Switch into Daily mode first.
    fireEvent.click(screen.getByRole("button", { name: /^daily$/i }));

    await waitFor(() => {
      expect(
        apiMock.get.mock.calls.some((c: any[]) =>
          String(c[0]).startsWith("/admissions/census/daily")
        )
      ).toBe(true);
    });

    const dateInput = document.querySelector(
      'input[type="date"]'
    ) as HTMLInputElement;
    expect(dateInput).not.toBeNull();

    fireEvent.change(dateInput, { target: { value: "2025-01-15" } });

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(
        "/admissions/census/daily?date=2025-01-15"
      );
    });
  });

  it("switching to Monthly mode fires a 30-day range request", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<CensusPage />);

    // Wait for the initial weekly fetch to settle.
    await waitFor(() =>
      expect(screen.queryByTestId("census-loading")).not.toBeInTheDocument()
    );

    apiMock.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^monthly$/i }));

    await waitFor(() => {
      const rangeCall = apiMock.get.mock.calls.find((c: any[]) =>
        String(c[0]).startsWith("/admissions/census/range")
      );
      expect(rangeCall).toBeTruthy();

      // Verify the from/to span is 30 days (inclusive).
      const url = String(rangeCall![0]);
      const match = url.match(/from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/);
      expect(match).toBeTruthy();
      const from = new Date(match![1] + "T00:00:00Z");
      const to = new Date(match![2] + "T00:00:00Z");
      const daysSpan = Math.round(
        (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)
      );
      expect(daysSpan).toBe(29); // 30 days inclusive = 29 day delta
    });
  });

  it("renders the table empty and tiles at zero when Daily endpoint returns null data", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/admissions/census/daily")) {
        // Source: `res.data ? [res.data] : []` — null collapses to [].
        return Promise.resolve({ data: null });
      }
      return Promise.resolve({ data: [] });
    });

    render(<CensusPage />);
    fireEvent.click(screen.getByRole("button", { name: /^daily$/i }));

    await waitFor(() =>
      expect(screen.queryByTestId("census-loading")).not.toBeInTheDocument()
    );

    // No data rows in the table.
    const table = screen.getByRole("table");
    const allRows = within(table).getAllByRole("row");
    expect(allRows).toHaveLength(1); // header row only

    // No chart (data.length === 0).
    expect(screen.queryByText(/occupancy trend/i)).not.toBeInTheDocument();
  });

  it("swallows fetch rejections — clears data, keeps tiles at zero and the table empty", async () => {
    apiMock.get.mockRejectedValue(new Error("network down"));

    render(<CensusPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("census-loading")).not.toBeInTheDocument()
    );

    // Tiles render the zero state.
    expect(screen.getByText("0%")).toBeInTheDocument();

    // Table body has no data rows.
    const table = screen.getByRole("table");
    const allRows = within(table).getAllByRole("row");
    expect(allRows).toHaveLength(1);

    // No chart rendered (data.length === 0).
    expect(screen.queryByText(/occupancy trend/i)).not.toBeInTheDocument();
  });

  it("renders the all-zero empty-state copy in the chart when every row has 0% occupancy (issue #332)", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        censusDay({ date: "2026-05-18", occupancyPercent: 0, newAdmissions: 0, discharges: 0, deaths: 0 }),
        censusDay({ date: "2026-05-19", occupancyPercent: 0, newAdmissions: 0, discharges: 0, deaths: 0 }),
      ],
    });

    render(<CensusPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("census-loading")).not.toBeInTheDocument()
    );

    // Chart section header is rendered (data.length > 1) ...
    expect(screen.getByText(/occupancy trend/i)).toBeInTheDocument();
    // ... but the empty-state copy replaces the bars.
    expect(
      screen.getByText(/no occupancy recorded for the selected window\./i)
    ).toBeInTheDocument();
  });

  it("applies the red occupancy-badge tier for >=90% rows and green for <75% rows", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        censusDay({ date: "2026-05-18", occupancyPercent: 95 }), // red tier
        censusDay({ date: "2026-05-19", occupancyPercent: 50 }), // green tier
      ],
    });

    render(<CensusPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("census-loading")).not.toBeInTheDocument()
    );

    const table = screen.getByRole("table");
    const red = within(table).getByText("95%");
    const green = within(table).getByText("50%");

    expect(red.className).toMatch(/red/);
    expect(green.className).toMatch(/green/);
  });
});
