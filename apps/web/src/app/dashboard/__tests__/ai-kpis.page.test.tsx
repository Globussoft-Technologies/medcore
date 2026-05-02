/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai-kpis",
}));

import AIKpisPage from "../ai-kpis/page";

function makeKpi(overrides: any = {}) {
  return {
    current: 0.42,
    target: 0.5,
    target_direction: "up",
    unit: "pct",
    sampleSize: 120,
    ...overrides,
  };
}

const f1Bundle = {
  misroutedOpdAppointments: makeKpi({ target_direction: "down" }),
  bookingCompletionRate: makeKpi(),
  patientCsatAiFlow: makeKpi({ unit: "rating", current: 4.1, target: 4 }),
  top1AcceptanceRate: makeKpi(),
  timeToConfirmedAppointment: makeKpi({ unit: "seconds", current: 60, target: 90, target_direction: "down" }),
  redFlagFalseNegativeRate: makeKpi({ target_direction: "down" }),
  frontDeskCallVolume: makeKpi({ unit: "count", current: 12, target: 30, target_direction: "down" }),
};

const f2Bundle = {
  doctorDocTimeReduction: makeKpi({ unit: "minutes", current: 4, target: 3 }),
  doctorAdoption: makeKpi(),
  soapAcceptanceRate: makeKpi(),
  drugAlertInducedChanges: makeKpi(),
  medicationErrorRateComparison: makeKpi({ target_direction: "down" }),
  doctorNpsForScribe: makeKpi({ unit: "rating", current: 8, target: 7 }),
  timeToSignOff: makeKpi({ unit: "seconds", current: 120, target: 180, target_direction: "down" }),
};

function asAdmin() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      token: "tok-1",
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asDoctor() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u2", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      token: "tok-1",
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("AIKpisPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
  });

  it("smoke renders the page title for ADMIN", async () => {
    asAdmin();
    apiMock.get.mockResolvedValue({ data: { bundle: f1Bundle } });
    render(<AIKpisPage />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-kpis-title")).toBeInTheDocument()
    );
  });

  it("renders KPI cards once both feature bundles resolve", async () => {
    asAdmin();
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/ai/kpis/feature1"))
        return Promise.resolve({ data: { bundle: f1Bundle } });
      if (url.includes("/ai/kpis/feature2"))
        return Promise.resolve({ data: { bundle: f2Bundle } });
      return Promise.resolve({ data: {} });
    });
    render(<AIKpisPage />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-kpis-feature1-panel")).toBeInTheDocument()
    );
    expect(screen.getByTestId("kpi-misrouted")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-csat")).toBeInTheDocument();
  });

  it("surfaces an error banner when KPI fetch rejects", async () => {
    asAdmin();
    apiMock.get.mockRejectedValue(new Error("500 Server Error"));
    render(<AIKpisPage />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-kpis-error")).toBeInTheDocument()
    );
    expect(screen.getByTestId("ai-kpis-error").textContent).toMatch(/500/);
  });

  it("renders the admin-only gate for non-ADMIN roles", async () => {
    asDoctor();
    render(<AIKpisPage />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-kpis-admin-gate")).toBeInTheDocument()
    );
  });

  it("renders the From/To/Refresh controls in the header", async () => {
    asAdmin();
    apiMock.get.mockResolvedValue({ data: { bundle: f1Bundle } });
    render(<AIKpisPage />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-kpis-from")).toBeInTheDocument()
    );
    expect(screen.getByTestId("ai-kpis-to")).toBeInTheDocument();
    expect(screen.getByTestId("ai-kpis-refresh")).toBeInTheDocument();
  });
});
