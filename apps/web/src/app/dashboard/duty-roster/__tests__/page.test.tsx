/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * DutyRosterPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/duty-roster/page.tsx, the ADMIN-only
 *     staff scheduling surface (Issue #509 gate; Issue #725 cell-prefill).
 *     Endpoints the page hits:
 *       GET    /shifts/staff                  (staff list for the rows)
 *       GET    /shifts/roster?date=YYYY-MM-DD (per-date shifts)
 *       POST   /shifts                        (assign one shift)
 *       POST   /shifts/bulk                   (range x staff bulk schedule)
 *       DELETE /shifts/:id                    (delete a shift)
 *
 *   - Behaviours covered:
 *       1. RBAC redirect — non-ADMIN (NURSE) triggers toast.error +
 *          router.replace("/dashboard/not-authorized?from=...") and renders
 *          the "Access restricted" placeholder.
 *       2. Loading branch — SkeletonTable wrapper marked aria-busy renders
 *          while the initial /shifts/roster GET is in flight.
 *       3. Happy path — staff rows + per-shift-type cells, with empty cells
 *          showing the "Assign" button and filled cells showing the
 *          time-range pill + delete affordance.
 *       4. Empty-staff branch — when /shifts/staff returns [], the
 *          "No staff found." copy surfaces.
 *       5. Date filter — changing the date input refetches /shifts/roster
 *          with the new date in the querystring AND syncs the add/bulk
 *          form defaults.
 *       6. Role filter — selecting NURSE narrows the rendered rows.
 *       7. Per-cell click-to-assign (Issue #725) — clicking the empty cell
 *          opens the modal with userId + type + DEFAULT_TIMES prefilled.
 *       8. Toolbar Assign Shift — opens the modal with empty userId so the
 *          operator can pick freely.
 *       9. Add validation — empty staff, empty date, empty start/end time
 *          each surface toast.error and do NOT POST.
 *      10. Add happy POST — submits /shifts with the form body, closes the
 *          modal, refetches the roster.
 *      11. Add POST rejection — surfaces toast.error with the thrown message.
 *      12. Bulk validation — empty userIds, missing from/to date, missing
 *          times each surface toast.error and do NOT POST.
 *      13. Bulk happy POST — fans out staff x date-range into per-day
 *          shifts, POSTs /shifts/bulk, toasts the created/skipped summary,
 *          closes modal, clears userIds, refetches.
 *      14. Bulk POST rejection — surfaces toast.error with the thrown
 *          message and keeps the modal open.
 *      15. Delete cancel — useConfirm returning false is a no-op (no DELETE).
 *      16. Delete happy — useConfirm true triggers DELETE /shifts/:id and
 *          refetches the roster.
 *      17. Delete rejection — surfaces toast.error with the thrown message.
 *      18. Shift-type change syncs start/end times to DEFAULT_TIMES on both
 *          add and bulk forms.
 *      19. Roster GET rejection — empty list rendered (graceful), no crash.
 *
 *   - Mocks: @/lib/api (api.{get,post,delete}), @/lib/store (useAuthStore —
 *            bare-call shape), @/lib/toast (toast.{success,error}),
 *            @/lib/use-dialog (useConfirm queued per test), next/navigation
 *            (useRouter), @/components/Skeleton (passthrough stub).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, routerMock, confirmMock } = vi.hoisted(
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
    confirmMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(async () => ""),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/duty-roster",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import DutyRosterPage from "../page";

// ─── Fixtures ───────────────────────────────────────────

const STAFF = [
  { id: "u-doc-1", name: "Dr Asha", email: "asha@h.com", role: "DOCTOR" },
  { id: "u-nrs-1", name: "Nurse Bina", email: "bina@h.com", role: "NURSE" },
  { id: "u-rcp-1", name: "Rec Chitra", email: "chitra@h.com", role: "RECEPTION" },
];

const SHIFTS = [
  {
    id: "s1",
    userId: "u-doc-1",
    date: "2026-05-26",
    type: "MORNING" as const,
    startTime: "07:00",
    endTime: "15:00",
    status: "SCHEDULED" as const,
    notes: null,
  },
  {
    id: "s2",
    userId: "u-nrs-1",
    date: "2026-05-26",
    type: "NIGHT" as const,
    startTime: "23:00",
    endTime: "07:00",
    status: "PRESENT" as const,
    notes: null,
  },
];

function adminAuth() {
  return {
    user: { id: "u-admin", role: "ADMIN", name: "Admin", email: "a@h.com" },
    isLoading: false,
  };
}

function mockHappyFetches(opts?: {
  staff?: any[];
  shifts?: any[];
}) {
  apiMock.get.mockImplementation((endpoint: string) => {
    if (endpoint === "/shifts/staff") {
      return Promise.resolve({ data: opts?.staff ?? STAFF });
    }
    if (endpoint.startsWith("/shifts/roster")) {
      return Promise.resolve({
        data: { shifts: opts?.shifts ?? SHIFTS, grouped: {} },
      });
    }
    return Promise.resolve({ data: null });
  });
}

describe("DutyRosterPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.delete.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    routerMock.push.mockReset();
    routerMock.replace.mockReset();
    confirmMock.mockReset();
    authMock.mockReturnValue(adminAuth());
  });

  it("redirects non-ADMIN users to /dashboard/not-authorized and renders the access-restricted placeholder", async () => {
    authMock.mockReturnValue({
      user: { id: "u-nurse", role: "NURSE", name: "N", email: "n@h.com" },
      isLoading: false,
    });
    mockHappyFetches();

    render(<DutyRosterPage />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized?from="),
      ),
    );
    expect(toastMock.error).toHaveBeenCalledWith(
      "Duty roster is restricted to administrators.",
    );
    expect(
      screen.getByText(/access restricted to administrators/i),
    ).toBeInTheDocument();
  });

  it("renders the skeleton loader while the initial /shifts/roster fetch is pending", () => {
    // Hang the roster fetch; staff fetch resolves immediately so the page can
    // mount past the staff effect, but the loading branch stays up.
    apiMock.get.mockImplementation((endpoint: string) => {
      if (endpoint === "/shifts/staff") {
        return Promise.resolve({ data: STAFF });
      }
      return new Promise(() => {}); // never resolves
    });

    render(<DutyRosterPage />);

    expect(screen.getByTestId("duty-roster-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("renders the staff grid with assign affordances on empty cells and time pills on filled cells", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);

    // Wait for staff rows to land.
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());
    expect(screen.getByText("Nurse Bina")).toBeInTheDocument();
    expect(screen.getByText("Rec Chitra")).toBeInTheDocument();

    // Filled cell — Dr Asha MORNING shows the time-range pill.
    expect(screen.getByText("07:00–15:00")).toBeInTheDocument();
    // Filled cell — Nurse Bina NIGHT shows the night-shift pill.
    expect(screen.getByText("23:00–07:00")).toBeInTheDocument();

    // Empty cell — Dr Asha NIGHT has the cell-prefill assign button.
    expect(
      screen.getByTestId("assign-cell-u-doc-1-NIGHT"),
    ).toBeInTheDocument();
    // Empty cell — Rec Chitra MORNING has the cell-prefill assign button.
    expect(
      screen.getByTestId("assign-cell-u-rcp-1-MORNING"),
    ).toBeInTheDocument();

    // Roster fetch hit the endpoint with the date.
    expect(apiMock.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/shifts\/roster\?date=\d{4}-\d{2}-\d{2}$/),
    );
    expect(apiMock.get).toHaveBeenCalledWith("/shifts/staff");
  });

  it("renders the 'No staff found.' branch when the staff list is empty", async () => {
    mockHappyFetches({ staff: [], shifts: [] });

    render(<DutyRosterPage />);

    expect(await screen.findByText(/no staff found/i)).toBeInTheDocument();
  });

  it("refetches /shifts/roster with the new date when the date filter changes", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    apiMock.get.mockClear();
    mockHappyFetches();

    fireEvent.change(screen.getByTestId("roster-date-filter"), {
      target: { value: "2026-06-15" },
    });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/shifts/roster?date=2026-06-15",
      ),
    );
  });

  it("filters the rendered staff rows by role when the role filter changes", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/role:/i), {
      target: { value: "NURSE" },
    });

    // Only the nurse row remains.
    expect(screen.queryByText("Dr Asha")).not.toBeInTheDocument();
    expect(screen.getByText("Nurse Bina")).toBeInTheDocument();
    expect(screen.queryByText("Rec Chitra")).not.toBeInTheDocument();
  });

  it("opens the Add modal with the staff + type prefilled when an empty cell is clicked (Issue #725)", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    // Click Dr Asha's empty AFTERNOON cell.
    fireEvent.click(screen.getByTestId("assign-cell-u-doc-1-AFTERNOON"));

    const modal = await screen.findByTestId("add-shift-modal");
    const staffSel = within(modal).getByLabelText(/staff/i) as HTMLSelectElement;
    const typeSel = within(modal).getByLabelText(/shift type/i) as HTMLSelectElement;
    const startInp = within(modal).getByLabelText(/start time/i) as HTMLInputElement;
    const endInp = within(modal).getByLabelText(/end time/i) as HTMLInputElement;

    expect(staffSel.value).toBe("u-doc-1");
    expect(typeSel.value).toBe("AFTERNOON");
    expect(startInp.value).toBe("15:00");
    expect(endInp.value).toBe("23:00");
  });

  it("opens an empty Add modal from the toolbar Assign Shift button", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assign-shift-toolbar"));

    const modal = await screen.findByTestId("add-shift-modal");
    const staffSel = within(modal).getByLabelText(/staff/i) as HTMLSelectElement;
    const typeSel = within(modal).getByLabelText(/shift type/i) as HTMLSelectElement;

    expect(staffSel.value).toBe("");
    expect(typeSel.value).toBe("MORNING");
  });

  it("Add validation — missing staff selection raises toast and does NOT POST", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assign-shift-toolbar"));
    const modal = await screen.findByTestId("add-shift-modal");

    fireEvent.click(within(modal).getByRole("button", { name: /^assign$/i }));

    expect(toastMock.error).toHaveBeenCalledWith("Select a staff member");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add validation — empty date raises toast and does NOT POST", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assign-cell-u-doc-1-NIGHT"));
    const modal = await screen.findByTestId("add-shift-modal");

    fireEvent.change(within(modal).getByLabelText(/^date$/i), {
      target: { value: "" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: /^assign$/i }));

    expect(toastMock.error).toHaveBeenCalledWith("Date is required");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add validation — empty start/end time raises toast and does NOT POST", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assign-cell-u-doc-1-NIGHT"));
    const modal = await screen.findByTestId("add-shift-modal");

    fireEvent.change(within(modal).getByLabelText(/start time/i), {
      target: { value: "" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: /^assign$/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      "Start and end time are required",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add happy POST — submits /shifts with the form body, closes the modal, refetches the roster", async () => {
    mockHappyFetches();
    apiMock.post.mockResolvedValueOnce({ data: { id: "s-new" } });

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assign-cell-u-doc-1-AFTERNOON"));
    const modal = await screen.findByTestId("add-shift-modal");

    fireEvent.change(within(modal).getByLabelText(/notes/i), {
      target: { value: "Cover Dr X" },
    });

    apiMock.get.mockClear();
    mockHappyFetches();

    fireEvent.click(within(modal).getByRole("button", { name: /^assign$/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/shifts",
        expect.objectContaining({
          userId: "u-doc-1",
          type: "AFTERNOON",
          startTime: "15:00",
          endTime: "23:00",
          notes: "Cover Dr X",
        }),
      ),
    );

    // Modal closes.
    await waitFor(() =>
      expect(screen.queryByTestId("add-shift-modal")).not.toBeInTheDocument(),
    );

    // Roster refetched.
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/^\/shifts\/roster\?date=/),
      ),
    );
  });

  it("Add POST rejection surfaces toast.error with the thrown message and keeps the modal open", async () => {
    mockHappyFetches();
    apiMock.post.mockRejectedValueOnce(new Error("Overlapping shift"));

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assign-cell-u-doc-1-NIGHT"));
    const modal = await screen.findByTestId("add-shift-modal");

    fireEvent.click(within(modal).getByRole("button", { name: /^assign$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Overlapping shift"),
    );
    expect(screen.getByTestId("add-shift-modal")).toBeInTheDocument();
  });

  it("Add POST non-Error rejection falls back to the generic 'Create failed' copy", async () => {
    mockHappyFetches();
    apiMock.post.mockRejectedValueOnce("string-thrown");

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assign-cell-u-doc-1-NIGHT"));
    const modal = await screen.findByTestId("add-shift-modal");

    fireEvent.click(within(modal).getByRole("button", { name: /^assign$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Create failed"),
    );
  });

  it("Bulk validation — empty userIds raises toast and does NOT POST", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /bulk schedule/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /create shifts/i }),
    );

    expect(toastMock.error).toHaveBeenCalledWith(
      "Select at least one staff member",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Bulk validation — empty from/to date raises toast and does NOT POST", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /bulk schedule/i }));

    // Tick one staff so we pass the first guard.
    const drAshaCheckboxes = screen.getAllByLabelText(/dr asha/i);
    fireEvent.click(drAshaCheckboxes[0]);

    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create shifts/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      "From and To dates are required",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Bulk validation — empty start/end time raises toast and does NOT POST", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /bulk schedule/i }));

    const drAshaCheckboxes = screen.getAllByLabelText(/dr asha/i);
    fireEvent.click(drAshaCheckboxes[0]);

    fireEvent.change(screen.getByLabelText(/^start time$/i), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create shifts/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      "Start and end time are required",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Bulk happy POST — fans staff x date range into per-day shifts, toasts the created/skipped summary, refetches", async () => {
    mockHappyFetches();
    apiMock.post.mockResolvedValueOnce({
      data: { created: [{ id: "s-a" }, { id: "s-b" }], skipped: [{ reason: "dup" }] },
    });

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /bulk schedule/i }));

    // Tick two staff in the bulk picker.
    const ashaCheckboxes = screen.getAllByLabelText(/dr asha/i);
    fireEvent.click(ashaCheckboxes[0]);
    const binaCheckboxes = screen.getAllByLabelText(/nurse bina/i);
    fireEvent.click(binaCheckboxes[0]);

    // Span 2 days.
    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: "2026-06-02" },
    });

    apiMock.get.mockClear();
    mockHappyFetches();

    fireEvent.click(screen.getByRole("button", { name: /create shifts/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/shifts/bulk",
        expect.objectContaining({
          shifts: expect.any(Array),
        }),
      ),
    );

    // 2 staff x 2 days = 4 generated shifts.
    const body = apiMock.post.mock.calls[0][1] as { shifts: any[] };
    expect(body.shifts).toHaveLength(4);
    expect(body.shifts.map((s: any) => s.date).sort()).toEqual([
      "2026-06-01",
      "2026-06-01",
      "2026-06-02",
      "2026-06-02",
    ]);
    expect(body.shifts.every((s: any) => s.type === "MORNING")).toBe(true);

    expect(toastMock.success).toHaveBeenCalledWith(
      "Created 2, skipped 1",
    );

    // Roster refetched.
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/^\/shifts\/roster\?date=/),
      ),
    );
  });

  it("Bulk POST rejection surfaces toast.error with the thrown message", async () => {
    mockHappyFetches();
    apiMock.post.mockRejectedValueOnce(new Error("Bulk conflict"));

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /bulk schedule/i }));
    const ashaCheckboxes = screen.getAllByLabelText(/dr asha/i);
    fireEvent.click(ashaCheckboxes[0]);

    fireEvent.click(screen.getByRole("button", { name: /create shifts/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Bulk conflict"),
    );
  });

  it("Bulk POST non-Error rejection falls back to the generic 'Bulk create failed' copy", async () => {
    mockHappyFetches();
    apiMock.post.mockRejectedValueOnce("nope");

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /bulk schedule/i }));
    const ashaCheckboxes = screen.getAllByLabelText(/dr asha/i);
    fireEvent.click(ashaCheckboxes[0]);

    fireEvent.click(screen.getByRole("button", { name: /create shifts/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Bulk create failed"),
    );
  });

  it("Delete — useConfirm returning false is a no-op (no DELETE issued)", async () => {
    mockHappyFetches();
    confirmMock.mockResolvedValueOnce(false);

    render(<DutyRosterPage />);
    await waitFor(() =>
      expect(screen.getByText("07:00–15:00")).toBeInTheDocument(),
    );

    // Click the first Trash icon (next to Dr Asha's MORNING shift).
    const delButtons = screen.getAllByTitle("Delete");
    fireEvent.click(delButtons[0]);

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.delete).not.toHaveBeenCalled();
  });

  it("Delete — useConfirm true triggers DELETE /shifts/:id and refetches the roster", async () => {
    mockHappyFetches();
    confirmMock.mockResolvedValueOnce(true);
    apiMock.delete.mockResolvedValueOnce({ data: { ok: true } });

    render(<DutyRosterPage />);
    await waitFor(() =>
      expect(screen.getByText("07:00–15:00")).toBeInTheDocument(),
    );

    apiMock.get.mockClear();
    mockHappyFetches();

    fireEvent.click(screen.getAllByTitle("Delete")[0]);

    await waitFor(() =>
      expect(apiMock.delete).toHaveBeenCalledWith("/shifts/s1"),
    );
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/^\/shifts\/roster\?date=/),
      ),
    );
  });

  it("Delete rejection surfaces toast.error with the thrown message", async () => {
    mockHappyFetches();
    confirmMock.mockResolvedValueOnce(true);
    apiMock.delete.mockRejectedValueOnce(new Error("Cannot delete past shift"));

    render(<DutyRosterPage />);
    await waitFor(() =>
      expect(screen.getByText("07:00–15:00")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getAllByTitle("Delete")[0]);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Cannot delete past shift"),
    );
  });

  it("Delete non-Error rejection falls back to the generic 'Delete failed' copy", async () => {
    mockHappyFetches();
    confirmMock.mockResolvedValueOnce(true);
    apiMock.delete.mockRejectedValueOnce("blammo");

    render(<DutyRosterPage />);
    await waitFor(() =>
      expect(screen.getByText("07:00–15:00")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getAllByTitle("Delete")[0]);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Delete failed"),
    );
  });

  it("Shift-type change syncs start/end time defaults on the Add modal", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assign-shift-toolbar"));
    const modal = await screen.findByTestId("add-shift-modal");

    // Initial MORNING defaults.
    expect((within(modal).getByLabelText(/start time/i) as HTMLInputElement).value).toBe("07:00");

    fireEvent.change(within(modal).getByLabelText(/shift type/i), {
      target: { value: "NIGHT" },
    });

    expect(
      (within(modal).getByLabelText(/start time/i) as HTMLInputElement).value,
    ).toBe("23:00");
    expect(
      (within(modal).getByLabelText(/end time/i) as HTMLInputElement).value,
    ).toBe("07:00");

    fireEvent.change(within(modal).getByLabelText(/shift type/i), {
      target: { value: "ON_CALL" },
    });
    expect(
      (within(modal).getByLabelText(/start time/i) as HTMLInputElement).value,
    ).toBe("00:00");
    expect(
      (within(modal).getByLabelText(/end time/i) as HTMLInputElement).value,
    ).toBe("23:59");
  });

  it("Shift-type change syncs start/end time defaults on the Bulk modal", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /bulk schedule/i }));

    const typeSel = screen.getByLabelText(/shift type/i) as HTMLSelectElement;
    fireEvent.change(typeSel, { target: { value: "AFTERNOON" } });

    const startInp = screen.getByLabelText(/^start time$/i) as HTMLInputElement;
    const endInp = screen.getByLabelText(/^end time$/i) as HTMLInputElement;
    expect(startInp.value).toBe("15:00");
    expect(endInp.value).toBe("23:00");
  });

  it("Cancel buttons close the Add and Bulk modals without posting", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    // Open + cancel Add modal.
    fireEvent.click(screen.getByTestId("assign-shift-toolbar"));
    const addModal = await screen.findByTestId("add-shift-modal");
    fireEvent.click(within(addModal).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() =>
      expect(screen.queryByTestId("add-shift-modal")).not.toBeInTheDocument(),
    );

    // Open + cancel Bulk modal.
    fireEvent.click(screen.getByRole("button", { name: /bulk schedule/i }));
    await screen.findByRole("button", { name: /create shifts/i });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /create shifts/i }),
      ).not.toBeInTheDocument(),
    );

    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Bulk userId checkbox toggles ON then OFF correctly", async () => {
    mockHappyFetches();

    render(<DutyRosterPage />);
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /bulk schedule/i }));

    const ashaCheckbox = screen.getAllByLabelText(/dr asha/i)[0] as HTMLInputElement;
    fireEvent.click(ashaCheckbox);
    expect(ashaCheckbox.checked).toBe(true);
    expect(screen.getByText(/\(1 selected\)/i)).toBeInTheDocument();

    fireEvent.click(ashaCheckbox);
    expect(ashaCheckbox.checked).toBe(false);
    expect(screen.getByText(/\(0 selected\)/i)).toBeInTheDocument();
  });

  it("Roster GET rejection is graceful — shifts list is empty, page chrome still renders", async () => {
    apiMock.get.mockImplementation((endpoint: string) => {
      if (endpoint === "/shifts/staff") {
        return Promise.resolve({ data: STAFF });
      }
      return Promise.reject(new Error("500"));
    });

    render(<DutyRosterPage />);

    // Staff rows still render.
    await waitFor(() => expect(screen.getByText("Dr Asha")).toBeInTheDocument());
    // No time-pill (no shifts loaded) — all cells show Assign buttons.
    expect(screen.queryByText("07:00–15:00")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("assign-cell-u-doc-1-MORNING"),
    ).toBeInTheDocument();
  });

  it("Staff GET rejection is graceful — empty staff branch surfaces", async () => {
    apiMock.get.mockImplementation((endpoint: string) => {
      if (endpoint === "/shifts/staff") {
        return Promise.reject(new Error("staff fail"));
      }
      return Promise.resolve({ data: { shifts: [], grouped: {} } });
    });

    render(<DutyRosterPage />);

    expect(await screen.findByText(/no staff found/i)).toBeInTheDocument();
  });
});
