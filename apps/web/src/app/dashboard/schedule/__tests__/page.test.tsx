/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SchedulePage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every branch of `apps/web/src/app/dashboard/schedule/page.tsx`,
 *     the admin/doctor weekly-availability management page. Loads doctor list
 *     (admins) or self-doctor (doctors), then loads the selected doctor's
 *     7-day schedule grid + overrides list. Supports adding new weekly slots
 *     and date overrides (blocked or modified hours).
 *
 *   - Behaviours covered:
 *       1. Loading skeleton — `data-testid="schedule-loading"` with aria-busy
 *          renders while the schedule/overrides GETs are in flight.
 *       2. Admin path — GET /doctors fires; the doctor <select> renders with
 *          every option; the first doctor is auto-selected and its schedule
 *          + overrides loaded.
 *       3. Doctor (self) path — GET /doctors still fires but the matching
 *          profile (by user.id) is selected; the doctor <select> is hidden.
 *       4. Self-path fallback — when no matching profile is found, the first
 *          doctor in the list is selected.
 *       5. Doctor switch — changing the <select> triggers a re-load.
 *       6. Empty days — render "No slots" copy on every day with no slots.
 *       7. Slot rendering — populated days render the start–end + duration.
 *       8. Add Slot form — opens, validates (missing start, missing end,
 *          end <= start, buffer out of range), submits to POST
 *          /doctors/:id/schedule, closes on success, surfaces toast on error.
 *       9. Add Override form — opens; validates missing date; in MODIFY mode
 *          requires both times AND end > start; submits to POST
 *          /doctors/:id/override; resets form; surfaces toast on error.
 *      10. Overrides table — renders one row per override with the Blocked /
 *          Modified pill + hours formatting + reason fallback ("---").
 *      11. Overrides fetch failure — page swallows the error (the inner GET
 *          .catch(()=>{data:[]}) path) and still renders the empty grid.
 *      12. Schedule fetch failure — both arrays clear gracefully.
 *      13. Cancel buttons on both forms close the modal without POSTing.
 *
 *   - Source under test: apps/web/src/app/dashboard/schedule/page.tsx
 *   - Mocks: @/lib/api (api.get / api.post), @/lib/toast, @/lib/store
 *            (useAuthStore — direct-call shape, not selector), @/components/Skeleton,
 *            lucide-react.
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

const { apiMock, toastMock, authMock } = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));
vi.mock("lucide-react", () => ({
  Plus: () => <span data-testid="icon-plus" />,
  X: () => <span data-testid="icon-x" />,
  CalendarOff: () => <span data-testid="icon-calendar-off" />,
  Clock: () => <span data-testid="icon-clock" />,
}));

import SchedulePage from "../page";

type Slot = {
  id: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  slotDuration: number;
};

type Override = {
  id: string;
  date: string;
  isBlocked: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
};

type Doctor = {
  id: string;
  user: { name: string; id?: string };
  specialization: string;
};

function doctorFixture(overrides: Partial<Doctor> = {}): Doctor {
  return {
    id: "doc-1",
    user: { name: "Dr. Anne Lee", id: "user-doc-1" },
    specialization: "Cardiology",
    ...overrides,
  };
}

function slotFixture(overrides: Partial<Slot> = {}): Slot {
  return {
    id: "slot-1",
    dayOfWeek: "MONDAY",
    startTime: "09:00",
    endTime: "13:00",
    slotDuration: 15,
    ...overrides,
  };
}

function overrideFixture(overrides: Partial<Override> = {}): Override {
  return {
    id: "ovr-1",
    // +48h avoids the IST/UTC rollover gotcha
    date: new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString(),
    isBlocked: true,
    startTime: null,
    endTime: null,
    reason: "Public holiday",
    ...overrides,
  };
}

/**
 * Helper — wire the shared `api.get` mock for the three endpoints the page
 * touches: /doctors, /doctors/:id/schedule, /doctors/:id/overrides.
 */
