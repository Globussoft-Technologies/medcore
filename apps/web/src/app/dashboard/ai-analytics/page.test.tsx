// Coverage tests for the AI Analytics dashboard page.
// Modules under test: apps/web/src/app/dashboard/ai-analytics/page.tsx —
//   surfaces operational metrics for the Triage and Scribe AI products by
//   GETting /analytics/ai/triage and /analytics/ai/scribe on mount + on
//   date-range change + on Refresh, then rendering a tabbed StatCard
//   grid with per-tab tables and a language-pill row. The page reads the
//   auth token via `useAuthStore()` destructure (no selector) and threads
//   it into the api call when present.
// Why: locks in the wire contract (endpoints + query params + token opt),
//   the tab swap, the empty-state "No data" branches for all three tables,
//   the conditional language-pill row, the date-input setter wiring, and
//   both error paths (Error-with-message + non-Error rejection fallback)
//   so refactors of this surface can't silently regress it.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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

  it("hides the language-pill row when languageBreakdown is empty", async () => {
    mockAnalytics(
      { ...triagePayload, languageBreakdown: [] },
      scribePayload
    );
    render(<AIAnalyticsPage />);
    await screen.findByRole("heading", { name: /ai analytics/i });
    // The "Language Breakdown" h3 should not render at all when the array is empty.
    await waitFor(() => {
      expect(screen.getByText("120")).toBeInTheDocument();
    });
    expect(screen.queryByText(/language breakdown/i)).not.toBeInTheDocument();
  });

  it("renders 'No data' on the Scribe tab when statusBreakdown is empty", async () => {
    mockAnalytics(triagePayload, { ...scribePayload, statusBreakdown: [] });
    const user = userEvent.setup();
    render(<AIAnalyticsPage />);
    await screen.findByRole("heading", { name: /ai analytics/i });
    await user.click(screen.getByRole("button", { name: /^scribe$/i }));
    await waitFor(() => {
      // Scribe tab is now active; status table renders the empty-state copy.
      expect(screen.getByText(/status breakdown/i)).toBeInTheDocument();
      expect(screen.getByText(/no data/i)).toBeInTheDocument();
    });
  });

  it("re-fetches both endpoints when From / To date inputs change", async () => {
    mockAnalytics();
    render(<AIAnalyticsPage />);
    await screen.findByRole("heading", { name: /ai analytics/i });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    apiMock.get.mockClear();

    // Change From date — useEffect refires via fetchTriage/Scribe memo deps.
    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: "2026-01-01" },
    });

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("from=2026-01-01"))).toBe(true);
    });

    apiMock.get.mockClear();

    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: "2026-02-15" },
    });

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("to=2026-02-15"))).toBe(true);
    });
  });

  it("threads the auth token through the api.get opts on mount", async () => {
    mockAnalytics();
    render(<AIAnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));

    const triageCall = apiMock.get.mock.calls.find(([url]) =>
      String(url).startsWith("/analytics/ai/triage")
    );
    const scribeCall = apiMock.get.mock.calls.find(([url]) =>
      String(url).startsWith("/analytics/ai/scribe")
    );

    expect(triageCall).toBeTruthy();
    expect(scribeCall).toBeTruthy();
    // Both URLs carry the from/to range.
    expect(String(triageCall![0])).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    expect(String(scribeCall![0])).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    // Token-bearing opts object passed as second arg.
    expect(triageCall![1]).toEqual(expect.objectContaining({ token: "tok" }));
    expect(scribeCall![1]).toEqual(expect.objectContaining({ token: "tok" }));
  });

  it("omits the opts object on api.get when no auth token is present", async () => {
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
        token: null,
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    mockAnalytics();

    render(<AIAnalyticsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));

    // Source does `token ? { token } : undefined` — second arg should be undefined.
    for (const call of apiMock.get.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
  });

  it("shows the generic fallback message when triage rejects with a non-Error value", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/analytics/ai/triage")) {
        // Bare object — not an Error instance, hits the fallback branch.
        return Promise.reject({ status: 500 });
      }
      return Promise.resolve({ success: true, data: scribePayload });
    });
    render(<AIAnalyticsPage />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load triage data/i)).toBeInTheDocument();
    });
  });

  it("shows an error banner when the scribe endpoint fails", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/analytics/ai/scribe")) {
        return Promise.reject(new Error("Scribe down"));
      }
      return Promise.resolve({ success: true, data: triagePayload });
    });
    const user = userEvent.setup();
    render(<AIAnalyticsPage />);
    await screen.findByRole("heading", { name: /ai analytics/i });
    await user.click(screen.getByRole("button", { name: /^scribe$/i }));
    await waitFor(() => expect(screen.getByText(/scribe down/i)).toBeInTheDocument());
  });

  it("shows the generic fallback message when scribe rejects with a non-Error value", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/analytics/ai/scribe")) {
        return Promise.reject("string-only failure");
      }
      return Promise.resolve({ success: true, data: triagePayload });
    });
    const user = userEvent.setup();
    render(<AIAnalyticsPage />);
    await screen.findByRole("heading", { name: /ai analytics/i });
    await user.click(screen.getByRole("button", { name: /^scribe$/i }));
    await waitFor(() => {
      expect(screen.getByText(/failed to load scribe data/i)).toBeInTheDocument();
    });
  });
});
