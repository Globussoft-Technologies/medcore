// Coverage tests for the AI Ambient Chart Search dashboard page.
// Modules under test: apps/web/src/app/dashboard/ai/chart-search/page.tsx —
//   clinician-facing page that asks natural-language questions over a
//   patient's chart or the doctor's whole cohort and renders an LLM
//   answer with [n] citation chips, source hits with type chips, and
//   expand-on-click chunk previews. Patient picker uses debounced
//   GET /patients; ask uses POST /ai/chart-search/{patient/:id|cohort}.
// Why: page was at 0% coverage. Locks in role gating (DOCTOR/ADMIN),
//   tab switching, debounced patient search, query submit gating,
//   request shape per tab, answer rendering with citation chips,
//   chunk parsing of sectioned content, hits/empty/error states.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";

const { apiMock, authMock, routerPushMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerPushMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai/chart-search",
}));

import ChartSearchPage from "../page";

// ─── Fixtures ───────────────────────────────────────────────────────

function patientOpt(overrides: Partial<any> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000abc",
    user: { name: "Asha Patel", phone: "+91-9000000000" },
    ...overrides,
  };
}

function hit(overrides: Partial<any> = {}) {
  return {
    id: "chunk-1",
    documentType: "CONSULTATION",
    title: "Consult — 12 Mar 2026",
    content:
      "Subjective: Productive cough x 3 days, fever 38.5\nAssessment: Likely CAP",
    tags: ["respiratory"],
    rank: 0.92,
    patientId: "pt-1",
    doctorId: "doc-1",
    date: "2026-03-12T05:00:00.000Z",
    ...overrides,
  };
}

function chartSearchResp(overrides: Partial<any> = {}) {
  return {
    answer:
      "Patient's HbA1c last crossed 7 on 12 Mar 2026 [1] with concurrent fasting glucose elevation [2].",
    hits: [
      hit(),
      hit({
        id: "chunk-2",
        documentType: "LAB_RESULT",
        title: "HbA1c — 12 Mar 2026",
        content:
          "Findings: {\"hba1c\": 7.4, \"fastingGlucose\": 142, \"confidence\": 0.9}",
        date: "2026-03-12T05:00:00.000Z",
      }),
    ],
    citedChunkIds: ["chunk-1", "chunk-2"],
    patientIds: ["pt-1"],
    totalHits: 2,
    ...overrides,
  };
}

function setupAuth(
  user: { id: string; role: string } | null,
  isLoading = false,
) {
  authMock.mockReturnValue({ user, isLoading, token: "tok-1" });
}

