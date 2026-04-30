/* eslint-disable @typescript-eslint/no-explicit-any */
// Sprint 2 (2026-04-30): Sentiment Analytics dashboard tests.
// Locks in:
//   - renders for ADMIN
//   - the NPS KPI tile shows the value from /feedback/summary
//   - non-allowed roles (DOCTOR, PATIENT) redirect to /dashboard/not-authorized
//   - changing the date range refetches the API
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock, routerReplace } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  routerReplace: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: routerReplace,
    back: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/sentiment",
}));

import SentimentAnalyticsPage from "../sentiment/page";

const driversPayload = {
  windowDays: 30,
  totalFeedback: 42,
  positiveThemes: [
    { theme: "Friendly Doctor", count: 7, sampleQuotes: [] },
    { theme: "Quick Booking", count: 4, sampleQuotes: [] },
  ],
  negativeThemes: [
    { theme: "Long Wait Time", count: 5, sampleQuotes: [] },
  ],
  actionableInsights: ["Reduce wait time at OPD"],
  generatedAt: new Date().toISOString(),
};

const summaryPayload = {
  totalCount: 42,
  overallAvg: 4.1,
  avgRatingByCategory: { DOCTOR: 4.6, WAITING_TIME: 2.8, BILLING: 4.0 },
  npsScore: 67,
  npsSampleSize: 30,
  promoters: 22,
  detractors: 3,
  passives: 5,
  trend: [],
};

const feedbackPayload = [
  {
    id: "fb-neg-1",
    category: "WAITING_TIME",
    rating: 2,
    nps: 3,
    comment: "Waited 90 minutes in OPD. Very frustrating.",
    submittedAt: new Date().toISOString(),
    patient: { user: { name: "Asha Roy" } },
    aiSentiment: { sentiment: "negative", score: -0.72, themes: ["wait"] },
  },
  {
    id: "fb-pos-1",
    category: "DOCTOR",
    rating: 5,
    nps: 9,
    comment: "Doctor was excellent.",
    submittedAt: new Date().toISOString(),
    patient: { user: { name: "Bina S" } },
    aiSentiment: { sentiment: "positive", score: 0.81, themes: [] },
  },
];

function wireApi() {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/ai/sentiment/nps-drivers"))
      return Promise.resolve({ data: driversPayload });
    if (url.startsWith("/feedback/summary"))
      return Promise.resolve({ data: summaryPayload });
    if (url.startsWith("/feedback"))
      return Promise.resolve({ data: feedbackPayload });
    return Promise.resolve({ data: null });
  });
}

describe("SentimentAnalyticsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerReplace.mockReset();
    toastMock.error.mockReset();
    authMock.mockReturnValue({
      user: { id: "u-admin", name: "Admin", email: "a@x.com", role: "ADMIN" },
      isLoading: false,
    });
    wireApi();
  });

  it("renders the page heading and KPI tiles for ADMIN", async () => {
    render(<SentimentAnalyticsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /sentiment analytics/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("sentiment-page")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("sentiment-kpi-nps")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("sentiment-kpi-total")).toBeInTheDocument();
  });

  it("NPS KPI tile shows the value from /feedback/summary", async () => {
    render(<SentimentAnalyticsPage />);
    await waitFor(() => {
      const tile = screen.getByTestId("sentiment-kpi-nps");
      // 67 is the npsScore mocked above; rendering as text.
      expect(tile.textContent).toMatch(/67/);
    });
    // And the Total Feedback tile picks up totalCount/totalFeedback.
    await waitFor(() => {
      expect(screen.getByTestId("sentiment-kpi-total").textContent).toMatch(
        /42/,
      );
    });
  });

  it("redirects DOCTOR and PATIENT roles to /dashboard/not-authorized", async () => {
    authMock.mockReturnValue({
      user: { id: "u-doc", role: "DOCTOR" },
      isLoading: false,
    });
    const { unmount } = render(<SentimentAnalyticsPage />);
    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized"),
      );
    });
    unmount();

    routerReplace.mockReset();
    authMock.mockReturnValue({
      user: { id: "u-pat", role: "PATIENT" },
      isLoading: false,
    });
    render(<SentimentAnalyticsPage />);
    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized"),
      );
    });
  });

  it("changing the date range refetches the API with the new query", async () => {
    const u = userEvent.setup();
    render(<SentimentAnalyticsPage />);
    // Wait for the initial load to settle.
    await waitFor(() =>
      expect(screen.getByTestId("sentiment-kpi-nps")).toBeInTheDocument(),
    );
    const initialCallCount = apiMock.get.mock.calls.length;
    expect(initialCallCount).toBeGreaterThan(0);

    // Change the "from" date to a value that will appear in the next query.
    const fromInput = screen.getByTestId("sentiment-from") as HTMLInputElement;
    await u.clear(fromInput);
    await u.type(fromInput, "2026-01-01");

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      // At least one new feedback/summary fetch carried the new from= value.
      expect(
        urls.some(
          (uu) =>
            uu.includes("from=2026-01-01") &&
            (uu.startsWith("/feedback/summary") ||
              uu.startsWith("/feedback?")),
        ),
      ).toBe(true);
    });
    // Total call count must have grown beyond the initial render's batch.
    expect(apiMock.get.mock.calls.length).toBeGreaterThan(initialCallCount);
  });
});
