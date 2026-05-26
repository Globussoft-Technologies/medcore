/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MySchedulePage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every branch of `apps/web/src/app/dashboard/my-schedule/page.tsx`,
 *     the staff self-service schedule page. The page issues two parallel
 *     fetches on mount: GET /shifts/my (the 7-day shift list) + GET /leaves/my
 *     (pending/approved/used summary). It renders a 7-card week grid where
 *     the today-card surfaces per-shift Check In / Check Out buttons gated by
 *     status, plus a leave-summary tile block and a Request Leave modal that
 *     POSTs /leaves. A nested <MyCertificationsPanel/> fires a third fetch
 *     GET /hr-ops/certifications?userId=... when the auth user has an id.
 *
 *   - Behaviours covered:
 *       1. Loading skeleton — `data-testid="my-schedule-loading"` with
 *          `aria-busy` renders while the two GETs are in flight; the page
 *          header copy stays visible.
 *       2. Happy fetch — week grid renders 7 day cards, the today card carries
 *          the "Today" badge, and a SCHEDULED shift today exposes a Check In
 *          button (NOT Check Out).
 *       3. Shift status gating — today's PRESENT shift exposes Check Out only,
 *          today's LATE shift exposes BOTH Check In and Check Out, today's
 *          ABSENT/LEAVE shifts expose neither button.
 *       4. Non-today shifts NEVER render Check In/Out controls regardless of
 *          status (the buttons are scoped to the today card).
 *       5. Check-in flow — clicking Check In PATCHes /shifts/:id/check-in and
 *          triggers a reload of both the shifts + leaves endpoints.
 *       6. Check-in failure — PATCH rejection surfaces a toast.
 *       7. Empty week — a day with no shifts renders the "No shifts" copy.
 *       8. Leave summary tiles — pending / approved counts and the per-type
 *          breakdown render when used-counts > 0; "No leaves taken yet"
 *          renders when every used value is 0.
 *       9. Leave-request modal — opens, submits POST /leaves with the typed
 *          values, closes, and reloads the lists.
 *      10. Leave-request validation — submitting empty / missing-reason
 *          surfaces a toast and does NOT POST.
 *      11. Error path — initial GET rejection clears loading without crashing
 *          (the page swallows the error and still renders the 7-day grid).
 *      12. Certifications panel — when the auth user has no id, the
 *          certifications endpoint is NOT called.
 *
 *   - Source under test: apps/web/src/app/dashboard/my-schedule/page.tsx
 *   - Mocks: @/lib/api (api.get / api.patch / api.post), @/lib/toast,
 *            @/lib/use-dialog (usePrompt), @/lib/store (useAuthStore),
 *            @/components/Skeleton (SkeletonCard passthrough), lucide-react.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, promptMock, authMock } = vi.hoisted(() => ({
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
  promptMock: vi.fn(),
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  usePrompt: () => promptMock,
  useConfirm: () => vi.fn(),
}));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));
vi.mock("lucide-react", () => ({
  CalendarDays: () => <span data-testid="icon-calendar-days" />,
  Clock: () => <span data-testid="icon-clock" />,
  LogIn: () => <span data-testid="icon-log-in" />,
  LogOut: () => <span data-testid="icon-log-out" />,
  PlaneTakeoff: () => <span data-testid="icon-plane-takeoff" />,
  Plus: () => <span data-testid="icon-plus" />,
}));

import MySchedulePage from "../page";

type Shift = {
  id: string;
  userId: string;
  date: string;
  type: "MORNING" | "AFTERNOON" | "NIGHT" | "ON_CALL";
  startTime: string;
  endTime: string;
  status: "SCHEDULED" | "PRESENT" | "ABSENT" | "LATE" | "LEAVE";
  notes?: string | null;
};

type Summary = {
  pending: number;
  approved: number;
  used: Record<string, number>;
};