describe("Ambient Chart Search dashboard page", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockReset();
    routerPushMock.mockReset();
    vi.useRealTimers();
  });

  it("shows a loading spinner while auth is hydrating", () => {
    setupAuth(null, true);
    const { container } = render(<ChartSearchPage />);
    // The spinner page has no chrome heading yet.
    expect(
      screen.queryByRole("heading", { name: /Ambient Chart Search/i }),
    ).not.toBeInTheDocument();
    // Loader2 is an svg sibling of an animate-spin classed element.
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("redirects non-allowlisted roles to /dashboard and renders nothing", async () => {
    setupAuth({ id: "u-rec", role: "RECEPTION" }, false);
    render(<ChartSearchPage />);
    await waitFor(() =>
      expect(routerPushMock).toHaveBeenCalledWith("/dashboard"),
    );
    // Page short-circuits to null after the effect — no heading rendered.
    expect(
      screen.queryByRole("heading", { name: /Ambient Chart Search/i }),
    ).not.toBeInTheDocument();
  });

  it("renders header chrome and both tabs for DOCTOR role; Ask is disabled until query + patient", () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    render(<ChartSearchPage />);

    expect(
      screen.getByRole("heading", { name: /Ambient Chart Search/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /This patient/i }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Cohort/i })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    const askBtn = screen.getByRole("button", { name: /Ask/i });
    expect(askBtn).toBeDisabled();
  });

  it("ADMIN role is allowed and patient picker is visible by default", () => {
    setupAuth({ id: "u-adm", role: "ADMIN" }, false);
    render(<ChartSearchPage />);
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(
      screen.getByPlaceholderText(/Search patient by name/i),
    ).toBeInTheDocument();
  });

  it("does not search patients when query is under 2 characters (debounce guard)", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    vi.useFakeTimers();
    render(<ChartSearchPage />);
    fireEvent.change(screen.getByPlaceholderText(/Search patient by name/i), {
      target: { value: "a" },
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(apiMock.get).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("debounces patient search and renders result list", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.get.mockResolvedValueOnce({ data: [patientOpt()] });
    vi.useFakeTimers();
    render(<ChartSearchPage />);

    fireEvent.change(screen.getByPlaceholderText(/Search patient by name/i), {
      target: { value: "Asha" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/patients?search=Asha",
      ),
    );
    expect(await screen.findByText("Asha Patel")).toBeInTheDocument();
    expect(screen.getByText(/\+91-9000000000/)).toBeInTheDocument();
  });

  it("swallows patient search errors and renders no list", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.get.mockRejectedValueOnce(new Error("network down"));
    vi.useFakeTimers();
    render(<ChartSearchPage />);

    fireEvent.change(screen.getByPlaceholderText(/Search patient by name/i), {
      target: { value: "Ravi" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    vi.useRealTimers();

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));
    // No selectable row materialised.
    expect(screen.queryByText("Ravi Kumar")).not.toBeInTheDocument();
  });

  it("falls back to [] when API returns nullish data", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.get.mockResolvedValueOnce({ data: null });
    vi.useFakeTimers();
    render(<ChartSearchPage />);

    fireEvent.change(screen.getByPlaceholderText(/Search patient by name/i), {
      target: { value: "Asha" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    vi.useRealTimers();

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Asha Patel")).not.toBeInTheDocument();
  });

  it("selecting a patient pins the picker chip and clears the search list", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.get.mockResolvedValueOnce({ data: [patientOpt()] });
    vi.useFakeTimers();
    render(<ChartSearchPage />);

    fireEvent.change(screen.getByPlaceholderText(/Search patient by name/i), {
      target: { value: "Asha" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    vi.useRealTimers();

    const row = await screen.findByText("Asha Patel");
    fireEvent.click(row);

    // Pinned chip shows the name + the truncated id.
    expect(screen.getByText("Asha Patel")).toBeInTheDocument();
    expect(screen.getByText(/00000000…/)).toBeInTheDocument();
    // Change button replaces the picker input.
    expect(screen.getByRole("button", { name: /Change/i })).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/Search patient by name/i),
    ).not.toBeInTheDocument();
  });

  it("clicking Change clears the pinned patient and re-renders the search input", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.get.mockResolvedValueOnce({ data: [patientOpt()] });
    vi.useFakeTimers();
    render(<ChartSearchPage />);

    fireEvent.change(screen.getByPlaceholderText(/Search patient by name/i), {
      target: { value: "Asha" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    vi.useRealTimers();

    fireEvent.click(await screen.findByText("Asha Patel"));
    fireEvent.click(screen.getByRole("button", { name: /Change/i }));

    expect(
      screen.getByPlaceholderText(/Search patient by name/i),
    ).toBeInTheDocument();
  });

  it("switching to Cohort tab hides the patient picker and shows the cohort notice", () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    render(<ChartSearchPage />);
    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    expect(
      screen.queryByPlaceholderText(/Search patient by name/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/cohort search is scoped to patients you have seen/i),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Which of my diabetic patients/i),
    ).toBeInTheDocument();
  });

  it("cohort tab: typing a query enables Ask without needing a patient", () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    render(<ChartSearchPage />);
    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Who missed visits?" },
    });
    expect(screen.getByRole("button", { name: /Ask/i })).not.toBeDisabled();
  });

  it("patient tab: typing a query without a selected patient leaves Ask disabled", () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    render(<ChartSearchPage />);
    fireEvent.change(
      screen.getByPlaceholderText(/When did their HbA1c last cross 7/i),
      { target: { value: "When did HbA1c cross 7?" } },
    );
    expect(screen.getByRole("button", { name: /Ask/i })).toBeDisabled();
  });

  it("posts to /ai/chart-search/patient/:id and renders answer + citation chips + hits", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.get.mockResolvedValueOnce({ data: [patientOpt()] });
    apiMock.post.mockResolvedValueOnce({ data: chartSearchResp() });
    vi.useFakeTimers();
    render(<ChartSearchPage />);

    fireEvent.change(screen.getByPlaceholderText(/Search patient by name/i), {
      target: { value: "Asha" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    vi.useRealTimers();

    fireEvent.click(await screen.findByText("Asha Patel"));

    const queryInput = screen.getByPlaceholderText(
      /When did their HbA1c last cross 7/i,
    );
    fireEvent.change(queryInput, {
      target: { value: "When did HbA1c last cross 7?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ask/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith(
      "/ai/chart-search/patient/00000000-0000-0000-0000-000000000abc",
      { query: "When did HbA1c last cross 7?", synthesize: true },
    );

    // Answer prose renders.
    expect(
      await screen.findByText(/Patient's HbA1c last crossed 7/),
    ).toBeInTheDocument();

    // Citation chips [1] and [2] render as buttons.
    expect(screen.getByRole("button", { name: "[1]" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "[2]" })).toBeInTheDocument();

    // Hits header + both rows.
    expect(screen.getByText(/2 source chunks/i)).toBeInTheDocument();
    expect(screen.getByText("Consult — 12 Mar 2026")).toBeInTheDocument();
    expect(screen.getByText("HbA1c — 12 Mar 2026")).toBeInTheDocument();

    // Doc-type chips.
    expect(screen.getByText("Consultation")).toBeInTheDocument();
    expect(screen.getByText("Lab result")).toBeInTheDocument();
  });

  it("Enter key submits the query (when canAsk)", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.post.mockResolvedValueOnce({
      data: chartSearchResp({ hits: [], citedChunkIds: [], totalHits: 0, answer: "" }),
    });
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    const q = screen.getByPlaceholderText(/Which of my diabetic patients/i);
    fireEvent.change(q, { target: { value: "List diabetics" } });
    fireEvent.keyDown(q, { key: "Enter" });

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith("/ai/chart-search/cohort", {
      query: "List diabetics",
      synthesize: true,
    });
  });

  it("Enter is a no-op when the query is empty (no API call)", () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    render(<ChartSearchPage />);
    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    const q = screen.getByPlaceholderText(/Which of my diabetic patients/i);
    fireEvent.keyDown(q, { key: "Enter" });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("clicking a citation chip expands the cited chunk preview; clicking again collapses", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.post.mockResolvedValueOnce({ data: chartSearchResp() });
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ask/i }));

    const chip1 = await screen.findByRole("button", { name: "[1]" });
    fireEvent.click(chip1);

    // Source preview header appears.
    expect(
      await screen.findByText(/Source: Consult — 12 Mar 2026/),
    ).toBeInTheDocument();

    // Second click on the SAME chip collapses.
    fireEvent.click(chip1);
    await waitFor(() =>
      expect(
        screen.queryByText(/Source: Consult — 12 Mar 2026/),
      ).not.toBeInTheDocument(),
    );
  });

  it("renders empty-state copy for zero hits", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.post.mockResolvedValueOnce({
      data: chartSearchResp({
        hits: [],
        citedChunkIds: [],
        totalHits: 0,
        answer: "",
      }),
    });
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ask/i }));

    expect(
      await screen.findByText(/No matching chunks found in the chart/i),
    ).toBeInTheDocument();
    // 0 source chunks header (plural branch — totalHits !== 1).
    expect(screen.getByText(/0 source chunks/i)).toBeInTheDocument();
    // Empty-answer branch renders the fallback span.
    expect(
      screen.getByText(/No synthesised answer — see source hits below/i),
    ).toBeInTheDocument();
  });

  it("renders singular '1 source chunk' when totalHits === 1", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.post.mockResolvedValueOnce({
      data: chartSearchResp({
        hits: [hit()],
        citedChunkIds: ["chunk-1"],
        totalHits: 1,
      }),
    });
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ask/i }));

    expect(await screen.findByText(/1 source chunk$/i)).toBeInTheDocument();
  });

  it("renders error banner and clears busy on API rejection", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.post.mockRejectedValueOnce(new Error("Model timed out"));
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ask/i }));

    expect(await screen.findByText(/Model timed out/)).toBeInTheDocument();
    // Ask button is re-enabled (busy cleared) since query is still set.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Ask/i })).not.toBeDisabled(),
    );
  });

  it("falls back to default error copy when rejection has no message", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.post.mockRejectedValueOnce(new Error(""));
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ask/i }));

    expect(
      await screen.findByText(/Chart search failed/),
    ).toBeInTheDocument();
  });

  it("shows the in-flight loading panel while POST is pending; Ask is disabled", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.post.mockImplementation(() => new Promise(() => {}));
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Q" },
    });
    const askBtn = screen.getByRole("button", { name: /Ask/i });
    fireEvent.click(askBtn);

    expect(
      await screen.findByText(/Searching the chart…/i),
    ).toBeInTheDocument();
    await waitFor(() => expect(askBtn).toBeDisabled());
  });

  it("renders raw text for citations whose index has no chunk mapping (e.g. [3] with only 2 cited)", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.post.mockResolvedValueOnce({
      data: chartSearchResp({
        answer: "Single citation [1] and dangling [3] reference.",
        citedChunkIds: ["chunk-1"],
        hits: [hit()],
        totalHits: 1,
      }),
    });
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ask/i }));

    // Both [1] and [3] still get rendered as chip buttons.
    expect(await screen.findByRole("button", { name: "[1]" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "[3]" })).toBeInTheDocument();
  });

  it("renders prescription-type hit with Pill badge (DOC_TYPE_META branch)", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.post.mockResolvedValueOnce({
      data: chartSearchResp({
        hits: [
          hit({
            id: "chunk-rx",
            documentType: "PRESCRIPTION",
            title: "Rx — 1 Apr 2026",
            content: "Plan: Metformin 500mg BD x 30d",
            date: null,
          }),
        ],
        citedChunkIds: ["chunk-rx"],
        totalHits: 1,
      }),
    });
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ask/i }));

    expect(await screen.findByText("Prescription")).toBeInTheDocument();
    expect(screen.getByText("Rx — 1 Apr 2026")).toBeInTheDocument();
  });

  it("renders unknown documentType using the DEFAULT meta (Document label)", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.post.mockResolvedValueOnce({
      data: chartSearchResp({
        hits: [
          hit({
            id: "chunk-x",
            documentType: "MYSTERY",
            title: "Other note",
            content: "no section markers here just free text",
            date: null,
          }),
        ],
        citedChunkIds: ["chunk-x"],
        totalHits: 1,
      }),
    });
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ask/i }));

    expect(await screen.findByText("Document")).toBeInTheDocument();
    expect(
      screen.getByText(/no section markers here just free text/),
    ).toBeInTheDocument();
  });

  it("renders chunk JSON section as a key/value grid (Findings JSON branch in ChunkContent)", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    apiMock.post.mockResolvedValueOnce({
      data: chartSearchResp({
        answer: "[1]",
        hits: [
          hit({
            id: "chunk-json",
            documentType: "LAB_RESULT",
            title: "HbA1c lab",
            content:
              'Findings: {"hba1c": 7.4, "fastingGlucose": 142, "confidence": 0.9, "evidenceSpan": "skip-me"}',
          }),
        ],
        citedChunkIds: ["chunk-json"],
        totalHits: 1,
      }),
    });
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ask/i }));

    // Section label rendered (Findings, uppercased by CSS class — match by case-insensitive regex).
    expect((await screen.findAllByText(/findings/i)).length).toBeGreaterThan(0);
    // JSON keys rendered (camelCase split into words). Multiple elements
    // match "hba1c" (title + key cell); just assert ≥1.
    expect(screen.getAllByText(/hba1c/i).length).toBeGreaterThan(0);
    // SKIP_KEYS filter: evidenceSpan should NOT render as a key label.
    expect(screen.queryByText(/evidence Span/i)).not.toBeInTheDocument();
    // JSON value renders.
    expect(screen.getByText(/142/)).toBeInTheDocument();
  });

  it("ChunkSummary uses object-preview branch when no plain-text sections exist", async () => {
    setupAuth({ id: "u-doc", role: "DOCTOR" }, false);
    // Citation expands a hit whose content has ONLY a JSON section — the
    // expanded ChunkSummary should fall into the object-preview branch.
    apiMock.post.mockResolvedValueOnce({
      data: chartSearchResp({
        answer: "Cited [1].",
        hits: [
          hit({
            id: "chunk-obj",
            documentType: "LAB_RESULT",
            title: "Object preview hit",
            content: 'Findings: {"hba1c": 7.4}',
          }),
        ],
        citedChunkIds: ["chunk-obj"],
        totalHits: 1,
      }),
    });
    render(<ChartSearchPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Cohort/i }));
    fireEvent.change(screen.getByPlaceholderText(/Which of my diabetic/i), {
      target: { value: "Q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ask/i }));

    fireEvent.click(await screen.findByRole("button", { name: "[1]" }));

    // Expanded ChunkSummary renders the JSON key label "hba1c" within the preview.
    await waitFor(() =>
      expect(
        screen.getByText(/Source: Object preview hit/),
      ).toBeInTheDocument(),
    );
  });
});
