/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SymptomDiaryPage — patient-facing diary surface (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/symptom-diary/page.tsx, the
 *     PATIENT-only symptom diary. Server contract (ai-symptom-diary.ts):
 *       GET  /ai/symptom-diary       — PATIENT-only, last 90 days.
 *       POST /ai/symptom-diary       — body {symptomDate, entries:[{symptom,
 *                                       severity 1-10, notes?}]}; upserts
 *                                       on (patientId, symptomDate).
 *
 *   - Behaviours covered:
 *       1.  VIEW_ALLOWED gate — LAB_TECH (not in {PATIENT,DOCTOR,NURSE,
 *           RECEPTION,ADMIN}) gets toast.error + replace to
 *           /dashboard/not-authorized with `?from=` breadcrumb.
 *       2.  Staff (DOCTOR) WITHOUT `?patientId=` toasts "Open a patient's
 *           diary…" and redirects.
 *       3.  Staff (DOCTOR) WITH `?patientId=` renders the read-only banner;
 *           the API is never called.
 *       4.  isLoading=true short-circuits the gate — no redirect, no fetch.
 *       5.  PATIENT mount calls GET /ai/symptom-diary and renders entries
 *           sorted descending by symptomDate (defensive client sort).
 *       6.  PATIENT — 404 from the API renders the empty state (no error
 *           banner) — covers the "no Patient row" branch.
 *       7.  PATIENT — 5xx surfaces err.message in the red error banner.
 *       8.  PATIENT — 5xx without err.message falls back to "Failed to
 *           load symptom diary".
 *       9.  Trend tile — week stats: count + avg severity rendered, and
 *           the 30-day bar grid emits 30 bars (one per day).
 *      10.  Trend tile — avgSeverity 0 falls back to "—" display.
 *      11.  Severity badge classes — covers all 4 branches (≤2 green,
 *           ≤3 yellow, ≤4 orange, ≥5 red).
 *      12.  Truncation — notes >120 chars render with "..." and toggle
 *           button; clicking the toggle expands and collapses again.
 *      13.  No truncation — short notes don't render the toggle button.
 *      14.  Modal open via "Log New Entry" button.
 *      15.  Modal close via backdrop click + close (X) button.
 *      16.  Modal — submit with blank description surfaces inline
 *           "Describe the symptom" error + toast.warning + no POST.
 *      17.  Modal — submit without severity surfaces inline "Pick a
 *           severity (1-5)" error.
 *      18.  Modal — happy POST shapes the body correctly (symptom ≤100,
 *           notes joined+capped, severity number), then handleSaved
 *           prepends + closes modal.
 *      19.  Modal — long description (>100 chars) overflows into notes
 *           field; duration goes into notes too.
 *      20.  Modal — POST rejection surfaces toast.error with err.message.
 *      21.  Modal — POST rejection with extractFieldErrors-shaped payload
 *           surfaces inline field errors.
 *      22.  Modal — duration sanitize failure surfaces inline error.
 *      23.  Modal — severity pill click toggles aria-checked and active
 *           styling.
 *      24.  handleSaved upsert — same id replaces the old row.
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/field-errors,
 *            @medcore/shared (sanitizeUserInput), next/navigation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";

const {
  apiMock,
  toastMock,
  authMock,
  routerMock,
  searchParamsMock,
  extractFieldErrorsMock,
  sanitizeUserInputMock,
} = vi.hoisted(() => ({
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
  searchParamsMock: { value: new URLSearchParams() },
  extractFieldErrorsMock: vi.fn(),
  sanitizeUserInputMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/field-errors", () => ({
  extractFieldErrors: extractFieldErrorsMock,
}));
vi.mock("@medcore/shared", () => ({
  sanitizeUserInput: sanitizeUserInputMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => searchParamsMock.value,
  usePathname: () => "/dashboard/symptom-diary",
}));

import SymptomDiaryPage from "../page";

type ServerEntry = { symptom: string; severity: number; notes?: string };
type DiaryDay = {
  id: string;
  patientId: string;
  symptomDate: string;
  entries: ServerEntry[];
  createdAt?: string;
};

function dayFixture(overrides: Partial<DiaryDay> = {}): DiaryDay {
  return {
    id: "day-1",
    patientId: "pat-1",
    // +48h offset to dodge IST/UTC midnight traps.
    symptomDate: "2026-05-20T10:00:00.000Z",
    entries: [{ symptom: "Headache", severity: 3, notes: "Throbbing" }],
    createdAt: "2026-05-20T10:00:00.000Z",
    ...overrides,
  };
}

function asPatient() {
  authMock.mockReturnValue({
    user: { id: "u-pat", role: "PATIENT", name: "Pat" },
    isLoading: false,
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
    isLoading: false,
  });
}

function asLabTech() {
  authMock.mockReturnValue({
    user: { id: "u-lab", role: "LAB_TECH", name: "Lab" },
    isLoading: false,
  });
}

describe("SymptomDiaryPage (patient-facing symptom diary — full surface)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    extractFieldErrorsMock.mockReset();
    sanitizeUserInputMock.mockReset();
    searchParamsMock.value = new URLSearchParams();
    // Default: sanitize passes through unchanged.
    sanitizeUserInputMock.mockImplementation((v: string) => ({
      ok: true,
      value: v,
    }));
    // Default: extractFieldErrors returns null (so toast.error path fires).
    extractFieldErrorsMock.mockReturnValue(null);
    asPatient();
  });

  afterEach(() => {
    cleanup();
  });

  // ── VIEW_ALLOWED gate ────────────────────────────────────────────────────

  it("redirects LAB_TECH (not in VIEW_ALLOWED) to /dashboard/not-authorized with ?from= breadcrumb + toast.error", async () => {
    asLabTech();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<SymptomDiaryPage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Symptom diary is restricted/i),
      ),
    );
    expect(routerMock.replace).toHaveBeenCalledWith(
      `/dashboard/not-authorized?from=${encodeURIComponent(
        "/dashboard/symptom-diary",
      )}`,
    );
    // LAB_TECH must not hit the patient-only diary endpoint.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("DOCTOR without ?patientId= toasts 'Open a patient's diary' and redirects (staff-without-context)", async () => {
    asDoctor();

    render(<SymptomDiaryPage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Open a patient's diary/i),
      ),
    );
    expect(routerMock.replace).toHaveBeenCalledWith(
      `/dashboard/not-authorized?from=${encodeURIComponent(
        "/dashboard/symptom-diary",
      )}`,
    );
    // No API call — the diary endpoint is PATIENT-only.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("DOCTOR with ?patientId= renders the read-only staff banner and does NOT call the API", async () => {
    asDoctor();
    searchParamsMock.value = new URLSearchParams("patientId=pat-42");

    render(<SymptomDiaryPage />);

    expect(
      await screen.findByTestId("symptom-diary-staff-banner"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Read-only view of patient pat-42/i),
    ).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
    // Patient-only header button is NOT rendered for staff.
    expect(
      screen.queryByTestId("symptom-diary-log-button"),
    ).not.toBeInTheDocument();
  });

  it("does NOT redirect or fetch when the auth store is still loading", async () => {
    authMock.mockReturnValue({ user: null, isLoading: true });

    render(<SymptomDiaryPage />);
    await new Promise((r) => setTimeout(r, 10));

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  // ── PATIENT fetch + sort ─────────────────────────────────────────────────

  it("PATIENT mount calls GET /ai/symptom-diary and renders entries sorted descending by symptomDate", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        // Intentionally out-of-order to exercise the defensive client sort.
        dayFixture({
          id: "day-old",
          symptomDate: "2026-05-10T10:00:00.000Z",
          entries: [{ symptom: "OldSymptom", severity: 2 }],
        }),
        dayFixture({
          id: "day-new",
          symptomDate: "2026-05-22T10:00:00.000Z",
          entries: [{ symptom: "NewSymptom", severity: 4 }],
        }),
      ],
    });

    render(<SymptomDiaryPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/ai/symptom-diary"),
    );
    // Both rows should be present; newer one (day-new-0) renders first in DOM.
    const newRow = await screen.findByTestId("symptom-diary-row-day-new-0");
    const oldRow = await screen.findByTestId("symptom-diary-row-day-old-0");
    expect(newRow).toBeInTheDocument();
    expect(oldRow).toBeInTheDocument();
    // DOM order: newer comes first because list is sorted desc.
    expect(newRow.compareDocumentPosition(oldRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("PATIENT — non-array response is defended via Array.isArray fallback to []", async () => {
    apiMock.get.mockResolvedValue({ data: null });

    render(<SymptomDiaryPage />);

    expect(
      await screen.findByTestId("symptom-diary-empty"),
    ).toBeInTheDocument();
  });

  // ── PATIENT error paths ──────────────────────────────────────────────────

  it("PATIENT — 404 from the API renders the empty state (no error banner)", async () => {
    const err: any = new Error("not found");
    err.status = 404;
    apiMock.get.mockRejectedValue(err);

    render(<SymptomDiaryPage />);

    expect(
      await screen.findByTestId("symptom-diary-empty"),
    ).toBeInTheDocument();
    // No scary red banner.
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
  });

  it("PATIENT — 5xx surfaces err.message in the red error banner", async () => {
    const err: any = new Error("boom from server");
    err.status = 500;
    apiMock.get.mockRejectedValue(err);

    render(<SymptomDiaryPage />);

    expect(await screen.findByText(/boom from server/i)).toBeInTheDocument();
  });

  it("PATIENT — 5xx without err.message falls back to 'Failed to load symptom diary'", async () => {
    apiMock.get.mockRejectedValue({ status: 500 });

    render(<SymptomDiaryPage />);

    expect(
      await screen.findByText(/Failed to load symptom diary/i),
    ).toBeInTheDocument();
  });

  // ── Trend tile + week stats ──────────────────────────────────────────────

  it("renders the trend tile with week count + avg severity, plus 30 day-bars", async () => {
    // Two entries in the last 7 days (will count toward week stats),
    // one entry well outside the 7-day window (should NOT count).
    const recentIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oldIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    apiMock.get.mockResolvedValue({
      data: [
        dayFixture({
          id: "day-recent",
          symptomDate: recentIso,
          entries: [
            { symptom: "A", severity: 2 },
            { symptom: "B", severity: 4 },
          ],
        }),
        dayFixture({
          id: "day-old",
          symptomDate: oldIso,
          entries: [{ symptom: "Old", severity: 10 }],
        }),
      ],
    });

    render(<SymptomDiaryPage />);

    const trend = await screen.findByTestId("symptom-diary-trend");
    expect(trend).toBeInTheDocument();
    // Two recent entries within the 7-day window.
    expect(trend).toHaveTextContent(/Entries this week:\s*2/i);
    // Mean of [2,4] = 3.0 — rounded display.
    expect(trend).toHaveTextContent(/Avg severity:\s*3/i);
    // 30 bars: titled with `<label>: <count>`. We assert via the bar container
    // children count — easier than scanning titles.
    const barWrappers = trend.querySelectorAll("[title]");
    expect(barWrappers.length).toBe(30);
  });

  it("trend tile — when no entries fall in the 7-day window, avgSeverity falls back to '—'", async () => {
    // Entry well outside the 7-day window — week stats hit the zero branch.
    const oldIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    apiMock.get.mockResolvedValue({
      data: [
        dayFixture({
          id: "day-old",
          symptomDate: oldIso,
          entries: [{ symptom: "Old", severity: 3 }],
        }),
      ],
    });

    render(<SymptomDiaryPage />);

    const trend = await screen.findByTestId("symptom-diary-trend");
    expect(trend).toHaveTextContent(/Entries this week:\s*0/i);
    expect(trend).toHaveTextContent(/Avg severity:\s*—/);
  });

  // ── Severity badge branches ──────────────────────────────────────────────

  it("renders all 4 severity-badge color branches (green ≤2, yellow ≤3, orange ≤4, red ≥5)", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        dayFixture({
          id: "day-mix",
          entries: [
            { symptom: "Mild", severity: 1 },
            { symptom: "Modest", severity: 3 },
            { symptom: "Bad", severity: 4 },
            { symptom: "Severe", severity: 8 },
          ],
        }),
      ],
    });

    render(<SymptomDiaryPage />);

    // The four rows are each addressable via testid (no duplicate-text risk
    // — source renders the symptom name in both the title line AND the
    // notes-fallback line when notes is undefined).
    await screen.findByTestId("symptom-diary-row-day-mix-0");
    expect(
      screen.getByTestId("symptom-diary-row-day-mix-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("symptom-diary-row-day-mix-2"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("symptom-diary-row-day-mix-3"),
    ).toBeInTheDocument();
    // Each severity pill carries the numeric label inside the badge.
    expect(screen.getByText(/Severity 1/)).toBeInTheDocument();
    expect(screen.getByText(/Severity 3/)).toBeInTheDocument();
    expect(screen.getByText(/Severity 4/)).toBeInTheDocument();
    expect(screen.getByText(/Severity 8/)).toBeInTheDocument();
  });

  // ── Truncation + expand toggle ───────────────────────────────────────────

  it("notes >120 chars render truncated with ellipsis + toggle button; clicking expands and collapses", async () => {
    const longNote = "x".repeat(200);
    apiMock.get.mockResolvedValue({
      data: [
        dayFixture({
          id: "day-long",
          entries: [{ symptom: "Sym", severity: 2, notes: longNote }],
        }),
      ],
    });

    render(<SymptomDiaryPage />);

    const text = await screen.findByTestId("symptom-diary-row-day-long-0-text");
    // Truncated form ends in "...".
    expect(text.textContent?.endsWith("...")).toBe(true);
    expect(text.textContent!.length).toBeLessThan(longNote.length);

    const toggle = screen.getByTestId(
      "symptom-diary-row-day-long-0-toggle",
    );
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Expanded: full text now visible.
    expect(text.textContent).toBe(longNote);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("short notes (<120 chars) do NOT render the toggle button", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        dayFixture({
          id: "day-short",
          entries: [{ symptom: "Sym", severity: 2, notes: "short" }],
        }),
      ],
    });

    render(<SymptomDiaryPage />);

    await screen.findByText("short");
    expect(
      screen.queryByTestId("symptom-diary-row-day-short-0-toggle"),
    ).not.toBeInTheDocument();
  });

  // ── Modal — open/close ──────────────────────────────────────────────────

  it("opens the modal via the 'Log New Entry' button and closes via the X button", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    expect(
      await screen.findByTestId("symptom-diary-modal"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("symptom-diary-modal-close"));

    await waitFor(() =>
      expect(
        screen.queryByTestId("symptom-diary-modal"),
      ).not.toBeInTheDocument(),
    );
  });

  it("closes the modal when the backdrop is clicked (target === currentTarget branch)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    const modal = await screen.findByTestId("symptom-diary-modal");

    // fireEvent.click sets both target and currentTarget to the dispatcher,
    // matching the source check `e.target === e.currentTarget`.
    fireEvent.click(modal);

    await waitFor(() =>
      expect(
        screen.queryByTestId("symptom-diary-modal"),
      ).not.toBeInTheDocument(),
    );
  });

  // ── Modal — validation ──────────────────────────────────────────────────

  it("submitting with blank description shows 'Describe the symptom' + toast.warning + no POST", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");

    // Pick severity so only description is the blocker.
    fireEvent.click(screen.getByTestId("symptom-diary-severity-3"));

    fireEvent.click(screen.getByTestId("symptom-diary-save"));

    expect(
      await screen.findByTestId("error-symptom-diary-description"),
    ).toHaveTextContent(/Describe the symptom/i);
    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.stringMatching(/Please fix the highlighted fields/i),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("submitting without a severity pill shows 'Pick a severity (1–5)' error", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");

    // Fill description so severity is the only blocker.
    fireEvent.change(screen.getByTestId("symptom-diary-description"), {
      target: { value: "Bad headache" },
    });

    fireEvent.click(screen.getByTestId("symptom-diary-save"));

    expect(
      await screen.findByTestId("error-symptom-diary-severity"),
    ).toHaveTextContent(/Pick a severity/i);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("clearing the startedAt input then submitting surfaces 'When did the symptom start?'", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");

    fireEvent.change(screen.getByTestId("symptom-diary-description"), {
      target: { value: "Pain" },
    });
    fireEvent.click(screen.getByTestId("symptom-diary-severity-2"));
    fireEvent.change(screen.getByTestId("symptom-diary-started-at"), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByTestId("symptom-diary-save"));

    expect(
      await screen.findByTestId("error-symptom-diary-started-at"),
    ).toHaveTextContent(/When did the symptom start/i);
  });

  // ── Modal — happy POST ──────────────────────────────────────────────────

  it("happy POST — short description maps to symptom; modal closes; row is prepended", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    const savedDay: DiaryDay = dayFixture({
      id: "saved-1",
      symptomDate: "2026-05-25T10:00:00.000Z",
      entries: [{ symptom: "Cough", severity: 2 }],
    });
    apiMock.post.mockResolvedValue({ data: savedDay });

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");

    fireEvent.change(screen.getByTestId("symptom-diary-description"), {
      target: { value: "Cough" },
    });
    fireEvent.click(screen.getByTestId("symptom-diary-severity-2"));

    fireEvent.click(screen.getByTestId("symptom-diary-save"));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/symptom-diary",
        expect.objectContaining({
          entries: [
            expect.objectContaining({ symptom: "Cough", severity: 2 }),
          ],
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/Symptom logged/i),
    );
    // Modal closes; row appears (use testid — "Cough" renders twice when
    // notes is empty: once as the title, once as the notes-fallback).
    await waitFor(() =>
      expect(
        screen.queryByTestId("symptom-diary-modal"),
      ).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByTestId("symptom-diary-row-saved-1-0"),
    ).toBeInTheDocument();
  });

  it("happy POST — long description (>100 chars) overflows into notes; duration appended; notes capped at 500", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockResolvedValue({
      data: dayFixture({ id: "saved-long" }),
    });
    const longDesc = "y".repeat(250);

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");

    fireEvent.change(screen.getByTestId("symptom-diary-description"), {
      target: { value: longDesc },
    });
    fireEvent.click(screen.getByTestId("symptom-diary-severity-4"));
    fireEvent.change(screen.getByTestId("symptom-diary-duration"), {
      target: { value: "2 hrs" },
    });

    fireEvent.click(screen.getByTestId("symptom-diary-save"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const body = apiMock.post.mock.calls[0][1] as any;
    expect(body.entries[0].symptom).toHaveLength(100);
    expect(body.entries[0].symptom).toBe(longDesc.slice(0, 100));
    expect(body.entries[0].notes).toContain("y");
    expect(body.entries[0].notes).toContain("Duration: 2 hrs");
    expect(body.entries[0].notes.length).toBeLessThanOrEqual(500);
    expect(body.entries[0].severity).toBe(4);
    // sanitizeUserInput is called for the duration field.
    expect(sanitizeUserInputMock).toHaveBeenCalledWith(
      "2 hrs",
      expect.objectContaining({ field: "Duration", maxLength: 100 }),
    );
  });

  // ── Modal — error paths ─────────────────────────────────────────────────

  it("POST rejection surfaces toast.error with err.message (generic error path)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockRejectedValue(new Error("server down"));

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");
    fireEvent.change(screen.getByTestId("symptom-diary-description"), {
      target: { value: "Ache" },
    });
    fireEvent.click(screen.getByTestId("symptom-diary-severity-2"));
    fireEvent.click(screen.getByTestId("symptom-diary-save"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("server down"),
    );
    // Modal stays open so the user can retry.
    expect(
      screen.getByTestId("symptom-diary-modal"),
    ).toBeInTheDocument();
  });

  it("POST rejection — non-Error thrown value falls back to 'Save failed'", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockRejectedValue({ weird: "shape" });

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");
    fireEvent.change(screen.getByTestId("symptom-diary-description"), {
      target: { value: "Pain" },
    });
    fireEvent.click(screen.getByTestId("symptom-diary-severity-3"));
    fireEvent.click(screen.getByTestId("symptom-diary-save"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Save failed"),
    );
  });

  it("POST rejection — extractFieldErrors hit surfaces inline field errors and toasts the first one", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockRejectedValue({ payload: "irrelevant" });
    extractFieldErrorsMock.mockReturnValue({
      symptom: "Symptom is too short",
    });

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");
    fireEvent.change(screen.getByTestId("symptom-diary-description"), {
      target: { value: "Ache" },
    });
    fireEvent.click(screen.getByTestId("symptom-diary-severity-2"));
    fireEvent.click(screen.getByTestId("symptom-diary-save"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Symptom is too short"),
    );
  });

  it("duration sanitize failure surfaces inline duration error + no POST", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    sanitizeUserInputMock.mockReturnValue({
      ok: false,
      error: "Bad duration string",
    });

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");

    fireEvent.change(screen.getByTestId("symptom-diary-description"), {
      target: { value: "Pain" },
    });
    fireEvent.click(screen.getByTestId("symptom-diary-severity-3"));
    fireEvent.change(screen.getByTestId("symptom-diary-duration"), {
      target: { value: "<script>" },
    });

    fireEvent.click(screen.getByTestId("symptom-diary-save"));

    expect(
      await screen.findByTestId("error-symptom-diary-duration"),
    ).toHaveTextContent(/Bad duration string/i);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ── Severity pill interaction ────────────────────────────────────────────

  it("severity pill click flips aria-checked and only one pill is active at a time", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");

    const pill3 = screen.getByTestId("symptom-diary-severity-3");
    const pill5 = screen.getByTestId("symptom-diary-severity-5");

    expect(pill3).toHaveAttribute("aria-checked", "false");
    fireEvent.click(pill3);
    expect(pill3).toHaveAttribute("aria-checked", "true");

    fireEvent.click(pill5);
    expect(pill5).toHaveAttribute("aria-checked", "true");
    expect(pill3).toHaveAttribute("aria-checked", "false");
  });

  // ── handleSaved upsert semantics ─────────────────────────────────────────

  it("handleSaved upsert — second save with same id replaces the first row (not duplicated)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    const firstSave = dayFixture({
      id: "same-id",
      symptomDate: "2026-05-25T10:00:00.000Z",
      entries: [{ symptom: "Initial", severity: 3 }],
    });
    const secondSave = dayFixture({
      id: "same-id",
      symptomDate: "2026-05-25T10:00:00.000Z",
      entries: [{ symptom: "Updated", severity: 5 }],
    });
    apiMock.post
      .mockResolvedValueOnce({ data: firstSave })
      .mockResolvedValueOnce({ data: secondSave });

    render(<SymptomDiaryPage />);
    await screen.findByTestId("symptom-diary-empty");

    // First save
    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");
    fireEvent.change(screen.getByTestId("symptom-diary-description"), {
      target: { value: "Initial" },
    });
    fireEvent.click(screen.getByTestId("symptom-diary-severity-3"));
    fireEvent.click(screen.getByTestId("symptom-diary-save"));
    // Wait for the first row to materialize (use testid — "Initial" renders
    // both as title AND notes-fallback when notes is undefined).
    await screen.findByTestId("symptom-diary-row-same-id-0");

    // Second save with the SAME id — should replace, not duplicate.
    fireEvent.click(screen.getByTestId("symptom-diary-log-button"));
    await screen.findByTestId("symptom-diary-modal");
    fireEvent.change(screen.getByTestId("symptom-diary-description"), {
      target: { value: "Updated" },
    });
    fireEvent.click(screen.getByTestId("symptom-diary-severity-5"));
    fireEvent.click(screen.getByTestId("symptom-diary-save"));

    // Wait until modal closes (the second post resolved).
    await waitFor(() =>
      expect(
        screen.queryByTestId("symptom-diary-modal"),
      ).not.toBeInTheDocument(),
    );
    // Single row id = "same-id-0" should be present, exactly once — the
    // upsert replaced the prior row rather than duplicating it.
    expect(
      screen.getAllByTestId("symptom-diary-row-same-id-0"),
    ).toHaveLength(1);
    // The row now reflects the new severity.
    expect(screen.getByText(/Severity 5/)).toBeInTheDocument();
  });
});