/**
 * Helper — return today's date in YYYY-MM-DD form (matches the source's
 * `toDateKey(today)` derivation, which is what the page uses to flag the
 * today-card and gate Check In/Out controls).
 */
function todayKey(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/**
 * Helper — return tomorrow's date in YYYY-MM-DD form (for shifts that should
 * NOT carry today-only controls).
 */
function tomorrowKey(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function shiftFixture(overrides: Partial<Shift> = {}): Shift {
  return {
    id: "shift-1",
    userId: "user-1",
    date: todayKey(),
    type: "MORNING",
    startTime: "08:00",
    endTime: "16:00",
    status: "SCHEDULED",
    notes: null,
    ...overrides,
  };
}

function wireMy(opts: {
  shifts?: Shift[];
  summary?: Summary;
  certs?: Array<{ id: string; type: string; title: string; expiryDate: string | null; status: string }>;
  shiftsError?: Error;
  leavesError?: Error;
} = {}) {
  const summary: Summary = opts.summary ?? {
    pending: 0,
    approved: 0,
    used: {},
  };
  apiMock.get.mockImplementation((url: string) => {
    if (url === "/shifts/my") {
      if (opts.shiftsError) return Promise.reject(opts.shiftsError);
      return Promise.resolve({ data: opts.shifts ?? [] });
    }
    if (url === "/leaves/my") {
      if (opts.leavesError) return Promise.reject(opts.leavesError);
      return Promise.resolve({ data: { leaves: [], summary } });
    }
    if (url.startsWith("/hr-ops/certifications")) {
      return Promise.resolve({ data: opts.certs ?? [] });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("MySchedulePage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    promptMock.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
    authMock.mockReset();
    // Default auth user — staff with an id so the certifications fetch fires.
    authMock.mockReturnValue({ user: { id: "user-1", role: "DOCTOR" } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the loading skeleton while the initial fetches are in flight", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/shifts/my" || url === "/leaves/my")
        return new Promise(() => {});
      return Promise.resolve({ data: [] });
    });

    render(<MySchedulePage />);

    const loading = await screen.findByTestId("my-schedule-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute("aria-busy", "true");
    // Header chrome stays visible during the load.
    expect(
      screen.getByRole("heading", { name: /my schedule/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/upcoming shifts for the next 7 days/i)).toBeInTheDocument();
    // 7 skeleton cards (one per day).
    expect(screen.getAllByTestId("skeleton-card")).toHaveLength(7);
  });

  it("renders the 7-day grid + today badge + Check In on a SCHEDULED today shift", async () => {
    wireMy({
      shifts: [
        shiftFixture({
          id: "shift-today-scheduled",
          status: "SCHEDULED",
        }),
      ],
    });

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    // "Today" badge appears exactly once (one today card).
    expect(screen.getByText(/^today$/i)).toBeInTheDocument();
    // The shift's type label renders.
    expect(screen.getByText("MORNING")).toBeInTheDocument();
    // SCHEDULED status pill renders.
    expect(screen.getByText("SCHEDULED")).toBeInTheDocument();
    // Check In button is offered for SCHEDULED status on today.
    expect(
      screen.getByRole("button", { name: /check in/i })
    ).toBeInTheDocument();
    // Check Out NOT offered for SCHEDULED.
    expect(
      screen.queryByRole("button", { name: /check out/i })
    ).not.toBeInTheDocument();
  });

  it("PRESENT today renders Check Out only; LATE renders BOTH; ABSENT renders NEITHER", async () => {
    wireMy({
      shifts: [
        shiftFixture({
          id: "shift-present",
          type: "MORNING",
          status: "PRESENT",
        }),
        shiftFixture({
          id: "shift-late",
          type: "AFTERNOON",
          status: "LATE",
        }),
        shiftFixture({
          id: "shift-absent",
          type: "NIGHT",
          status: "ABSENT",
        }),
      ],
    });

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    // LATE produces one Check In AND one Check Out.
    // PRESENT adds another Check Out.
    // ABSENT adds nothing.
    // Net: 1 Check In, 2 Check Outs.
    const checkIns = screen.getAllByRole("button", { name: /check in/i });
    const checkOuts = screen.getAllByRole("button", { name: /check out/i });
    expect(checkIns).toHaveLength(1);
    expect(checkOuts).toHaveLength(2);

    // Status pills render for each.
    expect(screen.getByText("PRESENT")).toBeInTheDocument();
    expect(screen.getByText("LATE")).toBeInTheDocument();
    expect(screen.getByText("ABSENT")).toBeInTheDocument();
  });

  it("does NOT render Check In/Out for a non-today shift even if SCHEDULED", async () => {
    wireMy({
      shifts: [
        shiftFixture({
          id: "shift-tomorrow",
          date: tomorrowKey(),
          status: "SCHEDULED",
        }),
      ],
    });

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    // Shift type renders (so we know the shift rendered),
    expect(screen.getByText("MORNING")).toBeInTheDocument();
    // but no Check In or Check Out buttons exist for a non-today shift.
    expect(
      screen.queryByRole("button", { name: /check in/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /check out/i })
    ).not.toBeInTheDocument();
  });

  it("renders 'No shifts' on days with no shifts", async () => {
    wireMy({ shifts: [] });

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    // Every one of the 7 day cards renders "No shifts".
    expect(screen.getAllByText(/^no shifts$/i)).toHaveLength(7);
  });

  it("Check In PATCHes /shifts/:id/check-in and reloads", async () => {
    wireMy({
      shifts: [shiftFixture({ id: "shift-checkin-me", status: "SCHEDULED" })],
    });
    apiMock.patch.mockResolvedValue({ data: {} });

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /check in/i }));

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/shifts/shift-checkin-me/check-in"
      );
    });

    // Both lists reload — at least 2 calls to /shifts/my (initial + reload).
    await waitFor(() => {
      const shiftsCalls = apiMock.get.mock.calls.filter(
        ([url]) => url === "/shifts/my"
      );
      expect(shiftsCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("Check-in failure raises a toast", async () => {
    wireMy({
      shifts: [shiftFixture({ id: "shift-fail", status: "SCHEDULED" })],
    });
    apiMock.patch.mockRejectedValue(new Error("Check-in window closed"));

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /check in/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Check-in window closed");
    });
  });

  it("renders the leave summary tiles + per-type breakdown when used > 0", async () => {
    wireMy({
      summary: {
        pending: 2,
        approved: 5,
        used: { CASUAL: 3, SICK: 1 },
      },
    });

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    // Pending count.
    expect(screen.getByText("2")).toBeInTheDocument();
    // Approved count.
    expect(screen.getByText("5")).toBeInTheDocument();
    // totalUsed = CASUAL(3) + SICK(1) = 4.
    expect(screen.getByText("4")).toBeInTheDocument();
    // Per-type breakdown labels.
    expect(screen.getByText("CASUAL")).toBeInTheDocument();
    expect(screen.getByText("SICK")).toBeInTheDocument();
    // No "No leaves taken yet" since used values are non-zero.
    expect(screen.queryByText(/no leaves taken yet/i)).not.toBeInTheDocument();
  });

  it("renders 'No leaves taken yet' when every used-type count is zero", async () => {
    wireMy({
      summary: {
        pending: 0,
        approved: 0,
        used: { CASUAL: 0, SICK: 0 },
      },
    });

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    expect(screen.getByText(/no leaves taken yet/i)).toBeInTheDocument();
  });

  it("opens the Request Leave modal, submits, POSTs /leaves, reloads, and closes", async () => {
    wireMy({});
    apiMock.post.mockResolvedValue({ data: { id: "new-leave" } });

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    // Open modal via the Request Leave button.
    fireEvent.click(screen.getByRole("button", { name: /request leave/i }));

    // Modal heading appears.
    const modalHeading = await screen.findByRole("heading", {
      name: /request leave/i,
    });
    expect(modalHeading).toBeInTheDocument();

    // Fill form fields.
    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: "2026-06-03" },
    });
    fireEvent.change(screen.getByLabelText(/^reason$/i), {
      target: { value: "Family event" },
    });

    fireEvent.click(screen.getByRole("button", { name: /submit request/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/leaves", {
        type: "CASUAL",
        fromDate: "2026-06-01",
        toDate: "2026-06-03",
        reason: "Family event",
      });
    });

    // Modal closes.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /request leave/i })
      ).not.toBeInTheDocument()
    );

    // Lists reload.
    const shiftsCalls = apiMock.get.mock.calls.filter(
      ([url]) => url === "/shifts/my"
    );
    expect(shiftsCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("Request Leave — empty fromDate triggers a toast and does NOT POST", async () => {
    wireMy({});

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /request leave/i }));
    await screen.findByRole("heading", { name: /request leave/i });

    // Leave dates empty, fill only reason.
    fireEvent.change(screen.getByLabelText(/^reason$/i), {
      target: { value: "Whatever" },
    });

    fireEvent.click(screen.getByRole("button", { name: /submit request/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "From and To dates are required"
      );
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Request Leave — empty reason triggers a toast and does NOT POST", async () => {
    wireMy({});

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /request leave/i }));
    await screen.findByRole("heading", { name: /request leave/i });

    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: "2026-06-03" },
    });
    // reason stays blank.

    fireEvent.click(screen.getByRole("button", { name: /submit request/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Reason is required");
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Request Leave — POST rejection raises a toast and keeps the modal open", async () => {
    wireMy({});
    apiMock.post.mockRejectedValue(new Error("Overlapping leave exists"));

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /request leave/i }));
    await screen.findByRole("heading", { name: /request leave/i });

    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: "2026-06-03" },
    });
    fireEvent.change(screen.getByLabelText(/^reason$/i), {
      target: { value: "Family event" },
    });

    fireEvent.click(screen.getByRole("button", { name: /submit request/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Overlapping leave exists");
    });
    // Modal stays open after the rejection (no reset).
    expect(
      screen.getByRole("heading", { name: /request leave/i })
    ).toBeInTheDocument();
  });

  it("Cancel button in the modal closes the modal without POSTing", async () => {
    wireMy({});

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /request leave/i }));
    const modalHeading = await screen.findByRole("heading", {
      name: /request leave/i,
    });

    // The form's Cancel button lives next to Submit Request.
    const modalForm = modalHeading.closest("form") as HTMLElement;
    const cancelBtn = within(modalForm).getByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancelBtn);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /request leave/i })
      ).not.toBeInTheDocument()
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Initial fetch rejection clears loading and still renders the week grid", async () => {
    wireMy({ shiftsError: new Error("503 down") });

    render(<MySchedulePage />);

    // Loading flips off even though the fetch threw.
    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );
    // Week grid still renders — all 7 day cards present, all showing "No shifts".
    expect(screen.getAllByText(/^no shifts$/i)).toHaveLength(7);
    // Header chrome present.
    expect(
      screen.getByRole("heading", { name: /my schedule/i })
    ).toBeInTheDocument();
    // Request Leave action button still renders even after the fetch error.
    expect(
      screen.getByRole("button", { name: /request leave/i })
    ).toBeInTheDocument();
  });

  it("Skips the certifications fetch when the auth user has no id", async () => {
    // Override the default: no user => no userId => panel short-circuits.
    authMock.mockReturnValue({ user: null });
    wireMy({});

    render(<MySchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-schedule-loading")).not.toBeInTheDocument()
    );

    // The certifications endpoint must never be hit.
    const certCalls = apiMock.get.mock.calls.filter(
      ([url]: unknown[]) =>
        typeof url === "string" && url.startsWith("/hr-ops/certifications"),
    );
    expect(certCalls).toHaveLength(0);
  });
});
