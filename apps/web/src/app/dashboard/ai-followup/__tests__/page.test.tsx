// Coverage tests for the Smart Follow-up Suggestions dashboard page.
// Modules under test: apps/web/src/app/dashboard/ai-followup/page.tsx —
//   fetches /ai/followup/consultations on mount, renders a loading spinner,
//   per-consultation rows with a "Suggest follow-up" button that POSTs to
//   /ai/followup/suggest/:cid, and a "Book" button that POSTs to
//   /ai/followup/:cid/book and reloads the list.
// Why: page was at 0% coverage; these assertions lock in the rendered
// surface (loading, happy fetch with sequence rendering, empty, error,
// suggest, book, refresh) so future refactors can't silently break it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiGetMock, apiPostMock, toastSuccessMock, toastErrorMock } = vi.hoisted(
  () => ({
    apiGetMock: vi.fn(),
    apiPostMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    toastErrorMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import AIFollowupPage from "../page";

// Row fixture factory — keeps assertions terse and intent-revealing.
function row(overrides: Partial<any> = {}) {
  return {
    id: "consult-abcdef1234567890",
    appointmentId: "appt-1",
    notes: "Follow up in 2 weeks",
    doctor: { user: { name: "Rajesh Sharma" } },
    appointment: {
      patient: {
        id: "pat-1",
        mrNumber: "MR-001",
        user: { name: "Asha Patel" },
      },
    },
    ...overrides,
  };
}

function getOk<T>(data: T) {
  return { success: true, data, error: null };
}

describe("Smart Follow-up Suggestions dashboard page", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("shows a skeleton while /ai/followup/consultations is pending", async () => {
    apiGetMock.mockImplementation(() => new Promise(() => {}));
    render(<AIFollowupPage />);

    // Loading now renders the shared Skeleton kit (.mc-skeleton) instead of a
    // Loader2 spinner.
    await waitFor(() =>
      expect(document.querySelector(".mc-skeleton")).toBeInTheDocument(),
    );

    // Header chrome is rendered regardless of fetch state.
    expect(
      screen.getByRole("heading", { name: /Smart Follow-up Suggestions/i }),
    ).toBeInTheDocument();
  });

  it("fetches consultations and renders a row per result with patient + doctor metadata", async () => {
    apiGetMock.mockResolvedValue(
      getOk({
        consultations: [
          row({
            id: "abcd1234-aaaaaaaa00000001",
            appointment: {
              patient: {
                id: "pat-1",
                mrNumber: "MR-001",
                user: { name: "Asha Patel" },
              },
            },
            doctor: { user: { name: "Rajesh Sharma" } },
          }),
          row({
            id: "wxyz5678-bbbbbbbb00000002",
            appointment: {
              patient: {
                id: "pat-2",
                mrNumber: "MR-002",
                user: { name: "Vikram Singh" },
              },
            },
            doctor: { user: { name: "Dr. Meera Iyer" } },
          }),
        ],
      }),
    );

    render(<AIFollowupPage />);

    const rows = await screen.findAllByTestId("followup-row");
    expect(rows).toHaveLength(2);

    // API contract — exact endpoint + querystring.
    expect(apiGetMock).toHaveBeenCalledWith(
      "/ai/followup/consultations?limit=20",
    );

    // Patient names rendered.
    expect(screen.getByText("Asha Patel")).toBeInTheDocument();
    expect(screen.getByText("Vikram Singh")).toBeInTheDocument();

    // MR numbers rendered alongside their patient.
    expect(screen.getByText("MR-001")).toBeInTheDocument();
    expect(screen.getByText("MR-002")).toBeInTheDocument();

    // Doctor name passes through formatDoctorName — already-prefixed names
    // collapse to a single "Dr. " (Issue #12/#25 helper contract).
    expect(screen.getByText(/Dr\. Rajesh Sharma/)).toBeInTheDocument();
    expect(screen.getByText(/Dr\. Meera Iyer/)).toBeInTheDocument();
    // Negative — never double-prefixed.
    expect(screen.queryByText(/Dr\. Dr\. /)).not.toBeInTheDocument();

    // Consultation id is truncated to the first 8 chars in the subline
    // (the page does `c.id.slice(0, 8)`). React splits the interpolated
    // slice into adjacent text nodes, so we scope to the row subline
    // <p> nodes and read their normalised text.
    const sublines = Array.from(
      document.querySelectorAll("p.text-xs.text-gray-500.mt-1"),
    ).map((n) => n.textContent?.replace(/\s+/g, " ").trim());
    expect(sublines.some((t) => t?.includes("Consultation abcd1234"))).toBe(
      true,
    );
    expect(sublines.some((t) => t?.includes("Consultation wxyz5678"))).toBe(
      true,
    );

    // Each row exposes a "Suggest follow-up" button (no suggestion shown yet).
    expect(screen.getAllByTestId("followup-suggest")).toHaveLength(2);
  });

  it("renders the empty state when the API returns no consultations", async () => {
    apiGetMock.mockResolvedValue(getOk({ consultations: [] }));
    render(<AIFollowupPage />);
    expect(
      await screen.findByText(/No recent consultations found\./i),
    ).toBeInTheDocument();
    // No rows.
    expect(screen.queryAllByTestId("followup-row")).toHaveLength(0);
  });

  it("falls back to the empty state when the consultations fetch rejects", async () => {
    apiGetMock.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    render(<AIFollowupPage />);
    // Source catches the rejection in `.catch(() => ({data:{consultations:[]}}))`
    // and falls through to the empty branch.
    expect(
      await screen.findByText(/No recent consultations found\./i),
    ).toBeInTheDocument();
    // Header chrome is independent of the fetch outcome.
    expect(
      screen.getByRole("heading", { name: /Smart Follow-up Suggestions/i }),
    ).toBeInTheDocument();
  });

  it("renders a suggestion panel after clicking Suggest follow-up and POSTs to /ai/followup/suggest/:cid", async () => {
    apiGetMock.mockResolvedValue(
      getOk({ consultations: [row({ id: "consult-aaaaaaaa00000001" })] }),
    );
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: {
        suggestion: {
          consultationId: "consult-aaaaaaaa00000001",
          suggestedDate: "2026-06-08",
          slotStart: "10:30",
          doctorId: "doc-1",
          reason: "Notes mention 2-week review",
          fallbackUsed: false,
        },
      },
      error: null,
    });

    render(<AIFollowupPage />);
    const suggestBtn = await screen.findByTestId("followup-suggest");
    fireEvent.click(suggestBtn);

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        "/ai/followup/suggest/consult-aaaaaaaa00000001",
      ),
    );

    // Suggestion panel surfaces date, slot, reason.
    expect(await screen.findByText(/2026-06-08/)).toBeInTheDocument();
    expect(screen.getByText(/at 10:30/)).toBeInTheDocument();
    expect(
      screen.getByText(/Reason: Notes mention 2-week review/),
    ).toBeInTheDocument();

    // Once a suggestion is in state, the Suggest button is replaced by the
    // panel; the Book button appears.
    expect(screen.queryByTestId("followup-suggest")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Book/i })).toBeInTheDocument();
  });

  it("surfaces a toast when the suggest endpoint returns suggestion=null", async () => {
    apiGetMock.mockResolvedValue(
      getOk({ consultations: [row({ id: "consult-aaaaaaaa00000001" })] }),
    );
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: { suggestion: null, reason: "No follow-up timeline in notes" },
      error: null,
    });

    render(<AIFollowupPage />);
    fireEvent.click(await screen.findByTestId("followup-suggest"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "No follow-up timeline in notes",
      ),
    );
    // No suggestion panel surfaced.
    expect(screen.queryByRole("button", { name: /Book/i })).not.toBeInTheDocument();
  });

  it("falls back to the generic copy when suggestion=null with no reason", async () => {
    apiGetMock.mockResolvedValue(
      getOk({ consultations: [row({ id: "consult-aaaaaaaa00000001" })] }),
    );
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: { suggestion: null },
      error: null,
    });

    render(<AIFollowupPage />);
    fireEvent.click(await screen.findByTestId("followup-suggest"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "No follow-up suggestion available",
      ),
    );
  });

  it("renders the suggestion but warns + disables Book when slotStart is null", async () => {
    apiGetMock.mockResolvedValue(
      getOk({ consultations: [row({ id: "consult-aaaaaaaa00000001" })] }),
    );
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: {
        suggestion: {
          consultationId: "consult-aaaaaaaa00000001",
          suggestedDate: "2026-06-08",
          slotStart: null,
          doctorId: "doc-1",
          reason: "Backlog full on suggested date",
          fallbackUsed: false,
        },
      },
      error: null,
    });

    render(<AIFollowupPage />);
    fireEvent.click(await screen.findByTestId("followup-suggest"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "No available slot on the suggested date",
      ),
    );

    // Panel still rendered, but the date line says "(no slot)" and Book
    // is disabled because slotStart is null.
    expect(await screen.findByText(/\(no slot\)/)).toBeInTheDocument();
    const bookBtn = screen.getByRole("button", { name: /Book/i });
    expect(bookBtn).toBeDisabled();
  });

  it("surfaces the fallback-doctor notice when fallbackUsed=true", async () => {
    apiGetMock.mockResolvedValue(
      getOk({ consultations: [row({ id: "consult-aaaaaaaa00000001" })] }),
    );
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: {
        suggestion: {
          consultationId: "consult-aaaaaaaa00000001",
          suggestedDate: "2026-06-08",
          slotStart: "11:00",
          doctorId: "doc-fallback",
          reason: "Original doctor on leave",
          fallbackUsed: true,
        },
      },
      error: null,
    });

    render(<AIFollowupPage />);
    fireEvent.click(await screen.findByTestId("followup-suggest"));

    expect(
      await screen.findByText(
        /Original doctor unavailable — fallback doctor assigned\./i,
      ),
    ).toBeInTheDocument();
  });

  it("surfaces an error toast when the suggest endpoint rejects with payload.error", async () => {
    apiGetMock.mockResolvedValue(
      getOk({ consultations: [row({ id: "consult-aaaaaaaa00000001" })] }),
    );
    apiPostMock.mockRejectedValueOnce({
      payload: { error: "Notes too short" },
      message: "Bad Request",
    });

    render(<AIFollowupPage />);
    fireEvent.click(await screen.findByTestId("followup-suggest"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Notes too short"),
    );
  });

  it("books the suggestion, shows a success toast, clears the panel and refetches", async () => {
    // Initial fetch — 1 row.
    apiGetMock.mockResolvedValueOnce(
      getOk({ consultations: [row({ id: "consult-aaaaaaaa00000001" })] }),
    );
    // Suggest call.
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: {
        suggestion: {
          consultationId: "consult-aaaaaaaa00000001",
          suggestedDate: "2026-06-08",
          slotStart: "10:30",
          doctorId: "doc-1",
          reason: "Notes mention 2-week review",
          fallbackUsed: false,
        },
      },
      error: null,
    });
    // Book call.
    apiPostMock.mockResolvedValueOnce({ success: true, data: {}, error: null });
    // Post-book refetch — empty.
    apiGetMock.mockResolvedValueOnce(getOk({ consultations: [] }));

    render(<AIFollowupPage />);
    fireEvent.click(await screen.findByTestId("followup-suggest"));

    // Book button appears once suggestion is in state.
    const bookBtn = await screen.findByRole("button", { name: /Book/i });
    fireEvent.click(bookBtn);

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        "/ai/followup/consult-aaaaaaaa00000001/book",
        {},
      ),
    );
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith("Follow-up booked"),
    );

    // Refetch issued.
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(2));

    // Empty state surfaces after the refetch.
    expect(
      await screen.findByText(/No recent consultations found\./i),
    ).toBeInTheDocument();
  });

  it("surfaces an error toast when booking rejects and keeps the suggestion visible", async () => {
    apiGetMock.mockResolvedValue(
      getOk({ consultations: [row({ id: "consult-aaaaaaaa00000001" })] }),
    );
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: {
        suggestion: {
          consultationId: "consult-aaaaaaaa00000001",
          suggestedDate: "2026-06-08",
          slotStart: "10:30",
          doctorId: "doc-1",
          reason: "Notes mention 2-week review",
          fallbackUsed: false,
        },
      },
      error: null,
    });
    apiPostMock.mockRejectedValueOnce({
      payload: { error: "Slot just taken" },
      message: "Conflict",
    });

    render(<AIFollowupPage />);
    fireEvent.click(await screen.findByTestId("followup-suggest"));
    const bookBtn = await screen.findByRole("button", { name: /Book/i });
    fireEvent.click(bookBtn);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Slot just taken"),
    );

    // Suggestion panel persists because the local state wasn't cleared
    // (only success clears it).
    expect(screen.getByText(/2026-06-08/)).toBeInTheDocument();
  });

  it("refetches the list when the Refresh button is clicked", async () => {
    apiGetMock.mockResolvedValue(getOk({ consultations: [] }));
    render(<AIFollowupPage />);

    await screen.findByText(/No recent consultations found\./i);
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));

    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(2));
    // Both calls hit the same endpoint.
    expect(apiGetMock).toHaveBeenNthCalledWith(
      2,
      "/ai/followup/consultations?limit=20",
    );
  });
});
