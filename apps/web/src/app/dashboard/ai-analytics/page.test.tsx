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
  usePathname: () => "/dashboard/ai-analytics",
}));

import AIAnalyticsPage from "./page";

const triagePayload = {
  totalSessions: 120,
  completedSessions: 90,
  completionRate: 0.75,
  emergencyDetected: 4,
  bookingConversions: 50,
  conversionRate: 0.42,
  avgTurnsToRecommendation: 3,
  avgConfidence: 0.81,
  topChiefComplaints: [{ complaint: "chest pain", count: 10 }],
  specialtyDistribution: [{ specialty: "Cardiology", count: 7 }],
  languageBreakdown: [{ language: "en", count: 80 }],
  statusBreakdown: [{ status: "COMPLETED", count: 90 }],
};

const scribePayload = {
  totalSessions: 50,
  completedSessions: 45,
  consentWithdrawnSessions: 1,
  avgDoctorEditRate: 2.5,
  drugAlertRate: 0.1,
  totalDrugAlerts: 5,
  statusBreakdown: [{ status: "COMPLETED", count: 45 }],
};

function mockAnalytics(triage: any = triagePayload, scribe: any = scribePayload) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/analytics/ai/triage")) {
      return Promise.resolve({ success: true, data: triage });
    }
    if (url.startsWith("/analytics/ai/scribe")) {
      return Promise.resolve({ success: true, data: scribe });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("AIAnalyticsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
        token: "tok",
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders the heading and the default triage tab data", async () => {
    mockAnalytics();
    render(<AIAnalyticsPage />);
    expect(
      await screen.findByRole("heading", { name: /ai analytics/i })
    ).toBeInTheDocument();
    await waitFor(() => {
      // 120 total sessions from triage payload
      expect(screen.getByText("120")).toBeInTheDocument();
    });
  });

  it("shows an error banner when triage endpoint fails", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/analytics/ai/triage")) {
        return Promise.reject(new Error("Triage down"));
      }
      return Promise.resolve({ success: true, data: scribePayload });
    });
    render(<AIAnalyticsPage />);
    await waitFor(() => expect(screen.getByText(/triage down/i)).toBeInTheDocument());
  });

  it("switches to the Scribe tab and renders its metrics", async () => {
    mockAnalytics();
    const user = userEvent.setup();
    render(<AIAnalyticsPage />);
    await screen.findByRole("heading", { name: /ai analytics/i });
    await user.click(screen.getByRole("button", { name: /^scribe$/i }));
    await waitFor(() => {
      // 50 total scribe sessions
      expect(screen.getByText("50")).toBeInTheDocument();
      expect(screen.getByText(/total drug alerts/i)).toBeInTheDocument();
    });
  });

  it("refreshes both endpoints when Refresh is clicked", async () => {
    mockAnalytics();
    const user = userEvent.setup();
    render(<AIAnalyticsPage />);
    await screen.findByRole("heading", { name: /ai analytics/i });
    apiMock.get.mockClear();
    await user.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/analytics/ai/triage"))).toBe(true);
      expect(urls.some((u) => u.includes("/analytics/ai/scribe"))).toBe(true);
    });
  });

  it("renders 'No data' for empty breakdown tables", async () => {
    mockAnalytics(
      { ...triagePayload, topChiefComplaints: [], specialtyDistribution: [] },
      scribePayload
    );
    render(<AIAnalyticsPage />);
    await screen.findByRole("heading", { name: /ai analytics/i });
    await waitFor(() => {
      expect(screen.getAllByText(/no data/i).length).toBeGreaterThanOrEqual(1);
    });
  });
});
