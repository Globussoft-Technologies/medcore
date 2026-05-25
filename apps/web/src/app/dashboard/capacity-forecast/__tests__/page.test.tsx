// Coverage tests for the Capacity Forecast dashboard page.
// Modules under test: apps/web/src/app/dashboard/capacity-forecast/page.tsx —
//   fetches /ai/capacity/{beds|icu|ot}?horizon={24|48|72} on mount + on tab
//   or horizon change, renders a spinner while loading, a summary card grid
//   + ward/OT heatmap (colour-coded by occupancy %), confidence chips,
//   stockout markers, an "MA" fallback badge for low-data rows, and an
//   error banner when the endpoint rejects or the API contract surfaces a
//   non-success envelope.
// Why: page was at 0% line coverage; locking in the rendered surface so
//   future refactors of the heatmap / summary / tab wiring can't silently
//   break it. Complements the existing smoke test at
//   apps/web/src/app/dashboard/__tests__/capacity-forecast.page.test.tsx
//   by covering the loading state, confidence ladder, tab/horizon refetch
//   wiring, ICU + OT endpoints, and the error-envelope path.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/capacity-forecast",
}));

import CapacityForecastPage from "../page";

// ─── Fixtures ───────────────────────────────────────────

function forecastRow(overrides: Partial<any> = {}) {
  return {
    resourceId: "w1",
    resourceName: "Ward A",
    resourceType: "ward",
    capacityUnits: 20,
    currentlyInUse: 12,
    plannedReleases: 2,
    predictedInflow: 5,
    predictedInflowUpper: 8,
    expectedOccupancyPct: 75,
    expectedStockout: false,
    confidence: "high",
    method: "holt-winters",
    insufficientData: false,
    ...overrides,
  };
}

function forecastEnvelope(
  forecasts: ReturnType<typeof forecastRow>[],
  summaryOverrides: Partial<any> = {},
  horizonHours: 24 | 48 | 72 = 72,
) {
  const totalCapacity = forecasts.reduce((s, f) => s + f.capacityUnits, 0);
  const totalCurrentlyInUse = forecasts.reduce((s, f) => s + f.currentlyInUse, 0);
  const totalPredictedInflow = forecasts.reduce((s, f) => s + f.predictedInflow, 0);
  const totalPredictedInflowUpper = forecasts.reduce(
    (s, f) => s + f.predictedInflowUpper,
    0,
  );
  const wardsAtRisk = forecasts.filter((f) => f.expectedStockout).length;
  const aggregateOccupancyPct = totalCapacity
    ? Math.round(((totalCurrentlyInUse + totalPredictedInflow) / totalCapacity) * 100)
    : 0;
  return {
    horizonHours,
    generatedAt: "2026-05-26T10:00:00Z",
    forecasts,
    summary: {
      totalCapacity,
      totalCurrentlyInUse,
      totalPredictedInflow,
      totalPredictedInflowUpper,
      aggregateOccupancyPct,
      anyStockoutRisk: wardsAtRisk > 0,
      wardsAtRisk,
      ...summaryOverrides,
    },
  };
}

