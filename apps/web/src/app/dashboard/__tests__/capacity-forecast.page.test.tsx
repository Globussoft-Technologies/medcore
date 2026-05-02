/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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

import CapacityForecastPage from "../capacity-forecast/page";

const sampleForecast = {
  horizonHours: 72,
  generatedAt: new Date().toISOString(),
  forecasts: [
    {
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
    },
  ],
  summary: {
    totalCapacity: 20,
    totalCurrentlyInUse: 12,
    totalPredictedInflow: 5,
    totalPredictedInflowUpper: 8,
    aggregateOccupancyPct: 75,
    anyStockoutRisk: false,
    wardsAtRisk: 0,
  },
};

describe("CapacityForecastPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
        token: "tok-1",
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ success: true, data: sampleForecast });
  });

  it("smoke renders the page heading", async () => {
    render(<CapacityForecastPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /capacity forecast/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the beds/icu/ot resource tabs", async () => {
    render(<CapacityForecastPage />);
    await waitFor(() =>
      expect(screen.getByTestId("capacity-tab-beds")).toBeInTheDocument()
    );
    expect(screen.getByTestId("capacity-tab-icu")).toBeInTheDocument();
    expect(screen.getByTestId("capacity-tab-ot")).toBeInTheDocument();
  });

  it("renders the empty-state when forecasts list is empty", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: { ...sampleForecast, forecasts: [] },
    });
    render(<CapacityForecastPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no resources to display/i)
      ).toBeInTheDocument()
    );
  });

  it("renders forecast tiles when data is present", async () => {
    render(<CapacityForecastPage />);
    await waitFor(() =>
      expect(screen.getByText(/ward a/i)).toBeInTheDocument()
    );
    expect(screen.getAllByText(/75%/).length).toBeGreaterThan(0);
  });

  it("shows an error banner when the forecast endpoint rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("Service unavailable"));
    render(<CapacityForecastPage />);
    await waitFor(() =>
      expect(screen.getByText(/service unavailable/i)).toBeInTheDocument()
    );
  });
});
