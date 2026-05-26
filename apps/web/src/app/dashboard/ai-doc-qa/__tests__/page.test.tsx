// Coverage tests for the Clinical Documentation QA dashboard page.
// Modules under test: apps/web/src/app/dashboard/ai-doc-qa/page.tsx —
//   ADMIN-only page that fetches /ai/doc-qa/reports?limit=50 on mount,
//   renders a SkeletonTable while loading, rows of audit reports (with
//   color-coded scores) in the happy path, an empty-state copy when the
//   list is empty, a "Run Sample Audit" button that POSTs to
//   /ai/doc-qa/run-sample and refetches, and a side detail panel that
//   surfaces sub-scores, issues + recommendations when a row is clicked.
// Why: page was at 0% coverage at the canonical co-located path
//   (a smoke spec lives at dashboard/__tests__/ai-doc-qa.page.test.tsx
//   but doesn't exercise run-sample, the detail panel, 503 hint, or the
//   loading skeleton). These assertions lock in the rendered surface so
//   future refactors can't silently break it.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiGetMock, apiPostMock, authMock, toastSuccessMock, toastErrorMock } =
  vi.hoisted(() => ({
    apiGetMock: vi.fn(),
    apiPostMock: vi.fn(),
    authMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    toastErrorMock: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai-doc-qa",
}));

import AiDocQaPage from "../page";

