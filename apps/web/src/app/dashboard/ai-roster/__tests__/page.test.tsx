// Coverage tests for the AI Staff Roster dashboard page.
// Modules under test: apps/web/src/app/dashboard/ai-roster/page.tsx —
//   admin-only flow that GETs /ai/roster/history on mount, POSTs to
//   /ai/roster/propose with { startDate, days, department }, renders the
//   proposal grid (4-shift columns x N days) with warnings + violations
//   panels, opens a confirm modal on Apply, POSTs /ai/roster/apply with
//   { id, confirm:true }, then surfaces a toast and refreshes history.
// Why: page was at 0% line coverage. Locks in the loading state, default
//   GET on mount, happy propose path (form -> grid -> warnings -> violations),
//   confirm-modal -> apply -> toast + history-refresh, the error envelope
//   path, the thrown-Error rejection path, and the non-Error fallback
//   rejection path so future refactors of the roster surface can't silently
//   break it. Pattern mirrors the capacity-forecast page test (commit
//   ed774a7d) — same hoisted api/auth mock shape, same fixture factories.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

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
  usePathname: () => "/dashboard/ai-roster",
}));

import AIRosterPage from "../page";

// ─── Fixtures ───────────────────────────────────────────

function staff(overrides: Partial<any> = {}) {
  return {
    userId: "u-nurse-1",
    name: "Asha Nurse",
    role: "NURSE",
    ...overrides,
  };
}

function shift(overrides: Partial<any> = {}) {
  return {
    shiftType: "MORNING" as const,
    requiredCount: 2,
    assignedStaff: [staff()],
    understaffed: false,
    ...overrides,
  };
}

function dayProposal(overrides: Partial<any> = {}) {
  return {
    date: "2026-06-01",
    shifts: [shift()],
    ...overrides,
  };
}

function proposalPayload(overrides: Partial<any> = {}) {
  return {
    id: "prop-1",
    status: "PROPOSED" as const,
    startDate: "2026-06-01",
    days: 7,
    department: "general",
    proposals: [dayProposal()],
    warnings: [],
    violationsIfApplied: [],
    ...overrides,
  };
}

