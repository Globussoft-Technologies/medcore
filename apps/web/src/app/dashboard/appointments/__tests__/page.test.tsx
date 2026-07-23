/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AppointmentsPage — colocated coverage tests (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/appointments/page.tsx, the 3322-line
 *     receptionist + patient + admin appointments surface. The sibling test
 *     file at apps/web/src/app/dashboard/__tests__/appointments.page.test.tsx
 *     covers booking-panel + channel-derivation + #950 lock + past-slot
 *     gating; this file fills the long-tail gaps:
 *       - Patient (self-booking) flow + tab switching (upcoming/past/cancelled)
 *       - View toggle: list → calendar → stats; stats view rendering
 *       - Reschedule modal (date change → loadReschedSlots → confirmReschedule)
 *       - Cancel confirmation dialog (Keep vs Confirm Cancel branches)
 *       - Status transitions: CHECK_IN / START_CONSULT / COMPLETE buttons
 *       - Bulk action bar (select-all, Cancel/NoShow/SendReminder)
 *       - Top-bar Next Available (no slot path → toast.info)
 *       - exportCSV (empty → info; non-empty → blob download)
 *       - Recurring booking POST shape
 *       - Waitlist + Group + Coordinated Visit modals (open + save)
 *       - Deep link ?book=1 + ?id=<id> highlight
 *       - Calendar event-detail popup (reschedule + cancel + mark complete)
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/use-dialog,
 *     next/navigation. The page is rendered in isolation; no DialogProvider
 *     tree is mounted, so useConfirm is mocked to auto-accept.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock, confirmMock, pushMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  confirmMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/appointments",
}));

import AppointmentsPage from "../page";