describe("Capacity Forecast dashboard page", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
        token: "tok-1",
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders header chrome and shows the spinner while the initial fetch is pending", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<CapacityForecastPage />);

    // Header chrome renders independent of the fetch state.
    expect(
      screen.getByRole("heading", { name: /capacity forecast/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/holt-winters demand forecast/i),
    ).toBeInTheDocument();

    // Refresh button replaces its icon with a Loader2 spinner during loading;
    // page is in loading state for the duration of the pending GET.
    await waitFor(() =>
      expect(document.querySelector(".animate-spin")).toBeInTheDocument(),
    );

    // Both refresh button and the three tabs are always available in chrome.
    expect(
      screen.getByRole("button", { name: /refresh/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("capacity-tab-beds")).toBeInTheDocument();
    expect(screen.getByTestId("capacity-tab-icu")).toBeInTheDocument();
    expect(screen.getByTestId("capacity-tab-ot")).toBeInTheDocument();
  });

  it("issues the default GET /ai/capacity/beds?horizon=72 on mount and renders the summary cards + heatmap tiles", async () => {
    const data = forecastEnvelope([
      forecastRow({
        resourceId: "w1",
        resourceName: "Ward Alpha",
        capacityUnits: 20,
        currentlyInUse: 12,
        predictedInflow: 5,
        predictedInflowUpper: 8,
        expectedOccupancyPct: 85,
        confidence: "high",
      }),
      forecastRow({
        resourceId: "w2",
        resourceName: "Ward Bravo",
        capacityUnits: 10,
        currentlyInUse: 8,
        predictedInflow: 3,
        predictedInflowUpper: 5,
        expectedOccupancyPct: 110,
        expectedStockout: true,
        confidence: "medium",
      }),
    ]);
    apiMock.get.mockResolvedValue({ success: true, data, error: null });

    render(<CapacityForecastPage />);

    await waitFor(() =>
      expect(screen.getByText(/ward alpha/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/ward bravo/i)).toBeInTheDocument();

    // Default contract: beds tab + 72h horizon.
    expect(apiMock.get).toHaveBeenCalledWith(
      "/ai/capacity/beds?horizon=72",
      expect.objectContaining({ token: "tok-1" }),
    );

    // Summary cards.
    expect(screen.getByText(/aggregate occupancy/i)).toBeInTheDocument();
    // 12+8 currently in use, 20+10 capacity.
    expect(screen.getByText("20 / 30")).toBeInTheDocument();
    // 5+3 inflow, 8+5 upper.
    expect(screen.getByText(/upper 13/i)).toBeInTheDocument();
    // 1 ward at risk (Bravo's expectedStockout=true).
    expect(screen.getByText(/^1 unit$/)).toBeInTheDocument();

    // Heatmap heading reads "Ward occupancy heatmap" for the beds tab.
    expect(screen.getByText(/ward occupancy heatmap/i)).toBeInTheDocument();

    // Stockout marker present for Bravo.
    expect(screen.getByLabelText(/stockout risk/i)).toBeInTheDocument();

    // Generated-at footer rendered.
    expect(screen.getByText(/generated /i)).toBeInTheDocument();
  });

  it("renders the empty heatmap copy when forecasts list is empty", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: forecastEnvelope([], {
        totalCapacity: 0,
        totalCurrentlyInUse: 0,
        totalPredictedInflow: 0,
        totalPredictedInflowUpper: 0,
        aggregateOccupancyPct: 0,
        anyStockoutRisk: false,
        wardsAtRisk: 0,
      }),
      error: null,
    });

    render(<CapacityForecastPage />);

    expect(
      await screen.findByText(/no resources to display\./i),
    ).toBeInTheDocument();
    // Summary cards still render even with zero capacity.
    expect(screen.getByText(/aggregate occupancy/i)).toBeInTheDocument();
  });

  it("renders the full confidence ladder (high, medium, low chips) for each forecast row", async () => {
    const data = forecastEnvelope([
      forecastRow({ resourceId: "w1", resourceName: "High Ward", confidence: "high" }),
      forecastRow({
        resourceId: "w2",
        resourceName: "Medium Ward",
        confidence: "medium",
      }),
      forecastRow({
        resourceId: "w3",
        resourceName: "Low Ward",
        confidence: "low",
        insufficientData: true,
      }),
    ]);
    apiMock.get.mockResolvedValue({ success: true, data, error: null });

    render(<CapacityForecastPage />);

    await waitFor(() =>
      expect(screen.getByText(/high ward/i)).toBeInTheDocument(),
    );

    // Each confidence tone surfaces as an uppercase chip.
    expect(screen.getByText(/^high$/i)).toBeInTheDocument();
    expect(screen.getByText(/^medium$/i)).toBeInTheDocument();
    expect(screen.getByText(/^low$/i)).toBeInTheDocument();

    // The low-confidence row also has the "MA" insufficient-data badge.
    expect(screen.getByText(/^ma$/i)).toBeInTheDocument();
  });

  it("refetches against /ai/capacity/icu when the ICU tab is selected", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: forecastEnvelope([
        forecastRow({
          resourceId: "icu1",
          resourceName: "ICU North",
          expectedOccupancyPct: 60,
        }),
      ]),
      error: null,
    });

    render(<CapacityForecastPage />);

    // Wait for initial beds load to settle.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("capacity-tab-icu"));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/ai/capacity/icu?horizon=72",
        expect.objectContaining({ token: "tok-1" }),
      ),
    );

    // ICU tab is now selected.
    expect(screen.getByTestId("capacity-tab-icu")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("refetches against /ai/capacity/ot and renders the OT-specific heatmap heading when the OT tab is selected", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: forecastEnvelope([
        forecastRow({
          resourceId: "ot1",
          resourceName: "OT 1",
          resourceType: "ot",
          expectedOccupancyPct: 45,
        }),
      ]),
      error: null,
    });

    render(<CapacityForecastPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("capacity-tab-ot"));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/ai/capacity/ot?horizon=72",
        expect.objectContaining({ token: "tok-1" }),
      ),
    );
    // OT tab shows the OT-specific heading.
    expect(
      await screen.findByText(/ot utilisation heatmap/i),
    ).toBeInTheDocument();
  });

  it("refetches with the chosen horizon (24h / 48h) when the horizon toggle is clicked", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: forecastEnvelope([forecastRow()]),
      error: null,
    });

    render(<CapacityForecastPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /^24h$/ }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenLastCalledWith(
        "/ai/capacity/beds?horizon=24",
        expect.objectContaining({ token: "tok-1" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /^48h$/ }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenLastCalledWith(
        "/ai/capacity/beds?horizon=48",
        expect.objectContaining({ token: "tok-1" }),
      ),
    );
  });

  it("refetches when the Refresh button is clicked", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: forecastEnvelope([forecastRow()]),
      error: null,
    });

    render(<CapacityForecastPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));
    expect(apiMock.get).toHaveBeenNthCalledWith(
      2,
      "/ai/capacity/beds?horizon=72",
      expect.objectContaining({ token: "tok-1" }),
    );
  });

  it("renders the error banner when the API envelope surfaces success=false with an error message", async () => {
    apiMock.get.mockResolvedValue({
      success: false,
      data: null as any,
      error: "Forecast service warming up",
    });

    render(<CapacityForecastPage />);

    expect(
      await screen.findByText(/forecast service warming up/i),
    ).toBeInTheDocument();
    // Heatmap section is not rendered when data is null.
    expect(
      screen.queryByText(/ward occupancy heatmap/i),
    ).not.toBeInTheDocument();
  });

  it("renders the error banner with the thrown Error message when the GET rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("Service unavailable"));

    render(<CapacityForecastPage />);

    expect(
      await screen.findByText(/service unavailable/i),
    ).toBeInTheDocument();
  });

  it("falls back to a generic error message when the rejection is not an Error instance", async () => {
    apiMock.get.mockRejectedValue("string-thrown");

    render(<CapacityForecastPage />);

    expect(
      await screen.findByText(/failed to load forecast/i),
    ).toBeInTheDocument();
  });
});