describe("AI Staff Roster dashboard page", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockReturnValue({ token: "tok-admin" });
  });

  it("loads /ai/roster/history on mount and renders the empty-history copy when none exist", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [] });

    render(<AIRosterPage />);

    // Header chrome renders regardless of fetch state.
    expect(
      screen.getByRole("heading", { name: /ai staff roster/i }),
    ).toBeInTheDocument();
    // The form is always present (Generate button is the load trigger).
    expect(screen.getByRole("button", { name: /generate/i })).toBeInTheDocument();

    // History GET is fired on mount, with token threaded through.
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/ai/roster/history",
        expect.objectContaining({ token: "tok-admin" }),
      ),
    );

    // Empty-history copy.
    expect(
      await screen.findByText(/no past proposals yet\./i),
    ).toBeInTheDocument();
  });

  it("renders past proposals in the history table when /ai/roster/history returns rows", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: [
        {
          id: "h1",
          status: "APPLIED",
          startDate: "2026-05-20",
          days: 7,
          department: "cardiology",
          createdAt: "2026-05-19T10:00:00Z",
          appliedAt: "2026-05-19T11:00:00Z",
          warnings: 2,
          violationsIfApplied: 0,
        },
        {
          id: "h2",
          status: "PROPOSED",
          startDate: "2026-05-27",
          days: 14,
          department: "icu",
          createdAt: "2026-05-26T08:00:00Z",
          warnings: 1,
          violationsIfApplied: 3,
        },
      ],
    });

    render(<AIRosterPage />);

    await waitFor(() =>
      expect(screen.getByText("cardiology")).toBeInTheDocument(),
    );
    expect(screen.getByText("icu")).toBeInTheDocument();

    // Status badges — APPLIED + PROPOSED both surface.
    expect(screen.getByText(/APPLIED/i)).toBeInTheDocument();
    // The PROPOSED badge text appears in the history row.
    expect(screen.getAllByText(/PROPOSED/i).length).toBeGreaterThanOrEqual(1);
  });

  it("issues POST /ai/roster/propose with the form values and renders the proposal grid + warnings + violations", async () => {
    // History fetch resolves to empty.
    apiMock.get.mockResolvedValue({ success: true, data: [] });
    apiMock.post.mockResolvedValueOnce({
      success: true,
      data: proposalPayload({
        id: "prop-7",
        department: "general",
        days: 7,
        startDate: "2026-06-01",
        warnings: ["Nurse Asha exceeds 5 nights in week"],
        violationsIfApplied: ["MORNING 2026-06-03 short by 1"],
        proposals: [
          dayProposal({
            date: "2026-06-01",
            shifts: [
              shift({
                shiftType: "MORNING",
                requiredCount: 2,
                assignedStaff: [staff({ name: "Asha Nurse" })],
                understaffed: true,
              }),
              shift({
                shiftType: "NIGHT",
                requiredCount: 0,
                assignedStaff: [],
              }),
            ],
          }),
        ],
      }),
      error: null,
    });

    render(<AIRosterPage />);

    // Settle initial history fetch.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    // POST contract — endpoint + body shape + token in opts.
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/roster/propose",
        expect.objectContaining({
          days: 7,
          department: "general",
          startDate: expect.any(String),
        }),
        expect.objectContaining({ token: "tok-admin" }),
      ),
    );

    // Proposal header surfaces dept + day count.
    expect(
      await screen.findByText(/general · 7 days · starts 2026-06-01/i),
    ).toBeInTheDocument();

    // Warnings panel rendered with the message.
    expect(
      screen.getByText(/Nurse Asha exceeds 5 nights in week/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Warnings \(1\)/i)).toBeInTheDocument();

    // Violations panel rendered with its message + count.
    expect(
      screen.getByText(/MORNING 2026-06-03 short by 1/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Violations if applied \(1\)/i),
    ).toBeInTheDocument();

    // Grid surfaces the assigned staff member.
    expect(screen.getByText(/Asha Nurse/)).toBeInTheDocument();
    // Apply button is enabled because status is PROPOSED.
    const applyBtn = screen.getByRole("button", { name: /^apply$/i });
    expect(applyBtn).not.toBeDisabled();
  });

  it("opens the confirm modal on Apply, POSTs /ai/roster/apply with confirm:true, surfaces the success toast and reloads history", async () => {
    apiMock.get
      // mount history fetch
      .mockResolvedValueOnce({ success: true, data: [] })
      // post-apply refetch
      .mockResolvedValueOnce({
        success: true,
        data: [
          {
            id: "h-new",
            status: "APPLIED",
            startDate: "2026-06-01",
            days: 7,
            department: "general",
            createdAt: "2026-05-26T12:00:00Z",
            appliedAt: "2026-05-26T12:01:00Z",
            warnings: 0,
            violationsIfApplied: 0,
          },
        ],
      });
    apiMock.post
      // propose
      .mockResolvedValueOnce({
        success: true,
        data: proposalPayload({ id: "prop-apply-1" }),
        error: null,
      })
      // apply
      .mockResolvedValueOnce({
        success: true,
        data: { id: "prop-apply-1", status: "APPLIED", createdShifts: 42 },
        error: null,
      });

    render(<AIRosterPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await screen.findByRole("button", { name: /^apply$/i });

    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    // Confirm modal surfaces.
    expect(
      await screen.findByRole("heading", { name: /apply roster\?/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /confirm apply/i }));

    // Apply POST contract.
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/roster/apply",
        { id: "prop-apply-1", confirm: true },
        expect.objectContaining({ token: "tok-admin" }),
      ),
    );

    // Success toast with the createdShifts count.
    expect(
      await screen.findByText(/Applied — 42 shifts created\./i),
    ).toBeInTheDocument();

    // History refetched (2nd GET call).
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));
  });

  it("renders the violations-remain notice in the confirm modal when the proposal has violationsIfApplied", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [] });
    apiMock.post.mockResolvedValueOnce({
      success: true,
      data: proposalPayload({
        violationsIfApplied: ["v1", "v2", "v3"],
      }),
      error: null,
    });

    render(<AIRosterPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));

    // The modal's violations-remain notice (built off the array length).
    expect(
      await screen.findByText(
        /3 coverage violations will remain unfilled\./i,
      ),
    ).toBeInTheDocument();

    // Cancel returns to the page (modal closes).
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /apply roster\?/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("renders the error banner with the API envelope error message when /ai/roster/propose returns success:false", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [] });
    apiMock.post.mockResolvedValueOnce({
      success: false,
      data: null,
      error: "Department has no staff",
    });

    render(<AIRosterPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    expect(
      await screen.findByText(/department has no staff/i),
    ).toBeInTheDocument();
    // Proposal grid not rendered when no proposal in state.
    expect(screen.queryByRole("button", { name: /^apply$/i })).not.toBeInTheDocument();
  });

  it("renders the error banner with the thrown Error message when propose rejects", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [] });
    apiMock.post.mockRejectedValueOnce(new Error("Service unavailable"));

    render(<AIRosterPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    expect(
      await screen.findByText(/service unavailable/i),
    ).toBeInTheDocument();
  });

  it("falls back to the generic error message when propose rejects with a non-Error value", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [] });
    apiMock.post.mockRejectedValueOnce("string-thrown");

    render(<AIRosterPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    expect(
      await screen.findByText(/failed to generate roster/i),
    ).toBeInTheDocument();
  });

  it("surfaces the error banner when the apply call returns success:false and keeps the proposal visible", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [] });
    apiMock.post
      .mockResolvedValueOnce({
        success: true,
        data: proposalPayload({ id: "prop-apply-fail" }),
        error: null,
      })
      .mockResolvedValueOnce({
        success: false,
        data: null,
        error: "Conflict with existing shift",
      });

    render(<AIRosterPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /confirm apply/i }),
    );

    expect(
      await screen.findByText(/conflict with existing shift/i),
    ).toBeInTheDocument();
    // Proposal grid still on screen.
    expect(
      screen.getByText(/general · 7 days · starts 2026-06-01/i),
    ).toBeInTheDocument();
  });

  it("updates form inputs (days select, department text) before posting", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [] });
    apiMock.post.mockResolvedValueOnce({
      success: true,
      data: proposalPayload({ department: "icu", days: 14 }),
      error: null,
    });

    render(<AIRosterPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    // Change department.
    const deptInput = screen.getByLabelText(/department/i) as HTMLInputElement;
    fireEvent.change(deptInput, { target: { value: "icu" } });
    expect(deptInput.value).toBe("icu");

    // Change days to 14.
    const daysSelect = screen.getByLabelText(/^days$/i) as HTMLSelectElement;
    fireEvent.change(daysSelect, { target: { value: "14" } });
    expect(daysSelect.value).toBe("14");

    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/roster/propose",
        expect.objectContaining({ days: 14, department: "icu" }),
        expect.objectContaining({ token: "tok-admin" }),
      ),
    );
  });

  it("RBAC — when no auth token is present (unauthed visit), GET still fires with token=undefined and the empty-history copy renders", async () => {
    authMock.mockReturnValue({ token: null });
    apiMock.get.mockResolvedValue({ success: true, data: [] });

    render(<AIRosterPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/ai/roster/history",
        expect.objectContaining({ token: undefined }),
      ),
    );
    expect(
      await screen.findByText(/no past proposals yet\./i),
    ).toBeInTheDocument();
  });

  it("RBAC — history fetch rejection is non-fatal: page chrome + form still render", async () => {
    apiMock.get.mockRejectedValueOnce(new Error("403 forbidden"));

    render(<AIRosterPage />);

    // The source swallows the rejection; chrome stays rendered.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("heading", { name: /ai staff roster/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate/i })).toBeInTheDocument();
    // No history rendered (the catch leaves history at [], so empty copy surfaces).
    expect(
      await screen.findByText(/no past proposals yet\./i),
    ).toBeInTheDocument();
  });
});