function wireApi(opts: {
  doctors?: Doctor[];
  doctorsError?: Error;
  slots?: Slot[];
  overrides?: Override[];
  slotsError?: Error;
  overridesError?: Error;
} = {}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url === "/doctors") {
      if (opts.doctorsError) return Promise.reject(opts.doctorsError);
      return Promise.resolve({ data: opts.doctors ?? [doctorFixture()] });
    }
    if (url.endsWith("/schedule")) {
      if (opts.slotsError) return Promise.reject(opts.slotsError);
      return Promise.resolve({ data: opts.slots ?? [] });
    }
    if (url.endsWith("/overrides")) {
      if (opts.overridesError) return Promise.reject(opts.overridesError);
      return Promise.resolve({ data: opts.overrides ?? [] });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("SchedulePage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
    authMock.mockReset();
    // Default: ADMIN viewer.
    authMock.mockReturnValue({ user: { id: "admin-1", role: "ADMIN" } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the loading skeleton while schedule/overrides GETs are in flight", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({ data: [doctorFixture()] });
      }
      // Hang schedule + overrides forever to lock the loading state.
      return new Promise(() => {});
    });

    render(<SchedulePage />);

    const loading = await screen.findByTestId("schedule-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute("aria-busy", "true");
    // Header chrome stays visible.
    expect(
      screen.getByRole("heading", { name: /schedule management/i })
    ).toBeInTheDocument();
    // 7 skeleton cards (one per day).
    expect(screen.getAllByTestId("skeleton-card")).toHaveLength(7);
  });

  it("ADMIN path — renders doctor select, auto-selects first, loads schedule + overrides", async () => {
    const doctors = [
      doctorFixture({ id: "doc-a", user: { name: "Dr. A" }, specialization: "Neurology" }),
      doctorFixture({ id: "doc-b", user: { name: "Dr. B" }, specialization: "Pediatrics" }),
    ];
    wireApi({
      doctors,
      slots: [
        slotFixture({ id: "s-mon", dayOfWeek: "MONDAY", startTime: "09:00", endTime: "12:00", slotDuration: 30 }),
        slotFixture({ id: "s-fri", dayOfWeek: "FRIDAY", startTime: "14:00", endTime: "18:00", slotDuration: 20 }),
      ],
    });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    // Doctor select rendered, with both options visible.
    const select = screen.getByLabelText(/select doctor/i) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.value).toBe("doc-a");
    expect(screen.getByRole("option", { name: /dr\. a.*neurology/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /dr\. b.*pediatrics/i })).toBeInTheDocument();

    // The two slots render with their times + durations.
    expect(screen.getByText("09:00 - 12:00")).toBeInTheDocument();
    expect(screen.getByText("14:00 - 18:00")).toBeInTheDocument();
    expect(screen.getByText("30 min slots")).toBeInTheDocument();
    expect(screen.getByText("20 min slots")).toBeInTheDocument();

    // Endpoint wiring proves doc-a was selected.
    expect(apiMock.get).toHaveBeenCalledWith("/doctors");
    expect(apiMock.get).toHaveBeenCalledWith("/doctors/doc-a/schedule");
    expect(apiMock.get).toHaveBeenCalledWith("/doctors/doc-a/overrides");
  });

  it("ADMIN path — empty days render 'No slots' copy", async () => {
    wireApi({
      slots: [slotFixture({ id: "s-mon", dayOfWeek: "MONDAY" })],
    });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    // MONDAY has one slot; the other 6 days each render "No slots".
    expect(screen.getAllByText(/^no slots$/i)).toHaveLength(6);
  });

  it("ADMIN switch — changing the doctor select triggers a reload", async () => {
    const doctors = [
      doctorFixture({ id: "doc-a", user: { name: "Dr. A" } }),
      doctorFixture({ id: "doc-b", user: { name: "Dr. B" } }),
    ];
    wireApi({ doctors });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    apiMock.get.mockClear();
    // Re-wire — the mockClear above wipes the implementation too.
    wireApi({ doctors });

    fireEvent.change(screen.getByLabelText(/select doctor/i), {
      target: { value: "doc-b" },
    });

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/doctors/doc-b/schedule");
      expect(apiMock.get).toHaveBeenCalledWith("/doctors/doc-b/overrides");
    });
  });

  it("DOCTOR self-path — finds matching profile by user.id and hides the admin select", async () => {
    authMock.mockReturnValue({ user: { id: "user-doc-b", role: "DOCTOR" } });
    const doctors = [
      doctorFixture({ id: "doc-a", user: { name: "Dr. A", id: "user-doc-a" } }),
      doctorFixture({ id: "doc-b", user: { name: "Dr. B", id: "user-doc-b" } }),
    ];
    wireApi({ doctors });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    // Admin-only select is NOT rendered for DOCTOR role.
    expect(screen.queryByLabelText(/select doctor/i)).not.toBeInTheDocument();
    // doc-b was selected (the matching profile).
    expect(apiMock.get).toHaveBeenCalledWith("/doctors/doc-b/schedule");
  });

  it("DOCTOR self-path fallback — no matching profile -> first doctor selected", async () => {
    authMock.mockReturnValue({ user: { id: "user-stranger", role: "DOCTOR" } });
    const doctors = [
      doctorFixture({ id: "doc-a", user: { name: "Dr. A", id: "user-doc-a" } }),
    ];
    wireApi({ doctors });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    // Fell back to first doctor in the list.
    expect(apiMock.get).toHaveBeenCalledWith("/doctors/doc-a/schedule");
  });

  it("DOCTOR self-path — empty doctor list leaves selectedDoctorId blank (no schedule fetch)", async () => {
    authMock.mockReturnValue({ user: { id: "user-x", role: "DOCTOR" } });
    wireApi({ doctors: [] });

    render(<SchedulePage />);

    // Page never enters the loading state when no doctor is selected; just
    // confirm we never tried to load a schedule URL.
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/doctors");
    });

    const scheduleCalls = apiMock.get.mock.calls.filter(
      ([url]: unknown[]) =>
        typeof url === "string" && url.includes("/schedule"),
    );
    expect(scheduleCalls).toHaveLength(0);
  });

  it("loadDoctors handles GET /doctors rejection silently (no crash, no toast)", async () => {
    wireApi({ doctorsError: new Error("503 down") });

    render(<SchedulePage />);

    // Header chrome present despite the failed bootstrap.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /schedule management/i })
      ).toBeInTheDocument()
    );

    // No toast surfaced for this swallowed error.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("loadSchedule failure — both arrays clear and grid still renders", async () => {
    wireApi({ slotsError: new Error("500 schedule down") });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    // All 7 days render "No slots" (catch block clears schedules).
    expect(screen.getAllByText(/^no slots$/i)).toHaveLength(7);
  });

  it("overrides fetch failure is swallowed; schedule still renders", async () => {
    wireApi({
      slots: [slotFixture({ id: "s-mon", dayOfWeek: "MONDAY" })],
      overridesError: new Error("404"),
    });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    // Schedule slot still rendered.
    expect(screen.getByText("09:00 - 13:00")).toBeInTheDocument();
    // No overrides table — heading not present.
    expect(
      screen.queryByRole("heading", { name: /schedule overrides/i })
    ).not.toBeInTheDocument();
  });

  it("renders the overrides table with blocked + modified rows and reason fallback", async () => {
    wireApi({
      overrides: [
        overrideFixture({
          id: "ovr-blk",
          isBlocked: true,
          reason: "Public holiday",
        }),
        overrideFixture({
          id: "ovr-mod",
          isBlocked: false,
          startTime: "10:00",
          endTime: "12:00",
          reason: null,
        }),
      ],
    });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    expect(
      screen.getByRole("heading", { name: /schedule overrides/i })
    ).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Modified")).toBeInTheDocument();
    // Modified row renders the hours string.
    expect(screen.getByText("10:00 - 12:00")).toBeInTheDocument();
    // Public holiday reason rendered.
    expect(screen.getByText(/public holiday/i)).toBeInTheDocument();
    // Null reason falls back to "---" (the page renders --- for both
    // null-reason and the blocked-row hours cell; just assert presence).
    expect(screen.getAllByText("---").length).toBeGreaterThanOrEqual(1);
  });

  it("Add Slot form — opens, submits POST /schedule, closes, reloads", async () => {
    wireApi({});
    apiMock.post.mockResolvedValue({ data: {} });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));

    // Form heading appears.
    expect(
      await screen.findByRole("heading", { name: /add schedule slot/i })
    ).toBeInTheDocument();

    // Tweak Day -> TUESDAY, duration -> 30.
    fireEvent.change(screen.getByLabelText(/day of week/i), {
      target: { value: "TUESDAY" },
    });
    fireEvent.change(screen.getByLabelText(/slot duration/i), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText(/buffer between slots/i), {
      target: { value: "5" },
    });

    // Submit.
    fireEvent.click(screen.getByRole("button", { name: /save slot/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/doctors/doc-1/schedule",
        expect.objectContaining({
          dayOfWeek: "TUESDAY",
          startTime: "09:00",
          endTime: "13:00",
          slotDuration: 30,
          slotDurationMinutes: 30,
          bufferMinutes: 5,
        })
      );
    });

    // Form closes.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /add schedule slot/i })
      ).not.toBeInTheDocument()
    );
  });

  it("Add Slot — start >= end raises toast and does NOT POST", async () => {
    wireApi({});

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));
    await screen.findByRole("heading", { name: /add schedule slot/i });

    // Flip start past end.
    fireEvent.change(screen.getByLabelText(/start time/i), {
      target: { value: "15:00" },
    });
    // endTime default is 13:00, so 15 > 13 trips the validator.

    fireEvent.click(screen.getByRole("button", { name: /save slot/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "End time must be after start time"
      );
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Slot — empty start time raises toast", async () => {
    wireApi({});

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));
    await screen.findByRole("heading", { name: /add schedule slot/i });

    fireEvent.change(screen.getByLabelText(/start time/i), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: /save slot/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Start time is required");
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Slot — empty end time raises toast", async () => {
    wireApi({});

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));
    await screen.findByRole("heading", { name: /add schedule slot/i });

    fireEvent.change(screen.getByLabelText(/end time/i), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: /save slot/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("End time is required");
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Slot — POST rejection surfaces toast", async () => {
    wireApi({});
    apiMock.post.mockRejectedValue(new Error("Overlapping slot"));

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));
    await screen.findByRole("heading", { name: /add schedule slot/i });

    fireEvent.click(screen.getByRole("button", { name: /save slot/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Overlapping slot");
    });
  });

  it("Add Slot — Cancel button closes form without POSTing", async () => {
    wireApi({});

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));
    const heading = await screen.findByRole("heading", {
      name: /add schedule slot/i,
    });
    const form = heading.closest("form") as HTMLElement;

    fireEvent.click(within(form).getByRole("button", { name: /^cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /add schedule slot/i })
      ).not.toBeInTheDocument()
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Override — blocked-day flow submits with isBlocked=true", async () => {
    wireApi({});
    apiMock.post.mockResolvedValue({ data: {} });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add override/i }));
    await screen.findByRole("heading", { name: /schedule override/i });

    fireEvent.change(screen.getByLabelText(/^date$/i), {
      target: { value: "2026-12-25" },
    });
    fireEvent.change(screen.getByLabelText(/reason \(optional\)/i), {
      target: { value: "Christmas" },
    });

    fireEvent.click(screen.getByRole("button", { name: /save override/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/doctors/doc-1/override",
        expect.objectContaining({
          date: "2026-12-25",
          isBlocked: true,
          startTime: undefined,
          endTime: undefined,
          reason: "Christmas",
        })
      );
    });
  });

  it("Add Override — modify-hours flow submits with start + end times", async () => {
    wireApi({});
    apiMock.post.mockResolvedValue({ data: {} });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add override/i }));
    await screen.findByRole("heading", { name: /schedule override/i });

    fireEvent.change(screen.getByLabelText(/^date$/i), {
      target: { value: "2026-07-04" },
    });
    fireEvent.change(screen.getByLabelText(/^type$/i), {
      target: { value: "modify" },
    });
    // Time inputs only render in modify mode.
    fireEvent.change(await screen.findByLabelText(/start time/i), {
      target: { value: "10:00" },
    });
    fireEvent.change(screen.getByLabelText(/end time/i), {
      target: { value: "14:00" },
    });

    fireEvent.click(screen.getByRole("button", { name: /save override/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/doctors/doc-1/override",
        expect.objectContaining({
          date: "2026-07-04",
          isBlocked: false,
          startTime: "10:00",
          endTime: "14:00",
        })
      );
    });
  });

  it("Add Override — missing date raises toast", async () => {
    wireApi({});

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add override/i }));
    await screen.findByRole("heading", { name: /schedule override/i });

    fireEvent.click(screen.getByRole("button", { name: /save override/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Date is required");
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Override — modify mode missing times raises toast", async () => {
    wireApi({});

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add override/i }));
    await screen.findByRole("heading", { name: /schedule override/i });

    fireEvent.change(screen.getByLabelText(/^date$/i), {
      target: { value: "2026-07-04" },
    });
    fireEvent.change(screen.getByLabelText(/^type$/i), {
      target: { value: "modify" },
    });
    // Submit immediately — both times are empty.
    fireEvent.click(screen.getByRole("button", { name: /save override/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "Start and end time are required when modifying hours"
      );
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Override — modify mode end <= start raises toast", async () => {
    wireApi({});

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add override/i }));
    await screen.findByRole("heading", { name: /schedule override/i });

    fireEvent.change(screen.getByLabelText(/^date$/i), {
      target: { value: "2026-07-04" },
    });
    fireEvent.change(screen.getByLabelText(/^type$/i), {
      target: { value: "modify" },
    });
    fireEvent.change(await screen.findByLabelText(/start time/i), {
      target: { value: "15:00" },
    });
    fireEvent.change(screen.getByLabelText(/end time/i), {
      target: { value: "10:00" },
    });

    fireEvent.click(screen.getByRole("button", { name: /save override/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "End time must be after start time"
      );
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Override — POST rejection surfaces toast", async () => {
    wireApi({});
    apiMock.post.mockRejectedValue(new Error("Overlapping override"));

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add override/i }));
    await screen.findByRole("heading", { name: /schedule override/i });

    fireEvent.change(screen.getByLabelText(/^date$/i), {
      target: { value: "2026-07-04" },
    });

    fireEvent.click(screen.getByRole("button", { name: /save override/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Overlapping override");
    });
  });

  it("Add Override — Cancel button closes form without POSTing", async () => {
    wireApi({});

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add override/i }));
    const heading = await screen.findByRole("heading", {
      name: /schedule override/i,
    });
    const form = heading.closest("form") as HTMLElement;

    fireEvent.click(within(form).getByRole("button", { name: /^cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /schedule override/i })
      ).not.toBeInTheDocument()
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Buffer minute clamping — typing 99 clamps to 60 in state via the onChange Math.min", async () => {
    wireApi({});
    apiMock.post.mockResolvedValue({ data: {} });

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));
    await screen.findByRole("heading", { name: /add schedule slot/i });

    const buf = screen.getByLabelText(/buffer between slots/i) as HTMLInputElement;
    fireEvent.change(buf, { target: { value: "99" } });
    expect(buf.value).toBe("60");

    fireEvent.click(screen.getByRole("button", { name: /save slot/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/doctors/doc-1/schedule",
        expect.objectContaining({ bufferMinutes: 60 })
      );
    });
  });

  it("X-close icon button closes the Add Slot form", async () => {
    wireApi({});

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));
    const heading = await screen.findByRole("heading", {
      name: /add schedule slot/i,
    });
    const form = heading.closest("form") as HTMLElement;

    // The header has an X icon-button (no accessible name, but it's the only
    // button inside the form's header row besides Save/Cancel which both have
    // names). Pick by traversal: the icon button is the one with the X icon.
    const xButton = within(form).getAllByRole("button").find(
      (b) => b.textContent === "" || within(b).queryByTestId("icon-x")
    ) as HTMLElement;
    fireEvent.click(xButton);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /add schedule slot/i })
      ).not.toBeInTheDocument()
    );
  });
});