function asAdmin() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u-admin", name: "Admin", email: "admin@x.com", role: "ADMIN" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asDoctor() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u-doc", name: "Doc", email: "doc@x.com", role: "DOCTOR" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function report(overrides: Partial<any> = {}) {
  return {
    consultationId: "abcdef1234567890aaaa",
    score: 85,
    completenessScore: 90,
    icdAccuracyScore: 80,
    medicationScore: 88,
    clarityScore: 85,
    issues: [],
    recommendations: [],
    auditedAt: "2026-05-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("Clinical Documentation QA dashboard page", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    authMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("renders the SkeletonTable while /ai/doc-qa/reports is pending", async () => {
    asAdmin();
    apiGetMock.mockImplementation(() => new Promise(() => {}));
    render(<AiDocQaPage />);

    // The aria-busy wrapper is the canonical loading testid.
    await waitFor(() =>
      expect(screen.getByTestId("ai-doc-qa-loading")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("ai-doc-qa-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );

    // Header chrome is rendered regardless of fetch state.
    expect(
      screen.getByRole("heading", { name: /Clinical Documentation QA/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Run Sample Audit/i }),
    ).toBeInTheDocument();
  });

  it("fetches reports and renders one row per result with truncated id + score", async () => {
    asAdmin();
    apiGetMock.mockResolvedValue({
      data: [
        report({
          consultationId: "aaaaaaaa11111111bbbb",
          score: 92,
          issues: [{ category: "ICD", severity: "low", description: "x" }],
          auditedAt: "2026-05-20T10:00:00.000Z",
        }),
        report({
          consultationId: "ccccccccdddddddd2222",
          score: 55,
          issues: [],
          auditedAt: "2026-05-21T10:00:00.000Z",
        }),
      ],
    });

    render(<AiDocQaPage />);

    const rows = await screen.findAllByTestId("docqa-report-row");
    expect(rows).toHaveLength(2);

    // API contract — exact endpoint + querystring.
    expect(apiGetMock).toHaveBeenCalledWith("/ai/doc-qa/reports?limit=50");

    // Scores rendered.
    expect(screen.getByText("92")).toBeInTheDocument();
    expect(screen.getByText("55")).toBeInTheDocument();

    // Consultation IDs are truncated to the first 8 chars (followed by an
    // ellipsis character).
    expect(screen.getByText(/aaaaaaaa/)).toBeInTheDocument();
    expect(screen.getByText(/cccccccc/)).toBeInTheDocument();

    // Issues count column.
    const issueCells = rows.map((r) =>
      r.querySelectorAll("td")[3]?.textContent?.trim(),
    );
    expect(issueCells).toEqual(["1", "0"]);
  });

  it("renders the empty-state copy when the API returns an empty list", async () => {
    asAdmin();
    apiGetMock.mockResolvedValue({ data: [] });
    render(<AiDocQaPage />);

    expect(
      await screen.findByText(/No reports yet\. Click "Run Sample Audit"/i),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId("docqa-report-row")).toHaveLength(0);
  });

  it("surfaces a 503 deferred-migration hint when reports endpoint returns 503", async () => {
    asAdmin();
    apiGetMock.mockRejectedValue({ status: 503, message: "Not migrated" });
    render(<AiDocQaPage />);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringMatching(/DocQAReport model not yet migrated/i),
      ),
    );
    // Falls through to empty state.
    expect(
      await screen.findByText(/No reports yet\./i),
    ).toBeInTheDocument();
  });

  it("surfaces a generic error toast when the load fails with a non-503 error", async () => {
    asAdmin();
    apiGetMock.mockRejectedValue({ status: 500, message: "boom" });
    render(<AiDocQaPage />);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("boom"),
    );
  });

  it("falls back to the default error copy when rejection has no message", async () => {
    asAdmin();
    apiGetMock.mockRejectedValue({});
    render(<AiDocQaPage />);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Failed to load reports"),
    );
  });

  it("renders the admin-only gate for non-ADMIN roles and never fetches reports", async () => {
    asDoctor();
    render(<AiDocQaPage />);

    expect(
      await screen.findByText(/Admin only — documentation QA reports/i),
    ).toBeInTheDocument();

    // useEffect short-circuits when role !== ADMIN.
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("opens the detail panel with sub-scores when a report row is clicked", async () => {
    asAdmin();
    apiGetMock.mockResolvedValue({
      data: [
        report({
          consultationId: "row1aaaa11111111zzzz",
          score: 76,
          completenessScore: 80,
          icdAccuracyScore: 70,
          medicationScore: 75,
          clarityScore: 78,
          issues: [
            {
              category: "ICD",
              severity: "high",
              description: "Missing diagnosis code",
            },
          ],
          recommendations: ["Document chief complaint", "Add ICD-10 codes"],
        }),
      ],
    });

    render(<AiDocQaPage />);

    // Initial detail-panel placeholder.
    expect(
      screen.getByText(/Select a report to see detail\./i),
    ).toBeInTheDocument();

    const row = await screen.findByTestId("docqa-report-row");
    fireEvent.click(row);

    const detail = screen.getByTestId("docqa-detail");

    // Overall score rendered large in the detail panel (76 also appears in
    // the row, so scope to the detail panel for the assertion).
    expect(detail).toHaveTextContent("76");

    // Sub-score labels.
    expect(detail).toHaveTextContent(/Completeness/);
    expect(detail).toHaveTextContent(/ICD/);
    expect(detail).toHaveTextContent(/Medication/);
    expect(detail).toHaveTextContent(/Clarity/);

    // Sub-score values.
    expect(detail).toHaveTextContent("80");
    expect(detail).toHaveTextContent("70");
    expect(detail).toHaveTextContent("75");
    expect(detail).toHaveTextContent("78");

    // Issues list.
    expect(detail).toHaveTextContent(/Missing diagnosis code/);
    expect(detail).toHaveTextContent(/\[ICD \/ high\]/);

    // Recommendations list.
    expect(detail).toHaveTextContent(/Document chief complaint/);
    expect(detail).toHaveTextContent(/Add ICD-10 codes/);

    // Placeholder cleared once a report is selected.
    expect(
      screen.queryByText(/Select a report to see detail\./i),
    ).not.toBeInTheDocument();
  });

  it("renders the em-dash placeholder for missing sub-scores", async () => {
    asAdmin();
    apiGetMock.mockResolvedValue({
      data: [
        report({
          consultationId: "rowNoSubs1111111zzzz",
          score: 50,
          completenessScore: undefined,
          icdAccuracyScore: undefined,
          medicationScore: undefined,
          clarityScore: undefined,
          issues: [],
          recommendations: [],
        }),
      ],
    });

    render(<AiDocQaPage />);
    fireEvent.click(await screen.findByTestId("docqa-report-row"));

    const detail = screen.getByTestId("docqa-detail");
    // 4 sub-score cells all show — (em-dash).
    const dashes = detail.textContent?.match(/—/g) || [];
    expect(dashes.length).toBeGreaterThanOrEqual(4);
  });

  it("runs a sample audit, toasts the result counts and refetches", async () => {
    asAdmin();
    // Always return empty on every GET until the post-run refetch — the
    // useEffect dep on `user` object identity can cause >1 initial fetch
    // on re-render. The post-run refetch behaviour is what we assert here:
    // call-count strictly increases after the button click.
    apiGetMock.mockResolvedValue({ data: [] });
    apiPostMock.mockResolvedValueOnce({
      data: { sampled: 12, audited: 11 },
    });

    render(<AiDocQaPage />);

    // Wait for initial fetch(es) to settle (empty state).
    await screen.findByText(/No reports yet\./i);
    const initialGetCalls = apiGetMock.mock.calls.length;

    // Switch the GET to return a populated list for the post-run refetch.
    apiGetMock.mockResolvedValue({
      data: [report({ consultationId: "post-refetch11111zzz" })],
    });

    fireEvent.click(screen.getByRole("button", { name: /Run Sample Audit/i }));

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith("/ai/doc-qa/run-sample", {
        samplePct: 10,
        windowDays: 7,
      }),
    );
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "Sampled 12 consultations, audited 11",
      ),
    );

    // Refetch happened — strictly more GET calls than before the click.
    await waitFor(() =>
      expect(apiGetMock.mock.calls.length).toBeGreaterThan(initialGetCalls),
    );

    // New row surfaces after refetch.
    expect(await screen.findByTestId("docqa-report-row")).toBeInTheDocument();
  });

  it("surfaces an error toast when run-sample rejects", async () => {
    asAdmin();
    apiGetMock.mockResolvedValue({ data: [] });
    apiPostMock.mockRejectedValueOnce({ message: "Quota exceeded" });

    render(<AiDocQaPage />);
    await screen.findByText(/No reports yet\./i);

    fireEvent.click(screen.getByRole("button", { name: /Run Sample Audit/i }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Quota exceeded"),
    );
    // Toast.success NOT called on rejection.
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("falls back to the default copy when run-sample rejects without a message", async () => {
    asAdmin();
    apiGetMock.mockResolvedValueOnce({ data: [] });
    apiPostMock.mockRejectedValueOnce({});

    render(<AiDocQaPage />);
    await screen.findByText(/No reports yet\./i);

    fireEvent.click(screen.getByRole("button", { name: /Run Sample Audit/i }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Sample run failed"),
    );
  });

  it("disables the Run Sample Audit button while the POST is in flight", async () => {
    asAdmin();
    apiGetMock.mockResolvedValueOnce({ data: [] });
    apiPostMock.mockImplementation(() => new Promise(() => {}));

    render(<AiDocQaPage />);
    await screen.findByText(/No reports yet\./i);

    const btn = screen.getByRole("button", { name: /Run Sample Audit/i });
    expect(btn).not.toBeDisabled();

    fireEvent.click(btn);

    await waitFor(() => expect(btn).toBeDisabled());
  });
});
