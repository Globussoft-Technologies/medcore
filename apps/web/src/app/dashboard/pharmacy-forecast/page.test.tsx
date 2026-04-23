/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
  usePathname: () => "/dashboard/pharmacy-forecast",
}));

import PharmacyForecastPage from "./page";

const sampleForecast = [
  {
    inventoryItemId: "inv1",
    medicineName: "Amoxicillin",
    currentStock: 10,
    avgDailyConsumption: 3,
    predictedConsumption7d: 21,
    predictedConsumption30d: 90,
    daysOfStockLeft: 3.3,
    reorderRecommended: true,
    suggestedReorderQty: 120,
    urgency: "CRITICAL",
  },
  {
    inventoryItemId: "inv2",
    medicineName: "Paracetamol",
    currentStock: 500,
    avgDailyConsumption: 5,
    predictedConsumption7d: 35,
    predictedConsumption30d: 150,
    daysOfStockLeft: 100,
    reorderRecommended: false,
    suggestedReorderQty: 0,
    urgency: "OK",
  },
];

describe("PharmacyForecastPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", role: "ADMIN" }, token: "tok" };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders the header and an initial empty-prompt before loading", () => {
    render(<PharmacyForecastPage />);
    expect(
      screen.getByRole("heading", { name: /inventory forecast/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/select the days ahead and click/i)
    ).toBeInTheDocument();
  });

  it("loads a forecast and renders the table rows", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: {
        forecast: sampleForecast,
        generatedAt: new Date().toISOString(),
      },
      error: null,
    });
    const user = userEvent.setup();
    render(<PharmacyForecastPage />);
    await user.click(screen.getByRole("button", { name: /load forecast/i }));
    await waitFor(() => {
      expect(screen.getByText("Amoxicillin")).toBeInTheDocument();
      expect(screen.getByText("Paracetamol")).toBeInTheDocument();
      expect(screen.getByText(/1 critical/i)).toBeInTheDocument();
    });
  });

  it("shows a loading label while the request is pending", async () => {
    let resolveFn: (v: any) => void = () => {};
    apiMock.get.mockImplementation(() => new Promise((r) => (resolveFn = r)));
    const user = userEvent.setup();
    render(<PharmacyForecastPage />);
    await user.click(screen.getByRole("button", { name: /load forecast/i }));
    expect(await screen.findByText(/loading\.\.\./i)).toBeInTheDocument();
    resolveFn({
      success: true,
      data: { forecast: [], generatedAt: new Date().toISOString() },
      error: null,
    });
  });

  it("renders the empty-state message when the API returns zero items", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: { forecast: [], generatedAt: new Date().toISOString() },
      error: null,
    });
    const user = userEvent.setup();
    render(<PharmacyForecastPage />);
    await user.click(screen.getByRole("button", { name: /load forecast/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/no inventory items found for forecasting/i)
      ).toBeInTheDocument()
    );
  });

  it("surfaces an API-level error in the error banner", async () => {
    apiMock.get.mockResolvedValue({
      success: false,
      data: null,
      error: "Forecast service down",
    });
    const user = userEvent.setup();
    render(<PharmacyForecastPage />);
    await user.click(screen.getByRole("button", { name: /load forecast/i }));
    await waitFor(() =>
      expect(screen.getByText(/forecast service down/i)).toBeInTheDocument()
    );
  });

  it("passes the insights=true flag when the checkbox is ticked", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: {
        forecast: [],
        insights: "Consider increasing Amoxicillin orders",
        generatedAt: new Date().toISOString(),
      },
      error: null,
    });
    const user = userEvent.setup();
    render(<PharmacyForecastPage />);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /load forecast/i }));
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("insights=true"))).toBe(true);
    });
  });
});
