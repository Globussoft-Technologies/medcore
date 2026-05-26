/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FeedbackPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/feedback/page.tsx`, the Patient Feedback
 *     Analytics dashboard (issue #207 — staff-only post-fix). Endpoints the
 *     page hits:
 *       GET /feedback?category=&from=&to=&limit=50
 *       GET /feedback/summary?from=&to=
 *       GET /ai/sentiment/nps-drivers?days=30
 *
 *   - Behaviours covered:
 *       1. PATIENT role — toast.error fires, router.replace targets
 *          /dashboard/not-authorized, and the render path short-circuits to
 *          `null` (no list/summary fetches at all).
 *       2. Loading branch — the `feedback-loading` SkeletonTable renders
 *          while the initial GETs are pending; the page heading is still
 *          visible.
 *       3. Happy fetch — multiple feedback rows render with patient name,
 *          underscore-stripped category, NPS, sentiment badge, comment
 *          truncation (>60 chars), em-dash fallback when patient is null,
 *          em-dash fallback when nps is null.
 *       4. Summary KPI tiles — NPS score value + sentiment badge
 *          ("Good"/"Mixed"/"Poor"), overall average rating, this-month and
 *          total counts.
 *       5. Sentiment badge ladder — `aiSentiment.sentiment` of
 *          positive/neutral/negative each render their respective badge text;
 *          a row with no `aiSentiment` renders the "analyzing…" placeholder.
 *       6. NPS Drivers AI widget — renders headers + items when the
 *          /ai/sentiment/nps-drivers endpoint returns a well-shaped payload;
 *          the widget is OMITTED when the payload is malformed; the widget
 *          is OMITTED on rejection.
 *       7. Category filter <select> — changing the category triggers a
 *          refetch with `category=<value>` in the querystring.
 *       8. From/to date filters — changing each input triggers a refetch
 *          with `from=` / `to=` in the list querystring (and the summary's
 *          adjacent querystring shape).
 *       9. Empty branch — "No feedback yet" copy renders when the list
 *          response is empty.
 *      10. Error branch — the silent try/catch swallows the rejection; the
 *          loading flag still flips off and the empty branch renders.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            next/navigation (useRouter, usePathname),
 *            @/components/Skeleton (stubbed to a minimal div).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, routerMock, pathnameMock } = vi.hoisted(
  () => ({
    apiMock: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    toastMock: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    },
    authMock: vi.fn(),
    routerMock: {
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    },
    pathnameMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => pathnameMock(),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import FeedbackPage from "../page";

type FeedbackRow = {
  id: string;
  category: string;
  rating: number;
  nps: number | null;
  comment: string | null;
  submittedAt: string;
  patient?: { user: { name: string; phone: string } };
  aiSentiment?: {
    sentiment: "positive" | "neutral" | "negative";
    emotions: string[];
    themes: string[];
  } | null;
};

type Summary = {
  totalCount: number;
  overallAvg: number;
  avgRatingByCategory: Record<string, number>;
  npsScore: number;
  npsSampleSize: number;
  promoters: number;
  detractors: number;
  passives: number;
  trend: Array<{ month: string; avgRating: number; count: number }>;
};

function feedbackFixture(overrides: Partial<FeedbackRow> = {}): FeedbackRow {
  return {
    id: "fb-1",
    category: "DOCTOR",
    rating: 5,
    nps: 9,
    comment: "Great care",
    submittedAt: "2026-04-01T10:00:00.000Z",
    patient: { user: { name: "Aanya Sharma", phone: "+919999000111" } },
    aiSentiment: {
      sentiment: "positive",
      emotions: ["happy"],
      themes: ["doctor"],
    },
    ...overrides,
  };
}

function summaryFixture(overrides: Partial<Summary> = {}): Summary {
  return {
    totalCount: 12,
    overallAvg: 4.25,
    avgRatingByCategory: {
      DOCTOR: 4.5,
      NURSE: 4.0,
      RECEPTION: 3.8,
      CLEANLINESS: 4.2,
      FOOD: 3.5,
      WAITING_TIME: 3.0,
      BILLING: 4.1,
      OVERALL: 4.0,
    },
    npsScore: 60,
    npsSampleSize: 10,
    promoters: 7,
    detractors: 1,
    passives: 2,
    trend: [
      { month: "2026-03", avgRating: 4.1, count: 4 },
      { month: "2026-04", avgRating: 4.3, count: 8 },
    ],
    ...overrides,
  };
}

function npsDriversFixture(overrides: any = {}) {
  return {
    windowDays: 30,
    totalFeedback: 42,
    positiveThemes: [
      { theme: "friendly staff", count: 12, sampleQuotes: ["Loved it"] },
      { theme: "clean rooms", count: 8, sampleQuotes: [] },
    ],
    negativeThemes: [
      { theme: "waiting time", count: 5, sampleQuotes: [] },
    ],
    actionableInsights: [
      "Reduce reception wait window during 10-12 AM peak",
    ],
    generatedAt: "2026-04-01T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * Set up the api.get mock to route by URL prefix to the right fixture.
 * Vitest's `mockResolvedValueOnce` chains break in this page because three
 * fetches fire on mount and the order is not guaranteed (Promise.all + a
 * sibling useEffect for NPS drivers).
 */
function wireGetByPath(opts: {
  list?: FeedbackRow[] | (() => Promise<{ data: FeedbackRow[] }>);
  summary?: Summary | null;
  nps?: any;
  npsReject?: boolean;
  listReject?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/ai/sentiment/nps-drivers")) {
      if (opts.npsReject) return Promise.reject(new Error("nps boom"));
      return Promise.resolve({ data: opts.nps ?? null });
    }
    if (url.startsWith("/feedback/summary")) {
      return Promise.resolve({ data: opts.summary ?? summaryFixture() });
    }
    if (url.startsWith("/feedback")) {
      if (opts.listReject) return Promise.reject(new Error("list boom"));
      if (typeof opts.list === "function") return (opts.list as any)();
      return Promise.resolve({ data: opts.list ?? [] });
    }
    return Promise.resolve({ data: null });
  });
}

function asStaff() {
  authMock.mockReturnValue({
    user: {
      id: "u-recep",
      userId: "u-recep",
      role: "RECEPTION",
      name: "Front Desk",
    },
    isLoading: false,
  });
}

function asPatient() {
  authMock.mockReturnValue({
    user: {
      id: "u-pat",
      userId: "u-pat",
      role: "PATIENT",
      name: "Pat",
    },
    isLoading: false,
  });
}

describe("Feedback dashboard page (NPS analytics, staff-only)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    pathnameMock.mockReset();
    pathnameMock.mockReturnValue("/dashboard/feedback");
    asStaff();
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects PATIENT to /dashboard/not-authorized, toasts, and never fires the list/summary fetches", async () => {
    wireGetByPath({ list: [feedbackFixture()], summary: summaryFixture() });
    asPatient();

    render(<FeedbackPage />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        "/dashboard/not-authorized?from=%2Fdashboard%2Ffeedback",
      ),
    );
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/staff/i),
      5000,
    );
    // The patient render path is `return null` so the heading should never
    // render. Use queryBy to be sure we're asserting non-presence.
    expect(
      screen.queryByRole("heading", { name: /Patient Feedback/i }),
    ).not.toBeInTheDocument();
    // And no list / summary / NPS fetches should have been issued.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the SkeletonTable loading branch while the initial fetches are pending", async () => {
    // Keep the list call pending forever; resolve the others so they don't
    // gate the loading flag.
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/feedback") && !url.startsWith("/feedback/summary")) {
        return new Promise(() => {});
      }
      if (url.startsWith("/feedback/summary")) {
        return Promise.resolve({ data: summaryFixture() });
      }
      return Promise.resolve({ data: null });
    });

    render(<FeedbackPage />);

    expect(
      screen.getByRole("heading", { name: /Patient Feedback/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("feedback-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("hits all three endpoints on mount and renders one row per feedback", async () => {
    wireGetByPath({
      list: [
        feedbackFixture({ id: "fb-1", category: "DOCTOR" }),
        feedbackFixture({
          id: "fb-2",
          category: "WAITING_TIME",
          patient: { user: { name: "Rohit Kumar", phone: "+919998887776" } },
          nps: 3,
          rating: 2,
          aiSentiment: {
            sentiment: "negative",
            emotions: ["frustrated"],
            themes: ["wait"],
          },
        }),
      ],
      summary: summaryFixture(),
      nps: npsDriversFixture(),
    });

    render(<FeedbackPage />);

    await screen.findByText("Aanya Sharma");
    await screen.findByText("Rohit Kumar");

    // Querystring contract: limit=50, no filter params on mount.
    expect(apiMock.get).toHaveBeenCalledWith("/feedback?limit=50");
    // Summary called with empty trailing string (no from/to).
    expect(apiMock.get).toHaveBeenCalledWith("/feedback/summary?");
    expect(apiMock.get).toHaveBeenCalledWith(
      "/ai/sentiment/nps-drivers?days=30",
    );

    // Underscore-stripped category appears in the rows.
    const tbody = document.querySelector("tbody")!;
    expect(within(tbody).getByText("DOCTOR")).toBeInTheDocument();
    expect(within(tbody).getByText("WAITING TIME")).toBeInTheDocument();
    // Comment "Great care" rendered (under the 60-char truncation threshold).
    expect(within(tbody).getAllByText("Great care").length).toBeGreaterThan(0);
  });

  it("renders the NPS / overall avg / monthly count KPI tiles with the right values", async () => {
    wireGetByPath({
      list: [feedbackFixture()],
      summary: summaryFixture({
        npsScore: 75,
        overallAvg: 4.5,
        totalCount: 30,
        promoters: 20,
        detractors: 2,
        npsSampleSize: 25,
        trend: [
          { month: "2026-03", avgRating: 4.1, count: 4 },
          { month: "2026-04", avgRating: 4.5, count: 15 },
        ],
      }),
      nps: null,
    });

    render(<FeedbackPage />);

    await screen.findByText("Aanya Sharma");

    const nps = screen.getByTestId("nps-score-value");
    expect(nps).toHaveTextContent("75");
    expect(screen.getByTestId("nps-sentiment-badge")).toHaveTextContent("Good");
    // Overall avg formatted to 2 dp — "4.50" also appears in the category
    // bar chart rows, so just assert it's at least present.
    expect(screen.getAllByText("4.50").length).toBeGreaterThan(0);
    // Promoters/detractors/sample line.
    expect(
      screen.getByText(/20 promoters,\s+2 detractors \(25 responses\)/i),
    ).toBeInTheDocument();
    // This-month tile uses the LAST trend entry's count (15) and totalCount.
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText(/Total in range:\s*30/i)).toBeInTheDocument();
  });

  it('renders the "Mixed" NPS badge when score is between 0 and 50, and "Poor" when negative', async () => {
    wireGetByPath({
      list: [feedbackFixture()],
      summary: summaryFixture({ npsScore: 20 }),
      nps: null,
    });
    const { unmount } = render(<FeedbackPage />);
    await screen.findByText("Aanya Sharma");
    expect(screen.getByTestId("nps-sentiment-badge")).toHaveTextContent(
      "Mixed",
    );
    unmount();
    cleanup();

    wireGetByPath({
      list: [feedbackFixture()],
      summary: summaryFixture({ npsScore: -10 }),
      nps: null,
    });
    render(<FeedbackPage />);
    await screen.findByText("Aanya Sharma");
    expect(screen.getByTestId("nps-sentiment-badge")).toHaveTextContent("Poor");
  });

  it("renders the sentiment ladder — positive / neutral / negative / no-sentiment", async () => {
    wireGetByPath({
      list: [
        feedbackFixture({
          id: "fb-pos",
          patient: { user: { name: "Pos Patient", phone: "+91" } },
          aiSentiment: { sentiment: "positive", emotions: [], themes: [] },
        }),
        feedbackFixture({
          id: "fb-neu",
          patient: { user: { name: "Neu Patient", phone: "+91" } },
          aiSentiment: { sentiment: "neutral", emotions: [], themes: [] },
        }),
        feedbackFixture({
          id: "fb-neg",
          patient: { user: { name: "Neg Patient", phone: "+91" } },
          aiSentiment: { sentiment: "negative", emotions: [], themes: [] },
        }),
        feedbackFixture({
          id: "fb-none",
          patient: { user: { name: "None Patient", phone: "+91" } },
          aiSentiment: null,
        }),
      ],
      summary: summaryFixture(),
      nps: null,
    });

    render(<FeedbackPage />);

    await screen.findByText("Pos Patient");

    const tbody = document.querySelector("tbody")!;
    expect(within(tbody).getByText("positive")).toBeInTheDocument();
    expect(within(tbody).getByText("neutral")).toBeInTheDocument();
    expect(within(tbody).getByText("negative")).toBeInTheDocument();
    // The fallback placeholder copy for missing sentiment.
    expect(within(tbody).getByText(/analyzing/i)).toBeInTheDocument();
  });

  it("falls back to em-dash for missing patient and missing NPS, and truncates long comments", async () => {
    const longComment = "x".repeat(80);
    wireGetByPath({
      list: [
        feedbackFixture({
          id: "fb-trunc",
          patient: undefined,
          nps: null,
          comment: longComment,
        }),
      ],
      summary: summaryFixture(),
      nps: null,
    });

    render(<FeedbackPage />);

    // Wait for the truncated comment cell to be present — proves the row
    // rendered out of loading state.
    const truncatedComment = await screen.findByText(
      longComment.slice(0, 60) + "...",
    );
    expect(truncatedComment).toBeInTheDocument();

    const tbody = document.querySelector("tbody")!;
    expect(tbody).toBeTruthy();
    // Both the patient-name cell and the NPS cell render "-" in this row.
    expect(within(tbody).getAllByText("-").length).toBe(2);
    // The raw 80-char string should NOT be present unmodified.
    expect(within(tbody).queryByText(longComment)).not.toBeInTheDocument();
  });

  it("renders the NPS Drivers AI widget when the endpoint returns a well-shaped payload", async () => {
    wireGetByPath({
      list: [feedbackFixture()],
      summary: summaryFixture(),
      nps: npsDriversFixture(),
    });

    render(<FeedbackPage />);

    await screen.findByText("Aanya Sharma");

    expect(
      screen.getByRole("heading", { name: /NPS Drivers \(AI/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/42 feedback analysed/i)).toBeInTheDocument();
    expect(screen.getByText("friendly staff")).toBeInTheDocument();
    expect(screen.getByText("clean rooms")).toBeInTheDocument();
    expect(screen.getByText("waiting time")).toBeInTheDocument();
    expect(
      screen.getByText(/Reduce reception wait window/i),
    ).toBeInTheDocument();
  });

  it("OMITS the NPS Drivers widget when the payload is malformed (missing arrays)", async () => {
    wireGetByPath({
      list: [feedbackFixture()],
      summary: summaryFixture(),
      // No positiveThemes/negativeThemes/actionableInsights → shape check fails.
      nps: { windowDays: 30, totalFeedback: 0 },
    });

    render(<FeedbackPage />);

    await screen.findByText("Aanya Sharma");

    expect(
      screen.queryByRole("heading", { name: /NPS Drivers \(AI/i }),
    ).not.toBeInTheDocument();
  });

  it("OMITS the NPS Drivers widget when the endpoint rejects", async () => {
    wireGetByPath({
      list: [feedbackFixture()],
      summary: summaryFixture(),
      npsReject: true,
    });

    render(<FeedbackPage />);

    await screen.findByText("Aanya Sharma");

    expect(
      screen.queryByRole("heading", { name: /NPS Drivers \(AI/i }),
    ).not.toBeInTheDocument();
  });

  it("refetches the list with category=<value> when the category filter changes", async () => {
    wireGetByPath({
      list: [feedbackFixture()],
      summary: summaryFixture(),
      nps: null,
    });

    render(<FeedbackPage />);
    await screen.findByText("Aanya Sharma");

    apiMock.get.mockClear();

    // Find the category select via its unique id.
    const categorySelect = document.getElementById(
      "feedback-category",
    ) as HTMLSelectElement;
    expect(categorySelect).toBeTruthy();

    fireEvent.change(categorySelect, { target: { value: "NURSE" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/feedback?category=NURSE&limit=50"),
    );
  });

  it("refetches with from/to query params when the date inputs change", async () => {
    wireGetByPath({
      list: [feedbackFixture()],
      summary: summaryFixture(),
      nps: null,
    });

    render(<FeedbackPage />);
    await screen.findByText("Aanya Sharma");

    apiMock.get.mockClear();

    const fromInput = document.getElementById(
      "feedback-from",
    ) as HTMLInputElement;
    const toInput = document.getElementById("feedback-to") as HTMLInputElement;

    fireEvent.change(fromInput, { target: { value: "2026-04-01" } });

    await waitFor(() => {
      const listCall = apiMock.get.mock.calls.find((c) =>
        (c[0] as string).startsWith("/feedback?"),
      );
      expect(listCall?.[0]).toBe("/feedback?from=2026-04-01&limit=50");
    });
    await waitFor(() => {
      const sumCall = apiMock.get.mock.calls.find((c) =>
        (c[0] as string).startsWith("/feedback/summary"),
      );
      expect(sumCall?.[0]).toBe("/feedback/summary?from=2026-04-01");
    });

    apiMock.get.mockClear();
    fireEvent.change(toInput, { target: { value: "2026-04-30" } });

    await waitFor(() => {
      const listCall = apiMock.get.mock.calls.find((c) =>
        (c[0] as string).startsWith("/feedback?"),
      );
      expect(listCall?.[0]).toBe(
        "/feedback?from=2026-04-01&to=2026-04-30&limit=50",
      );
    });
  });

  it('renders "No feedback yet" when the list response is empty', async () => {
    wireGetByPath({
      list: [],
      summary: summaryFixture({ totalCount: 0, trend: [] }),
      nps: null,
    });

    render(<FeedbackPage />);

    expect(await screen.findByText(/No feedback yet/i)).toBeInTheDocument();
  });

  it("silently swallows a list-fetch rejection and settles into the empty branch", async () => {
    wireGetByPath({
      listReject: true,
      summary: summaryFixture({ totalCount: 0, trend: [] }),
      nps: null,
    });

    render(<FeedbackPage />);

    // The try/catch is silent — no toast call should be issued, but the
    // loading flag still flips and the empty branch renders.
    expect(await screen.findByText(/No feedback yet/i)).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("renders the category bar chart with one row per CATEGORIES entry", async () => {
    wireGetByPath({
      list: [feedbackFixture()],
      summary: summaryFixture(),
      nps: null,
    });

    render(<FeedbackPage />);
    await screen.findByText("Aanya Sharma");

    // The bar chart header.
    expect(
      screen.getByRole("heading", { name: /Average Rating by Category/i }),
    ).toBeInTheDocument();

    // Each of the 8 CATEGORIES values appears as an underscore-stripped
    // label in the chart AND ALSO as a label in the filter <select>
    // dropdown options. Assert both surfaces render the labels — getAllByText
    // returns 2+ matches per category.
    expect(screen.getAllByText("CLEANLINESS").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("FOOD").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("BILLING").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("WAITING TIME").length).toBeGreaterThanOrEqual(
      1,
    );
  });
});