function asRole(role: string, extras: Record<string, unknown> = {}) {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u1", name: "User", email: "u@x.com", role, ...extras },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function plus2DaysIso() {
  // Per task hard-rule 6: +48h not +24h (IST/UTC safe).
  const d = new Date(Date.now() + 48 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function appt(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    tokenNumber: 1,
    date: todayIso(),
    // Default to a no-slot (token/calling-style) row so the fixture is never
    // "past" intraday: with a slot time, today+10:00 flips to NO_SHOW after
    // 10am and hides the row's actions (which are gated on the effective
    // display status). No slot + today's date is deterministically not-past.
    slotStart: null,
    type: "REGULAR",
    status: "BOOKED",
    priority: "NORMAL",
    patient: {
      user: { name: "Asha Roy", phone: "9000000001" },
      mrNumber: "MR-1",
    },
    doctor: { user: { name: "Dr. Singh" } },
    ...overrides,
  };
}

describe("AppointmentsPage — colocated coverage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    apiMock.put.mockReset();
    apiMock.delete.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    toastMock.info.mockReset();
    toastMock.warning.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    pushMock.mockReset();
    asRole("RECEPTION");
    apiMock.get.mockResolvedValue({ data: [] });
    document.documentElement.classList.remove("dark");
    // Reset history search params for each test.
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", "/dashboard/appointments");
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Role-based top-bar rendering ──────────────────────────────────

  it("RECEPTION sees Book / Join Waitlist / Group Appointment top-bar actions", async () => {
    render(<AppointmentsPage />);
    expect(
      await screen.findByRole("button", { name: /book appointment/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join waitlist/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /group appointment/i })).toBeInTheDocument();
    // RECEPTION must NOT see the ADMIN-only Coordinate Multi-Doctor Visit.
    expect(
      screen.queryByRole("button", { name: /coordinate multi-doctor visit/i }),
    ).toBeNull();
  });

  it("ADMIN sees the Coordinate Multi-Doctor Visit action", async () => {
    asRole("ADMIN");
    render(<AppointmentsPage />);
    expect(
      await screen.findByRole("button", { name: /coordinate multi-doctor visit/i }),
    ).toBeInTheDocument();
  });

  it("DOCTOR is non-RECEPTION/non-ADMIN — top-bar action bar is hidden", async () => {
    asRole("DOCTOR");
    apiMock.get.mockResolvedValue({ data: [] });
    render(<AppointmentsPage />);
    // Heading renders, but Join Waitlist + Group Appointment are gated.
    // (Empty state CTA "Book appointment" is rendered by EmptyState — that's
    // a different surface; we assert specifically on the top-bar gated ones.)
    await screen.findByRole("heading", { name: /appointments/i });
    expect(screen.queryByRole("button", { name: /join waitlist/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /group appointment/i })).toBeNull();
  });

  // ─── Patient self-booking surface ─────────────────────────────────

  it("PATIENT role: fetches /auth/me on mount and renders the patient tabs (no filter date input)", async () => {
    asRole("PATIENT");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") {
        return Promise.resolve({
          data: { name: "Asha Roy", patient: { id: "pat-self" } },
        });
      }
      if (url.startsWith("/appointments")) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: [] });
    });
    render(<AppointmentsPage />);

    // Patient tabs visible.
    expect(await screen.findByRole("button", { name: /upcoming/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /past/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancelled/i })).toBeInTheDocument();

    // The patient endpoint omits ?date= (limit=200 path).
    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u === "/appointments?limit=200")).toBe(true);
    });

    // The non-isPatient filter date input is absent.
    expect(screen.queryByLabelText(/filter by date/i)).toBeNull();
    // Stats view tab is hidden for patients.
    expect(screen.queryByRole("button", { name: /stats/i })).toBeNull();
  });

  it("PATIENT past tab filters down to COMPLETED + NO_SHOW + past-date BOOKED rows", async () => {
    asRole("PATIENT");
    const past = `${new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)}`;
    const data = [
      appt({ id: "a-up", status: "BOOKED", date: plus2DaysIso(), tokenNumber: 10 }),
      appt({ id: "a-cmp", status: "COMPLETED", date: past, tokenNumber: 11 }),
      appt({ id: "a-ns", status: "NO_SHOW", date: past, tokenNumber: 12 }),
      appt({ id: "a-pb", status: "BOOKED", date: past, tokenNumber: 13 }),
      appt({ id: "a-cx", status: "CANCELLED", date: past, tokenNumber: 14 }),
    ];
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") {
        return Promise.resolve({
          data: { name: "Asha Roy", patient: { id: "pat-self" } },
        });
      }
      if (url.startsWith("/appointments")) {
        return Promise.resolve({ data });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<AppointmentsPage />);

    // Default tab = upcoming → only token 10. Token cell renders via
    // appointmentRefLabel(apt) → "T-<n>" for non-CALLING modes.
    await waitFor(() => expect(screen.getByText("T-10")).toBeInTheDocument());
    expect(screen.queryByText("T-11")).toBeNull();

    // Past tab → tokens 11, 12, 13 (cancelled NOT shown).
    await user.click(screen.getByRole("button", { name: /^past$/i }));
    await waitFor(() => {
      expect(screen.getByText("T-11")).toBeInTheDocument();
      expect(screen.getByText("T-12")).toBeInTheDocument();
      expect(screen.getByText("T-13")).toBeInTheDocument();
    });
    expect(screen.queryByText("T-14")).toBeNull();

    // Cancelled tab → only token 14, NO_SHOW excluded (Issue #387).
    await user.click(screen.getByRole("button", { name: /^cancelled$/i }));
    await waitFor(() => {
      expect(screen.getByText("T-14")).toBeInTheDocument();
    });
    expect(screen.queryByText("T-11")).toBeNull();
    expect(screen.queryByText("T-12")).toBeNull();
  });

  it("PATIENT empty state: 'No upcoming appointments' message renders when the list is empty", async () => {
    asRole("PATIENT");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") {
        return Promise.resolve({
          data: { name: "Asha Roy", patient: { id: "pat-self" } },
        });
      }
      return Promise.resolve({ data: [] });
    });
    render(<AppointmentsPage />);
    expect(
      await screen.findByText(/no upcoming appointments/i),
    ).toBeInTheDocument();
  });

  it("PATIENT empty-state Past + Cancelled tabs surface their distinct copy", async () => {
    asRole("PATIENT");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") {
        return Promise.resolve({
          data: { name: "Asha Roy", patient: { id: "pat-self" } },
        });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await screen.findByText(/no upcoming appointments/i);

    await user.click(screen.getByRole("button", { name: /^past$/i }));
    expect(await screen.findByText(/no past appointments/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^cancelled$/i }));
    expect(
      await screen.findByText(/no cancelled appointments/i),
    ).toBeInTheDocument();
  });

  // ─── View toggle ───────────────────────────────────────────────────

  it("switches list → calendar → stats and fires the matching loader", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments/calendar")) {
        return Promise.resolve({ data: [] });
      }
      if (url.startsWith("/appointments/stats")) {
        return Promise.resolve({
          data: {
            totalCount: 5,
            byStatus: { BOOKED: 2, COMPLETED: 3 },
            completedCount: 3,
            cancelledCount: 0,
            noShowCount: 0,
            avgConsultationTimeMin: 12,
            peakHour: 10,
            peakHourCount: 4,
          },
        });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<AppointmentsPage />);

    // Calendar view button label is "Calendar" (dashboard.common.calendarView).
    await user.click(await screen.findByRole("button", { name: /^calendar$/i }));
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.startsWith("/appointments/calendar?"))).toBe(true);
    });
    // Calendar header row labels rendered.
    expect(screen.getByText("Sun")).toBeInTheDocument();
    // Today button + prev/next week.
    expect(screen.getByRole("button", { name: /today/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /prev week/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next week/i })).toBeInTheDocument();

    // Stats view button label is "Stats" (dashboard.common.statsView).
    await user.click(screen.getByRole("button", { name: /^stats$/i }));
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.startsWith("/appointments/stats?"))).toBe(true);
    });
    // Total/Completed cards.
    expect(await screen.findByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Peak Hour")).toBeInTheDocument();
  });

  it("calendar prev / next week buttons advance calWeekStart and re-fetch", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments/calendar")) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /^calendar$/i }));
    await waitFor(() =>
      expect(
        apiMock.get.mock.calls.some((c) => String(c[0]).startsWith("/appointments/calendar")),
      ).toBe(true),
    );
    const callsBefore = apiMock.get.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /next week/i }));
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(callsBefore),
    );
    const callsAfter = apiMock.get.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /prev week/i }));
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(callsAfter),
    );
    await user.click(screen.getByRole("button", { name: /today/i }));
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(callsAfter + 1),
    );
  });

  it("stats view renders the By Status donut + By Doctor + By Day-of-Week sections", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments/calendar")) {
        return Promise.resolve({
          data: [
            {
              id: "ev1",
              patientName: "Asha",
              doctorId: "d1",
              doctorName: "Dr. Singh",
              startDateTime: `${todayIso()}T10:00:00Z`,
              endDateTime: `${todayIso()}T10:15:00Z`,
              status: "COMPLETED",
              tokenNumber: 1,
              type: "REGULAR",
              priority: "NORMAL",
            },
            {
              id: "ev2",
              patientName: "Bob",
              doctorId: "d1",
              doctorName: "Dr. Singh",
              startDateTime: `${todayIso()}T11:00:00Z`,
              endDateTime: `${todayIso()}T11:15:00Z`,
              status: "BOOKED",
              tokenNumber: 2,
              type: "REGULAR",
              priority: "NORMAL",
            },
          ],
        });
      }
      if (url.startsWith("/appointments/stats")) {
        return Promise.resolve({
          data: {
            totalCount: 2,
            byStatus: { BOOKED: 1, COMPLETED: 1 },
            completedCount: 1,
            cancelledCount: 0,
            noShowCount: 0,
            avgConsultationTimeMin: 15,
            peakHour: 10,
            peakHourCount: 1,
          },
        });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /^stats$/i }));
    expect(await screen.findByText("By Status")).toBeInTheDocument();
    expect(screen.getByText("By Doctor")).toBeInTheDocument();
    expect(screen.getByText("By Day of Week")).toBeInTheDocument();
    // Refresh button on stats.
    await user.click(screen.getByRole("button", { name: /^refresh$/i }));
  });

  it("stats view: API rejection lands on the 'No data.' empty state", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (
        url.startsWith("/appointments/stats") ||
        url.startsWith("/appointments/calendar")
      ) {
        return Promise.reject(new Error("500"));
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /^stats$/i }));
    expect(await screen.findByText(/^no data\.$/i)).toBeInTheDocument();
  });

  // ─── Status transitions ────────────────────────────────────────────

  it("status-transition buttons (Check In / Start Consult / Complete) fire PATCH /status with the right state", async () => {
    // Start Consult / Re-consult are DOCTOR-only (only the doctor conducts the
    // encounter), so this transition test must run as a doctor.
    asRole("DOCTOR");
    // updateStatus now patches just the clicked row in place (no full reload),
    // so the row's new status persists. Give each fixture a distinct patient
    // name and scope each query by name so the three transitions don't collide
    // (e.g. once the BOOKED row is checked in it also exposes a Start Consult
    // button, which would make an unscoped /start consultation/ query
    // ambiguous).
    const named = (name: string, extra: Record<string, unknown>) =>
      appt({
        patient: { user: { name, phone: "9000000009" }, mrNumber: "MR-X" },
        ...extra,
      });
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [
            named("Booked Bob", { id: "a-booked", status: "BOOKED", tokenNumber: 21 }),
            named("Checked Chloe", { id: "a-checked", status: "CHECKED_IN", tokenNumber: 22 }),
            named("Inconsult Ivan", { id: "a-in", status: "IN_CONSULTATION", tokenNumber: 23 }),
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<AppointmentsPage />);

    const checkInBtn = await screen.findByRole("button", { name: /check in booked bob/i });
    await user.click(checkInBtn);
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/appointments/a-booked/status",
        { status: "CHECKED_IN" },
      ),
    );

    const startBtn = screen.getByRole("button", {
      name: /start consultation for checked chloe/i,
    });
    await user.click(startBtn);
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/appointments/a-checked/status",
        { status: "IN_CONSULTATION" },
      ),
    );

    const completeBtn = screen.getByRole("button", {
      name: /mark consultation complete for inconsult ivan/i,
    });
    await user.click(completeBtn);
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/appointments/a-in/status",
        { status: "COMPLETED" },
      ),
    );
  });

  it("status-transition rejection surfaces toast.error with the error message", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [appt({ id: "a-booked", status: "BOOKED" })],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockRejectedValue(new Error("Conflict"));
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    const checkInBtn = await screen.findByRole("button", { name: /check in asha roy/i });
    await user.click(checkInBtn);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Conflict"),
    );
  });

  // ─── Cancel confirmation dialog ───────────────────────────────────

  it("Cancel button opens the confirmation dialog; Keep Appointment closes it", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [appt({ id: "a-booked", status: "BOOKED" })],
        });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    // Staff cancel lives in the ⋮ menu now (no inline Cancel button for staff).
    await user.click(
      await screen.findByRole("button", { name: /more actions for asha roy/i }),
    );
    const cancelBtn = await screen.findByRole("button", {
      name: /cancel appointment for asha roy/i,
    });
    await user.click(cancelBtn);
    // The dialog uses heading text "Cancel Appointment" via the t() key.
    const keepBtn = await screen.findByRole("button", { name: /keep appointment/i });
    expect(keepBtn).toBeInTheDocument();
    await user.click(keepBtn);
    // Dialog dismissed — no PATCH fired.
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Confirm Cancel inside the dialog PATCHes /status with CANCELLED + cancellationReason", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [appt({ id: "a-booked", status: "BOOKED" })],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    // Staff cancel lives in the ⋮ menu now (no inline Cancel button for staff).
    await user.click(
      await screen.findByRole("button", { name: /more actions for asha roy/i }),
    );
    const cancelBtn = await screen.findByRole("button", {
      name: /cancel appointment for asha roy/i,
    });
    await user.click(cancelBtn);
    // Pearl §3.1 (gap closed 2026-05-29): cancellation reason is now
    // required (server-side Zod 3-500 chars). The dashboard's Confirm
    // button is disabled until the reason has at least 3 chars, and
    // confirmCancel() short-circuits otherwise — so the test must enter
    // a reason before clicking Yes, cancel.
    const reasonInput = await screen.findByTestId("cancel-reason");
    await user.type(reasonInput, "Patient called to cancel");
    const confirmBtn = await screen.findByRole("button", { name: /yes, cancel/i });
    await user.click(confirmBtn);
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/appointments/a-booked/status",
        { status: "CANCELLED", cancellationReason: "Patient called to cancel" },
      ),
    );
  });

  it("Confirm Cancel rejection surfaces toast.error and clears cancellingId", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [appt({ id: "a-booked", status: "BOOKED" })],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockRejectedValue(new Error("conflict"));
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    // Staff cancel lives in the ⋮ menu now (no inline Cancel button for staff).
    await user.click(
      await screen.findByRole("button", { name: /more actions for asha roy/i }),
    );
    const cancelBtn = await screen.findByRole("button", {
      name: /cancel appointment for asha roy/i,
    });
    await user.click(cancelBtn);
    // Same §3.1 contract: enter the reason so the submit fires the API
    // call (which then rejects with the simulated conflict error).
    const reasonInput = await screen.findByTestId("cancel-reason");
    await user.type(reasonInput, "Patient called to cancel");
    const confirmBtn = await screen.findByRole("button", { name: /yes, cancel/i });
    await user.click(confirmBtn);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("conflict"),
    );
  });

  // ─── Reschedule modal ─────────────────────────────────────────────

  it("Reschedule button opens the modal, fetches slots, and confirmReschedule PATCHes /reschedule", async () => {
    let rescheduleSlotsCalls = 0;
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/appointments/next-token")) {
        // SLOT-mode doctor → the reschedule modal shows the timed slot grid.
        return Promise.resolve({
          data: { mode: "SLOT", tokenLabel: null, limitReached: false },
        });
      }
      if (url.startsWith("/appointments/a-booked")) {
        return Promise.resolve({ data: { doctorId: "d-1" } });
      }
      if (url.startsWith("/doctors/d-1/slots")) {
        rescheduleSlotsCalls += 1;
        return Promise.resolve({
          data: {
            slots: [{ startTime: "14:00", endTime: "14:15", isAvailable: true }],
          },
        });
      }
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [appt({ id: "a-booked", status: "BOOKED", date: plus2DaysIso() })],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockResolvedValue({ data: {} });

    const user = userEvent.setup();
    render(<AppointmentsPage />);

    const reschedBtn = await screen.findByRole("button", {
      name: /reschedule appointment for asha roy/i,
    });
    await user.click(reschedBtn);

    // Pearl §3.1 (gap closed 2026-05-29): reschedule reason is required
    // (server-side Zod 3-500 chars). confirmReschedule short-circuits
    // with toast.error if the reason is empty, so the test must enter
    // a reason BEFORE clicking the slot button (which is the submit).
    const reasonInput = await screen.findByTestId("resched-reason");
    await user.type(reasonInput, "Doctor schedule changed");

    // Slot button surfaces after loadReschedSlots resolves.
    const slot = await screen.findByRole("button", { name: /^14:00 - 14:15$/ });
    expect(rescheduleSlotsCalls).toBeGreaterThan(0);
    await user.click(slot);

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/appointments/a-booked/reschedule",
        expect.objectContaining({
          slotStart: "14:00",
          reason: "Doctor schedule changed",
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("Reschedule modal: changing the date input re-fires loadReschedSlots for the new date", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/appointments/next-token")) {
        // SLOT-mode doctor → the reschedule modal shows the timed slot grid.
        return Promise.resolve({
          data: { mode: "SLOT", tokenLabel: null, limitReached: false },
        });
      }
      if (url.startsWith("/appointments/a-booked")) {
        return Promise.resolve({ data: { doctorId: "d-1" } });
      }
      if (url.startsWith("/doctors/d-1/slots")) {
        return Promise.resolve({
          data: { slots: [] },
        });
      }
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [appt({ id: "a-booked", status: "BOOKED", date: todayIso() })],
        });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    const reschedBtn = await screen.findByRole("button", {
      name: /reschedule appointment for asha roy/i,
    });
    await user.click(reschedBtn);

    const dateInput = await screen.findByLabelText(/new date/i);
    const callsBefore = apiMock.get.mock.calls.length;
    fireEvent.change(dateInput, { target: { value: plus2DaysIso() } });
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(callsBefore),
    );
    // "No slots available" empty-state copy.
    expect(await screen.findByText(/no slots available/i)).toBeInTheDocument();
  });

  it("Reschedule modal Close button dismisses the modal", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments/a-booked")) {
        return Promise.resolve({ data: { doctorId: "d-1" } });
      }
      if (url.startsWith("/doctors/d-1/slots")) {
        return Promise.resolve({ data: { slots: [] } });
      }
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [appt({ id: "a-booked", status: "BOOKED" })],
        });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    const reschedBtn = await screen.findByRole("button", {
      name: /reschedule appointment for asha roy/i,
    });
    await user.click(reschedBtn);
    await screen.findByLabelText(/new date/i);
    // Close button has aria-label="Close" via t("common.close").
    const closeBtns = screen.getAllByRole("button", { name: /close/i });
    await user.click(closeBtns[0]);
    await waitFor(() => {
      expect(screen.queryByLabelText(/new date/i)).toBeNull();
    });
  });

  // ─── Bulk action bar ──────────────────────────────────────────────

  it("Select-all + Cancel selected fires POST /appointments/bulk-action with the selected ids", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [
            appt({ id: "a-1", tokenNumber: 1 }),
            appt({ id: "a-2", tokenNumber: 2 }),
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({
      data: { requested: 2, processed: 2, skipped: 0, errors: 0 },
    });

    const user = userEvent.setup();
    render(<AppointmentsPage />);
    // Click the select-all checkbox.
    const selectAll = await screen.findByRole("checkbox", {
      name: /select all appointments/i,
    });
    await user.click(selectAll);

    // Bulk action bar appears.
    expect(await screen.findByText(/2 selected/i)).toBeInTheDocument();

    // Cancel selected → opens the (mocked-true) confirm + POSTs bulk-action.
    await user.click(screen.getByRole("button", { name: /^cancel selected$/i }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/appointments/bulk-action",
        expect.objectContaining({
          appointmentIds: expect.arrayContaining(["a-1", "a-2"]),
          action: "CANCEL",
        }),
      );
    });
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("Send reminder bulk action runs without the danger confirm", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({ data: [appt({ id: "a-1" })] });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({
      data: { requested: 1, processed: 1, skipped: 0, errors: 0 },
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    const cb = await screen.findByRole("checkbox", {
      // page.tsx labels each checkbox via appointmentRefLabel(apt), which
      // formats tokenNumber as "T-<n>" for non-CALLING modes. Match the
      // suffix to stay robust if the prefix changes.
      name: /select appointment t-1/i,
    });
    await user.click(cb);
    await user.click(screen.getByRole("button", { name: /send reminder/i }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/appointments/bulk-action",
        expect.objectContaining({ action: "SEND_REMINDER" }),
      ),
    );
  });

  it("Bulk action: when the user rejects the confirm prompt, POST is NOT fired", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({ data: [appt({ id: "a-1" })] });
      }
      return Promise.resolve({ data: [] });
    });
    confirmMock.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    const cb = await screen.findByRole("checkbox", {
      // page.tsx labels each checkbox via appointmentRefLabel(apt), which
      // formats tokenNumber as "T-<n>" for non-CALLING modes. Match the
      // suffix to stay robust if the prefix changes.
      name: /select appointment t-1/i,
    });
    await user.click(cb);
    await user.click(screen.getByRole("button", { name: /mark as no-show/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Bulk action: clearing the selection collapses the bar", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({ data: [appt({ id: "a-1" })] });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    const cb = await screen.findByRole("checkbox", {
      // page.tsx labels each checkbox via appointmentRefLabel(apt), which
      // formats tokenNumber as "T-<n>" for non-CALLING modes. Match the
      // suffix to stay robust if the prefix changes.
      name: /select appointment t-1/i,
    });
    await user.click(cb);
    expect(await screen.findByText(/1 selected/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^clear$/i }));
    await waitFor(() => {
      expect(screen.queryByText(/1 selected/i)).toBeNull();
    });
  });

  // ─── Next Available top-bar (clean open/close toggle) ─────────────
  // The top "Next Available" button is a clean panel toggle: a first click
  // opens a FRESH Book New Appointment panel (cleared patient), a second
  // click (button now red) closes it. It no longer runs the cross-doctor
  // suggestion search or opens a confirm dialog from the top bar.

  it("Next Available (top button) opens a clean booking panel and never surfaces a confirm dialog", async () => {
    apiMock.get.mockImplementation(() => Promise.resolve({ data: [] }));
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(
      await screen.findByRole("button", { name: /^next available$/i }),
    );
    // Opens the Book New Appointment panel...
    expect(
      await screen.findByText(/Book New Appointment/i),
    ).toBeInTheDocument();
    // ...and does NOT surface the cross-doctor confirm dialog.
    expect(
      screen.queryByTestId("confirm-appointment-dialog"),
    ).not.toBeInTheDocument();
  });

  it("Next Available (top button) does not fire the cross-doctor search endpoint", async () => {
    const calls: string[] = [];
    apiMock.get.mockImplementation((url: string) => {
      calls.push(url);
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(
      await screen.findByRole("button", { name: /^next available$/i }),
    );
    await screen.findByText(/Book New Appointment/i);
    // The top button opens a clean panel — it must NOT call the cross-doctor
    // /appointments/next-available search anymore.
    expect(
      calls.some((u) => u.includes("/appointments/next-available")),
    ).toBe(false);
  });

  it("Next Available (top button) toggles the panel closed on a second click", async () => {
    apiMock.get.mockImplementation(() => Promise.resolve({ data: [] }));
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    const btn = await screen.findByRole("button", { name: /^next available$/i });
    await user.click(btn);
    expect(await screen.findByText(/Book New Appointment/i)).toBeInTheDocument();
    // Second click (button is now red) closes the panel.
    await user.click(btn);
    await waitFor(() =>
      expect(screen.queryByText(/Book New Appointment/i)).not.toBeInTheDocument(),
    );
  });

  // ─── Duplicate-open guard (proactive disable + inline note) ────────

  it("disables Book and shows a duplicate note when the patient already has an open appointment with the doctor on that date", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors")
        return Promise.resolve({
          data: [
            {
              id: "d-tok",
              user: { name: "Dr. Tok" },
              specialization: "GP",
              appointmentMode: "TOKEN",
              enabledChannels: ["TOKEN"],
            },
          ],
        });
      if (url.includes("/appointments/next-token"))
        return Promise.resolve({ data: { tokenLabel: null, limitReached: false } });
      // The proactive duplicate pre-check (patientId + doctorId + date) finds
      // an existing OPEN appointment → drives the disable + note.
      if (url.includes("patientId=") && url.includes("doctorId="))
        return Promise.resolve({ data: [{ status: "BOOKED" }] });
      if (url.startsWith("/patients"))
        return Promise.resolve({
          data: [
            {
              id: "pat-1",
              mrNumber: "MR-1",
              user: { name: "Asha Roy", phone: "9000000001" },
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /book appointment/i }));
    await user.click(await screen.findByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name: /Dr\. Tok/i }));
    const patientInput = screen.getByTestId("appt-book-patient-input");
    await user.type(patientInput, "as");
    await user.click(await screen.findByTestId("appt-book-patient-option"));

    // Inline duplicate note appears and the token Book button is disabled.
    expect(
      await screen.findByTestId("appt-book-duplicate-note"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("appt-book-token-add")).toBeDisabled(),
    );
  });

  it("Walk-in channel locks the date to today and hides Book Recurring", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors")
        return Promise.resolve({
          data: [
            {
              id: "d-cal",
              user: { name: "Dr. Cal" },
              specialization: "GP",
              appointmentMode: "CALLING",
              enabledChannels: ["CALLING", "WALKIN"],
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /book appointment/i }));
    await user.click(await screen.findByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name: /Dr\. Cal/i }));
    // Switch to the Walk-in channel.
    await user.click(await screen.findByTestId("appt-book-channel-walkin"));

    // Date input is disabled + hint shown; Book Recurring is hidden.
    const dateInput = document.getElementById(
      "appt-book-date",
    ) as HTMLInputElement | null;
    expect(dateInput).toBeDisabled();
    expect(
      screen.getByText(/Walk-ins are registered for today/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /book recurring/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the Walk-in channel when the doctor is changed", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors")
        return Promise.resolve({
          data: [
            {
              id: "d1",
              user: { name: "Dr. One" },
              specialization: "GP",
              appointmentMode: "CALLING",
              enabledChannels: ["CALLING", "WALKIN"],
            },
            {
              id: "d2",
              user: { name: "Dr. Two" },
              specialization: "GP",
              appointmentMode: "TOKEN",
              enabledChannels: ["TOKEN", "WALKIN"],
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /book appointment/i }));
    await user.click(await screen.findByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name: /Dr\. One/i }));
    await user.click(await screen.findByTestId("appt-book-channel-walkin"));
    // Change the doctor — should STAY on Walk-in (both doctors support it).
    await user.click(screen.getByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name: /Dr\. Two/i }));
    expect(
      await screen.findByTestId("appt-book-walkin-mode"),
    ).toBeInTheDocument();
  });

  it("the in-panel Next Available link jumps a SLOT doctor to their next open slot", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors")
        return Promise.resolve({
          data: [
            {
              id: "d-slot",
              user: { name: "Dr. Slot" },
              specialization: "GP",
              appointmentMode: "SLOT",
              enabledChannels: ["SLOT"],
            },
          ],
        });
      // No slots for the selected date → the no-slots message + link render.
      if (url.startsWith("/doctors/d-slot/slots"))
        return Promise.resolve({ data: { slots: [] } });
      // The scoped Next-Available search returns a future open slot.
      if (url.includes("/appointments/next-available"))
        return Promise.resolve({
          data: { slot: { doctorId: "d-slot", date: "2099-01-02", startTime: "09:00" } },
        });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /book appointment/i }));
    await user.click(await screen.findByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name: /Dr\. Slot/i }));
    // The no-slots message hosts the in-panel "Next Available" link.
    const noSlots = await screen.findByTestId("appt-book-no-slots");
    await user.click(within(noSlots).getByRole("button", { name: /next available/i }));
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringMatching(/next available/i),
      ),
    );
  });

  it("books a TOKEN appointment through the confirm dialog (no duplicate)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors")
        return Promise.resolve({
          data: [
            {
              id: "d-t",
              user: { name: "Dr. T" },
              specialization: "GP",
              appointmentMode: "TOKEN",
              enabledChannels: ["TOKEN"],
              tokenPrefix: "R",
              tokenStartNumber: 1,
            },
          ],
        });
      if (url.includes("/appointments/next-token"))
        return Promise.resolve({ data: { tokenLabel: "R-5", limitReached: false } });
      // Duplicate pre-check → no open appointment.
      if (url.includes("patientId=") && url.includes("doctorId="))
        return Promise.resolve({ data: [] });
      if (url.startsWith("/patients"))
        return Promise.resolve({
          data: [
            {
              id: "pat-1",
              mrNumber: "MR-1",
              user: { name: "Asha Roy", phone: "9000000001" },
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { id: "a-1" } });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /book appointment/i }));
    await user.click(await screen.findByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name: /Dr\. T/i }));
    const patientInput = screen.getByTestId("appt-book-patient-input");
    await user.type(patientInput, "as");
    await user.click(await screen.findByTestId("appt-book-patient-option"));
    // Token "Book (assign token R-5)" → confirm dialog → Confirm.
    await user.click(await screen.findByTestId("appt-book-token-add"));
    await user.click(await screen.findByTestId("confirm-appointment-confirm"));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/appointments/book",
        expect.objectContaining({ patientId: "pat-1", doctorId: "d-t" }),
      ),
    );
  });

  it("registers a walk-in via the walk-in button (no duplicate)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors")
        return Promise.resolve({
          data: [
            {
              id: "d-w",
              user: { name: "Dr. W" },
              specialization: "GP",
              appointmentMode: "CALLING",
              enabledChannels: ["CALLING", "WALKIN"],
            },
          ],
        });
      if (url.includes("patientId=") && url.includes("doctorId="))
        return Promise.resolve({ data: [] });
      if (url.startsWith("/patients"))
        return Promise.resolve({
          data: [
            {
              id: "pat-1",
              mrNumber: "MR-1",
              user: { name: "Asha Roy", phone: "9000000001" },
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { id: "w-1" } });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /book appointment/i }));
    await user.click(await screen.findByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name: /Dr\. W/i }));
    await user.click(await screen.findByTestId("appt-book-channel-walkin"));
    const patientInput = screen.getByTestId("appt-book-patient-input");
    await user.type(patientInput, "as");
    await user.click(await screen.findByTestId("appt-book-patient-option"));
    await user.click(await screen.findByTestId("appt-book-walkin-add"));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/appointments/walk-in",
        expect.objectContaining({ patientId: "pat-1", doctorId: "d-w" }),
      ),
    );
  });

  it("in-panel Next Available link info-toasts when the SLOT doctor has no upcoming slots", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors")
        return Promise.resolve({
          data: [
            {
              id: "d-slot",
              user: { name: "Dr. Slot" },
              specialization: "GP",
              appointmentMode: "SLOT",
              enabledChannels: ["SLOT"],
            },
          ],
        });
      if (url.startsWith("/doctors/d-slot/slots"))
        return Promise.resolve({ data: { slots: [] } });
      if (url.includes("/appointments/next-available"))
        return Promise.resolve({ data: { slot: null } });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /book appointment/i }));
    await user.click(await screen.findByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name: /Dr\. Slot/i }));
    const noSlots = await screen.findByTestId("appt-book-no-slots");
    await user.click(within(noSlots).getByRole("button", { name: /next available/i }));
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith(
        expect.stringMatching(/no open slots/i),
      ),
    );
  });

  it("disables Add-to-queue with a duplicate note for a CALLING doctor with an open appointment", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors")
        return Promise.resolve({
          data: [
            {
              id: "d-c",
              user: { name: "Dr. C" },
              specialization: "GP",
              appointmentMode: "CALLING",
              enabledChannels: ["CALLING"],
            },
          ],
        });
      if (url.includes("patientId=") && url.includes("doctorId="))
        return Promise.resolve({ data: [{ status: "IN_CONSULTATION" }] });
      if (url.startsWith("/patients"))
        return Promise.resolve({
          data: [
            {
              id: "pat-1",
              mrNumber: "MR-1",
              user: { name: "Asha Roy", phone: "9000000001" },
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /book appointment/i }));
    await user.click(await screen.findByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name: /Dr\. C/i }));
    const patientInput = screen.getByTestId("appt-book-patient-input");
    await user.type(patientInput, "as");
    await user.click(await screen.findByTestId("appt-book-patient-option"));
    await waitFor(() =>
      expect(screen.getByTestId("appt-book-calling-add")).toBeDisabled(),
    );
  });

  it("disables slot buttons for a SLOT doctor with an open appointment on that date", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors")
        return Promise.resolve({
          data: [
            {
              id: "d-s",
              user: { name: "Dr. S" },
              specialization: "GP",
              appointmentMode: "SLOT",
              enabledChannels: ["SLOT"],
            },
          ],
        });
      if (url.startsWith("/doctors/d-s/slots"))
        return Promise.resolve({
          data: {
            slots: [{ startTime: "23:55", endTime: "23:59", isAvailable: true }],
          },
        });
      if (url.includes("patientId=") && url.includes("doctorId="))
        return Promise.resolve({ data: [{ status: "BOOKED" }] });
      if (url.startsWith("/patients"))
        return Promise.resolve({
          data: [
            {
              id: "pat-1",
              mrNumber: "MR-1",
              user: { name: "Asha Roy", phone: "9000000001" },
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /book appointment/i }));
    await user.click(await screen.findByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name: /Dr\. S/i }));
    const patientInput = screen.getByTestId("appt-book-patient-input");
    await user.type(patientInput, "as");
    await user.click(await screen.findByTestId("appt-book-patient-option"));
    // The late-day slot renders but is disabled because of the open-appointment
    // duplicate on this date.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /23:55 - 23:59/ }),
      ).toBeDisabled(),
    );
  });

  // ─── Export CSV ───────────────────────────────────────────────────

  it("Export CSV with an empty table surfaces toast.info instead of a blob download", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(
      await screen.findByRole("button", { name: /export appointments to csv/i }),
    );
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith(
        expect.stringMatching(/nothing to export/i),
      ),
    );
  });

  it("Export CSV with rows synthesises a blob download (URL.createObjectURL fired)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [
            appt({ tokenNumber: 7 }),
            // Row with a comma in the name to exercise the CSV quoter.
            appt({
              id: "a-2",
              tokenNumber: 8,
              patient: {
                user: { name: 'Bob, Junior "B"', phone: "9000000002" },
                mrNumber: "MR-2",
              },
            }),
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(
      await screen.findByRole("button", { name: /export appointments to csv/i }),
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  });

  // ─── Calendar .ics download ───────────────────────────────────────

  it("Calendar invite button navigates to the calendar page for that appointment's date", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [appt({ id: "a-booked", status: "BOOKED" })],
        });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<AppointmentsPage />);
    const inviteBtn = await screen.findByRole("button", {
      name: /open calendar for asha roy/i,
    });
    await user.click(inviteBtn);
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        expect.stringContaining(`/dashboard/calendar?date=${todayIso()}`),
      ),
    );
  });

  // ─── Recurring booking POST ───────────────────────────────────────

  it("Recurring booking: POST /appointments/recurring with frequency + occurrences from the form", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [
            {
              id: "d-rec",
              user: { name: "Dr. Recur" },
              specialization: "GP",
              appointmentMode: "SLOT",
              enabledChannels: ["SLOT"],
            },
          ],
        });
      }
      if (url.startsWith("/doctors/d-rec/slots")) {
        return Promise.resolve({
          data: {
            slots: [{ startTime: "23:55", endTime: "23:59", isAvailable: true }],
          },
        });
      }
      if (url.startsWith("/patients")) {
        return Promise.resolve({
          data: [
            {
              id: "pat-1",
              mrNumber: "MR-1",
              user: { name: "Asha Roy", phone: "9000000001" },
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: {} });

    const user = userEvent.setup();
    render(<AppointmentsPage />);

    // Open booking panel.
    await user.click(
      await screen.findByRole("button", { name: /book appointment/i }),
    );
    // Pick doctor.
    await user.click(await screen.findByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name: /Dr\. Recur/i }));
    // Toggle Recurring.
    await user.click(screen.getByRole("button", { name: /book recurring/i }));
    // Change frequency to DAILY.
    const freq = await screen.findByLabelText(/frequency/i);
    fireEvent.change(freq, { target: { value: "DAILY" } });
    // Change occurrences to 3.
    const occ = screen.getByLabelText(/occurrences/i);
    fireEvent.change(occ, { target: { value: "3" } });

    // Pre-pick patient.
    const patientInput = screen.getByTestId("appt-book-patient-input");
    await user.type(patientInput, "as");
    const option = await screen.findByTestId("appt-book-patient-option");
    await user.click(option);

    // Click late-day slot (avoids past-slot disable on most machines).
    const slot = await screen.findByRole("button", { name: /23:55 - 23:59/ });
    await user.click(slot);
    // Confirm dialog → click Confirm.
    await user.click(await screen.findByTestId("confirm-appointment-confirm"));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/appointments/recurring",
        expect.objectContaining({
          frequency: "DAILY",
          occurrences: 3,
          patientId: "pat-1",
          doctorId: "d-rec",
        }),
      ),
    );
  });

  // ─── Waitlist modal ───────────────────────────────────────────────

  it("Join Waitlist modal: opens, POSTs /waitlist on save, and closes", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [{ id: "d-w", user: { name: "Dr. W" }, specialization: "GP" }],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<AppointmentsPage />);

    const allJoinBtnsBefore = screen.queryAllByRole("button", { name: /join waitlist/i });
    // Open the modal via the top-bar trigger (first match).
    await user.click(allJoinBtnsBefore[0] ?? (await screen.findByRole("button", { name: /join waitlist/i })));
    const pidInput = await screen.findByPlaceholderText(/patient id/i);
    await user.type(pidInput, "pat-1");
    // After the modal is open, two buttons match: the top-bar trigger AND
    // the in-modal save CTA. The save CTA is the LAST match in DOM order.
    const allJoinBtns = screen.getAllByRole("button", { name: /join waitlist/i });
    await user.click(allJoinBtns[allJoinBtns.length - 1]);

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/waitlist",
        expect.objectContaining({ patientId: "pat-1", doctorId: "d-w" }),
      ),
    );
  });

  it("Join Waitlist modal: API rejection surfaces toast.error", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [{ id: "d-w", user: { name: "Dr. W" }, specialization: "GP" }],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockRejectedValue(new Error("dup waitlist"));
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    // Open the modal via the (only) top-bar trigger so the modal CTA
    // becomes the second "Join Waitlist" button in the tree.
    const topBar = await screen.findByRole("button", { name: /join waitlist/i });
    await user.click(topBar);
    await user.type(await screen.findByPlaceholderText(/patient id/i), "pat-1");
    const allJoinBtns = screen.getAllByRole("button", { name: /join waitlist/i });
    await user.click(allJoinBtns[allJoinBtns.length - 1]);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("dup waitlist"),
    );
  });

  // ─── Group Appointment modal ──────────────────────────────────────

  it("Group Appointment modal keeps patient suggestions in the modal flow", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [{ id: "d-g", user: { name: "Dr. G" }, specialization: "Ped" }],
        });
      }
      if (url.startsWith("/patients")) {
        return Promise.resolve({
          data: [
            {
              id: "p-1",
              mrNumber: "22MT000001",
              user: { name: "Patient one", phone: "8972429129" },
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);

    await user.click(await screen.findByRole("button", { name: /group appointment/i }));
    await user.type(screen.getByPlaceholderText(/Search patients by name/i), "PA");

    const result = await screen.findByText("Patient one");
    const list = result.closest("ul");
    expect(list).toHaveClass("relative");
    expect(list).not.toHaveClass("absolute");
    expect(list).toHaveClass("max-h-40");
  });

  it("Group Appointment modal opens and renders the multi-patient picker", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [{ id: "d-g", user: { name: "Dr. G" }, specialization: "Ped" }],
        });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(await screen.findByRole("button", { name: /group appointment/i }));
    // Modal heading + Create Group button visible.
    expect(await screen.findByRole("heading", { name: /group appointment/i }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create group/i })).toBeDisabled();
    // Close the modal.
    const closeBtn = screen.getByRole("button", { name: /close dialog/i });
    await user.click(closeBtn);
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /group appointment/i }),
      ).toBeNull(),
    );
  });

  // ─── Coordinated Visit (ADMIN-only) ───────────────────────────────

  it("Coordinated Visit modal opens for ADMIN and renders the single-patient picker", async () => {
    asRole("ADMIN");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [{ id: "d-c", user: { name: "Dr. C" }, specialization: "Cardio" }],
        });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(
      await screen.findByRole("button", { name: /coordinate multi-doctor visit/i }),
    );
    expect(
      await screen.findByRole("heading", { name: /coordinate multi-doctor visit/i }),
    ).toBeInTheDocument();
    // Create Visit CTA disabled until patient + name + date + a doctor.
    expect(screen.getByRole("button", { name: /create visit/i })).toBeDisabled();
  });

  // ─── Deep links ───────────────────────────────────────────────────

  it("?book=1 deep-link opens the booking panel automatically on mount", async () => {
    window.history.replaceState({}, "", "/dashboard/appointments?book=1");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [
            { id: "d-x", user: { name: "Dr. X" }, specialization: "GP" },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    render(<AppointmentsPage />);
    expect(await screen.findByTestId("appt-book-panel")).toBeInTheDocument();
  });

  it("?id=<aptId> deep-link highlights the matching row + scrolls it into view", async () => {
    window.history.replaceState({}, "", "/dashboard/appointments?id=a-deep");
    const scrollSpy = vi.fn();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [
            appt({ id: "a-deep", tokenNumber: 77, patient: {
              user: { name: "Deep Linked", phone: "9000000077" },
              mrNumber: "MR-77",
            } }),
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    // Stub scrollIntoView on every element.
    (HTMLElement.prototype as any).scrollIntoView = scrollSpy;
    render(<AppointmentsPage />);
    // Wait for the row to appear with the data-apt-row attribute.
    await waitFor(() => {
      const el = document.querySelector('[data-apt-row="a-deep"]');
      expect(el).not.toBeNull();
    });
    // scrollIntoView is called via setTimeout(..., 50) — wait for it.
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
  });

  // ─── Status filter chips ──────────────────────────────────────────

  it("Status filter chips narrow the rendered list", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [
            appt({ id: "a-b", status: "BOOKED", tokenNumber: 100 }),
            appt({ id: "a-c", status: "COMPLETED", tokenNumber: 101 }),
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    // Tokens render via appointmentRefLabel() as "T-<n>". Bare "100" would
    // also match the page-size <option value="100">, so the T- prefix
    // disambiguates the row cell from chrome.
    await screen.findByText("T-100");
    // Click the COMPLETED chip (filters out the BOOKED row).
    await user.click(screen.getByRole("button", { name: /^completed$/i }));
    await waitFor(() => {
      expect(screen.queryByText("T-100")).toBeNull();
      expect(screen.getByText("T-101")).toBeInTheDocument();
    });
    // Click All to restore.
    await user.click(screen.getByRole("button", { name: /^all$/i }));
    await waitFor(() => {
      expect(screen.getByText("T-100")).toBeInTheDocument();
    });
  });

  // ─── Filter date input ────────────────────────────────────────────

  it("Filter by date input re-fires GET /appointments?date=…", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: [] });
    });
    render(<AppointmentsPage />);
    const dateInput = await screen.findByLabelText(/filter by date/i);
    const callsBefore = apiMock.get.mock.calls.length;
    fireEvent.change(dateInput, { target: { value: plus2DaysIso() } });
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(callsBefore),
    );
    const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
    expect(
      calls.some((u) => u.includes(`/appointments?date=${plus2DaysIso()}`)),
    ).toBe(true);
  });

  // ─── Remarks button presence (smoke) ──────────────────────────────

  it("Remarks button renders for each row when the viewer is non-PATIENT", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({ data: [appt({ id: "a-r" })] });
      }
      return Promise.resolve({ data: [] });
    });
    render(<AppointmentsPage />);
    // The aria-label hook is constant — assert presence without clicking
    // (clicking mounts AppointmentRemarksModal, which has its own fetch +
    // render contract that's out of scope for this page-level coverage).
    expect(
      await screen.findByRole("button", { name: /open remarks for asha roy/i }),
    ).toBeInTheDocument();
    void within;
  });

  // ─── ⋮ status-action menu + reversal dialogs ──────────────────────
  // Covers buildStatusActions, the floating overflow menu, and the
  // Undo / No-show / Restore handlers added for status reversal.

  const renderWithRow = async (status: string, extra: Record<string, unknown> = {}) => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments")) {
        return Promise.resolve({ data: [appt({ id: "row-1", status, ...extra })] });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockResolvedValue({ data: { status } });
    apiMock.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(
      await screen.findByRole("button", { name: /more actions for asha roy/i }),
    );
    return user;
  };

  it("⋮ menu: Undo Check-in reverts a CHECKED_IN row to BOOKED", async () => {
    const user = await renderWithRow("CHECKED_IN");
    await user.click(
      await screen.findByRole("button", { name: /undo check-in for asha roy/i }),
    );
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/appointments/row-1/status", {
        status: "BOOKED",
      }),
    );
  });

  it("⋮ menu: Undo Consult reverts an IN_CONSULTATION row to CHECKED_IN", async () => {
    const user = await renderWithRow("IN_CONSULTATION");
    await user.click(
      await screen.findByRole("button", {
        name: /undo consultation start for asha roy/i,
      }),
    );
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/appointments/row-1/status", {
        status: "CHECKED_IN",
      }),
    );
  });

  it("⋮ menu: Mark as Booked reverts a NO_SHOW row to BOOKED", async () => {
    const user = await renderWithRow("NO_SHOW");
    await user.click(
      await screen.findByRole("button", { name: /undo no-show for asha roy/i }),
    );
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/appointments/row-1/status", {
        status: "BOOKED",
      }),
    );
  });

  it("⋮ menu: Mark No-show opens a reason dialog and PATCHes NO_SHOW with the reason", async () => {
    const user = await renderWithRow("BOOKED");
    await user.click(
      await screen.findByRole("button", { name: /mark no-show for asha roy/i }),
    );
    await user.type(await screen.findByTestId("noshow-reason"), "Did not arrive");
    await user.click(screen.getByRole("button", { name: /^mark no-show$/i }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/appointments/row-1/status", {
        status: "NO_SHOW",
        noShowReason: "Did not arrive",
      }),
    );
  });

  it("⋮ menu: Restore (CANCELLED) opens a reason dialog, PATCHes BOOKED, and mirrors the reason into Remarks", async () => {
    const user = await renderWithRow("CANCELLED");
    await user.click(
      await screen.findByRole("button", { name: /restore to booked for asha roy/i }),
    );
    await user.type(
      await screen.findByTestId("restore-reason"),
      "Cancelled by mistake",
    );
    await user.click(screen.getByRole("button", { name: /^restore to booked$/i }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/appointments/row-1/status", {
        status: "BOOKED",
      }),
    );
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/appointments/row-1/remarks",
        expect.objectContaining({ body: expect.stringContaining("Restored to booked") }),
      ),
    );
  });

  it("⋮ menu: a terminal COMPLETED row shows 'No actions available'", async () => {
    const user = await renderWithRow("COMPLETED");
    expect(await screen.findByText(/no actions available/i)).toBeInTheDocument();
    void user;
  });

  it("⋮ menu: a FUTURE booked row offers Mark No-show + Cancel (no Check In)", async () => {
    // Day-of actions (Check In, undo/restore) don't apply before the
    // appointment day, but an upcoming booking can still be cancelled or
    // flagged as a no-show ahead of time — both live in the ⋮ menu.
    const user = await renderWithRow("BOOKED", { date: plus2DaysIso() });
    expect(
      await screen.findByRole("button", { name: /mark no-show for asha roy/i }),
    ).toBeInTheDocument();
    // Exact label (no "(token …)" suffix) targets the menu's Cancel, not the
    // RECEPTION inline Cancel button.
    expect(
      screen.getByRole("button", { name: "Cancel appointment for Asha Roy" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^check in/i }),
    ).not.toBeInTheDocument();
    void user;
  });

  it("⋮ menu: a PAST cancelled row is terminal — 'No actions available' (no Restore)", async () => {
    // A past-dated row can't be meaningfully restored/undone, so the menu is
    // empty even though a same-day CANCELLED row would offer Mark-as-Booked.
    const user = await renderWithRow("CANCELLED", { date: "2020-01-01" });
    expect(await screen.findByText(/no actions available/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /restore to booked/i }),
    ).not.toBeInTheDocument();
    void user;
  });

  it("⋮ menu: Keep Cancelled dismisses the Restore dialog without a PATCH", async () => {
    const user = await renderWithRow("CANCELLED");
    await user.click(
      await screen.findByRole("button", { name: /restore to booked for asha roy/i }),
    );
    await screen.findByTestId("restore-reason");
    await user.click(screen.getByRole("button", { name: /keep cancelled/i }));
    await waitFor(() =>
      expect(screen.queryByTestId("restore-reason")).not.toBeInTheDocument(),
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  // ─── Token-mode reschedule (no slot grid; same-date guard) ─────────
  it("Token reschedule: same-date guard, then confirming a future date PATCHes /reschedule with no slotStart", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments/row-1/")) {
        // full-appointment re-fetch used by loadReschedSlots
        return Promise.resolve({ data: { doctorId: "doc-1" } });
      }
      if (url.includes("/appointments/next-token")) {
        return Promise.resolve({
          data: { mode: "TOKEN", tokenLabel: "T-5", limitReached: false },
        });
      }
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [
            appt({
              id: "row-1",
              status: "BOOKED",
              doctor: {
                user: { name: "Dr. Singh" },
                appointmentMode: "TOKEN",
                tokenPrefix: "T",
              },
            }),
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<AppointmentsPage />);

    await user.click(
      await screen.findByRole("button", {
        name: /reschedule appointment for asha roy/i,
      }),
    );
    // Opens on the appointment's own (today's) date → same-date guard shows,
    // no confirm button yet.
    expect(await screen.findByTestId("resched-token-samedate")).toBeInTheDocument();

    // Move to a future date → token confirm button appears (no slot grid).
    fireEvent.change(screen.getByLabelText(/new date/i), {
      target: { value: "2099-01-01" },
    });
    const confirmBtn = await screen.findByTestId("resched-token-confirm");
    fireEvent.change(screen.getByTestId("resched-reason"), {
      target: { value: "Patient asked to move" },
    });
    await user.click(confirmBtn);

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/appointments/row-1/reschedule",
        { date: "2099-01-01", reason: "Patient asked to move" },
      ),
    );
  });

  // ─── Per-doctor slot vs token API (mode-gated) ─────────────────────
  // The booking form must query the RIGHT endpoint for the selected
  // doctor's appointmentMode: /doctors/:id/slots for SLOT, /next-token for
  // TOKEN (prefix + daily-limit), and NOTHING for CALLING (arrival queue).
  // Helper: has the mocked api.get been called with a URL matching `frag`?
  const getCalledWith = (frag: string) =>
    apiMock.get.mock.calls.some(
      (call: any[]) => typeof call[0] === "string" && call[0].includes(frag),
    );

  async function openBookingAndPickDoctor(name: RegExp) {
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await user.click(
      await screen.findByRole("button", { name: /book appointment/i }),
    );
    await user.click(await screen.findByTestId("appt-book-doctor"));
    await user.click(await screen.findByRole("option", { name }));
    return user;
  }

  it("selecting a CALLING-mode doctor shows the arrival-queue block and never calls /slots or /next-token", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [
            {
              id: "d-call",
              user: { name: "Dr. Call" },
              specialization: "Psychiatry",
              appointmentMode: "CALLING",
              enabledChannels: ["CALLING"],
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    await openBookingAndPickDoctor(/Dr\. Call/i);

    // Arrival-queue note renders (no slot grid, no token preview).
    expect(
      await screen.findByTestId("appt-book-calling-mode"),
    ).toBeInTheDocument();
    // The mode gate skips BOTH the slot round-trip and the token preview.
    expect(getCalledWith("/slots")).toBe(false);
    expect(getCalledWith("/appointments/next-token")).toBe(false);
  });

  it("selecting a SLOT-mode doctor calls /doctors/:id/slots and renders the timed slot grid", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [
            {
              id: "d-slot",
              user: { name: "Dr. Slotter" },
              specialization: "GP",
              appointmentMode: "SLOT",
              enabledChannels: ["SLOT"],
            },
          ],
        });
      }
      if (url.startsWith("/doctors/d-slot/slots")) {
        return Promise.resolve({
          data: {
            slots: [{ startTime: "23:55", endTime: "23:59", isAvailable: true }],
          },
        });
      }
      return Promise.resolve({ data: [] });
    });

    await openBookingAndPickDoctor(/Dr\. Slotter/i);

    // Slot grid rendered from the /slots response.
    expect(
      await screen.findByRole("button", { name: /23:55 - 23:59/ }),
    ).toBeInTheDocument();
    expect(getCalledWith("/doctors/d-slot/slots")).toBe(true);
    // SLOT mode does not fetch a token.
    expect(getCalledWith("/appointments/next-token")).toBe(false);
  });

  it("selecting a TOKEN-mode doctor calls /next-token for that doctorId and shows the exact next token on the Book button", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [
            {
              id: "d-tok",
              user: { name: "Dr. Tok" },
              specialization: "GP",
              appointmentMode: "TOKEN",
              enabledChannels: ["TOKEN"],
              tokenPrefix: "R",
              tokenStartNumber: 1,
            },
          ],
        });
      }
      if (url.includes("/appointments/next-token")) {
        return Promise.resolve({
          data: { tokenLabel: "R-5", limitReached: false },
        });
      }
      return Promise.resolve({ data: [] });
    });

    await openBookingAndPickDoctor(/Dr\. Tok/i);

    // The exact live token from /next-token lands on the Book button.
    await waitFor(() =>
      expect(screen.getByTestId("appt-book-token-add")).toHaveTextContent(
        /assign token R-5/i,
      ),
    );
    // The token API was queried scoped to this doctor id.
    expect(
      apiMock.get.mock.calls.some(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("/appointments/next-token") &&
          call[0].includes("doctorId=d-tok"),
      ),
    ).toBe(true);
    // TOKEN mode never hits the slot grid.
    expect(getCalledWith("/slots")).toBe(false);
  });

  it("TOKEN doctor falls back to the configured prefix series when /next-token returns no label (stale server build)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [
            {
              id: "d-series",
              user: { name: "Dr. Series" },
              specialization: "GP",
              appointmentMode: "TOKEN",
              enabledChannels: ["TOKEN"],
              tokenPrefix: "R",
              tokenStartNumber: 1,
            },
          ],
        });
      }
      if (url.includes("/appointments/next-token")) {
        // Older server: preview responds but with no computed label.
        return Promise.resolve({
          data: { tokenLabel: null, limitReached: false },
        });
      }
      return Promise.resolve({ data: [] });
    });

    await openBookingAndPickDoctor(/Dr\. Series/i);

    // Prefix surfaces in the explanatory copy (the admin-set series).
    expect(
      await screen.findByTestId("appt-book-token-prefix"),
    ).toHaveTextContent("R");
    // ...and on the Book button as a "series" hint (no exact number known).
    await waitFor(() =>
      expect(screen.getByTestId("appt-book-token-add")).toHaveTextContent(
        /assign token.*R series/i,
      ),
    );
  });

  it("TOKEN doctor at the daily limit shows the limit message and hides the Book button", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [
            {
              id: "d-full",
              user: { name: "Dr. Full" },
              specialization: "GP",
              appointmentMode: "TOKEN",
              enabledChannels: ["TOKEN"],
              tokenPrefix: "R",
            },
          ],
        });
      }
      if (url.includes("/appointments/next-token")) {
        return Promise.resolve({
          data: { tokenLabel: null, limitReached: true },
        });
      }
      return Promise.resolve({ data: [] });
    });

    await openBookingAndPickDoctor(/Dr\. Full/i);

    expect(
      await screen.findByTestId("appt-book-token-limit"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("appt-book-token-add")).not.toBeInTheDocument();
  });
});
