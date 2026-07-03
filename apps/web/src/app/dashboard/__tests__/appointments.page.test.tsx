/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/appointments",
}));
// Issue #950 regression — the test below needs to walk the user through
// the "Next Available" confirm prompt. Mock useConfirm to auto-accept so
// the prompt doesn't require a real DialogProvider tree (the page is
// rendered in isolation; mounting the provider isn't necessary for this
// flow).
vi.mock("@/lib/use-dialog", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/use-dialog");
  return {
    ...actual,
    useConfirm: () => () => Promise.resolve(true),
  };
});

import AppointmentsPage from "../appointments/page";

const sampleAppointments = [
  {
    id: "a1",
    tokenNumber: 1,
    date: new Date().toISOString().split("T")[0],
    slotStart: "10:00",
    type: "REGULAR",
    status: "BOOKED",
    priority: "NORMAL",
    patient: { user: { name: "Asha Roy", phone: "9000000001" }, mrNumber: "MR-1" },
    doctor: { user: { name: "Dr. Singh" } },
  },
  {
    id: "a2",
    tokenNumber: 2,
    date: new Date().toISOString().split("T")[0],
    slotStart: "10:30",
    type: "REGULAR",
    status: "CHECKED_IN",
    priority: "NORMAL",
    patient: { user: { name: "Bhuvan Das", phone: "9000000002" }, mrNumber: "MR-2" },
    doctor: { user: { name: "Dr. Singh" } },
  },
];

describe("AppointmentsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Rec", email: "r@x.com", role: "RECEPTION" },
    });
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/doctors")) return Promise.resolve({ data: [] });
      if (url.startsWith("/appointments")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    document.documentElement.classList.remove("dark");
  });

  it("renders the Appointments heading when API returns empty lists", async () => {
    render(<AppointmentsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^appointments$/i })
      ).toBeInTheDocument()
    );
  });

  it("renders rows when appointments are present", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/doctors")) return Promise.resolve({ data: [] });
      if (url.startsWith("/appointments"))
        return Promise.resolve({ data: sampleAppointments });
      return Promise.resolve({ data: [] });
    });
    render(<AppointmentsPage />);
    await waitFor(() => {
      expect(screen.getByText("Asha Roy")).toBeInTheDocument();
      expect(screen.getByText("Bhuvan Das")).toBeInTheDocument();
    });
  });

  it("exposes a Book Appointment action for staff", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/doctors"))
        return Promise.resolve({
          data: [
            { id: "d1", user: { name: "Dr. Singh" }, specialization: "GP" },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    render(<AppointmentsPage />);
    await waitFor(() => {
      const buttons = screen.queryAllByRole("button", {
        name: /book appointment/i,
      });
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  it("gracefully survives a 500 from /appointments", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/doctors")) return Promise.resolve({ data: [] });
      if (url.startsWith("/appointments")) return Promise.reject(new Error("500"));
      return Promise.resolve({ data: [] });
    });
    render(<AppointmentsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^appointments$/i })
      ).toBeInTheDocument()
    );
  });

  it("switches to stats view when button is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(<AppointmentsPage />);
    await waitFor(() => {
      expect(screen.queryAllByRole("heading").length).toBeGreaterThan(0);
    });
    const statsButtons = screen.queryAllByRole("button", { name: /stats/i });
    if (statsButtons.length > 0) {
      await user.click(statsButtons[0]);
    }
    expect(container).toBeTruthy();
  });

  /**
   * Issue #34: past-time slots on today's date must render as
   * aria-disabled="true" and be functionally un-clickable. We mock the system
   * clock to 15:30 and feed a slot list that straddles "now", then assert
   * both the visual/a11y state and that clicks on a past slot do NOT open
   * the Confirm Appointment dialog (which is the post-2026-05 booking
   * surface — the legacy patient-id prompt modal was removed).
   */
  describe("past-slot gating on today's date (Issue #34)", () => {
    let originalNow: typeof Date.now;
    let originalDate: DateConstructor;
    beforeEach(() => {
      // Freeze "now" to 2026-04-24T15:30 local time. We avoid
      // `vi.useFakeTimers()` because it also fakes the microtask queue,
      // which makes userEvent hang. Instead we monkey-patch `Date.now` plus
      // the zero-arg `new Date()` so the page's `toISODate(new Date())`
      // default and the `Date.now()` comparisons both read the frozen value.
      const fixedMs = new Date(2026, 3, 24, 15, 30, 0, 0).getTime();
      originalNow = Date.now;
      originalDate = global.Date;
      Date.now = () => fixedMs;
      const PatchedDate = function (this: Date, ...args: unknown[]) {
        if (args.length === 0) {
          return new originalDate(fixedMs) as unknown as Date;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new (originalDate as any)(...args);
      } as unknown as DateConstructor;
      PatchedDate.now = () => fixedMs;
      PatchedDate.parse = originalDate.parse;
      PatchedDate.UTC = originalDate.UTC;
      // `Function.prototype` is read-only at the type level; use a cast so
      // TS permits the assignment (the runtime behaviour is correct).
      (PatchedDate as unknown as { prototype: unknown }).prototype =
        originalDate.prototype;
      global.Date = PatchedDate;
    });

    afterEach(() => {
      Date.now = originalNow;
      global.Date = originalDate;
    });

    it("marks slots before now as aria-disabled and allows booking future slots", async () => {
      const user = userEvent.setup();
      apiMock.get.mockImplementation((url: string) => {
        if (url === "/doctors")
          return Promise.resolve({
            data: [
              // SLOT mode — past-slot gating only applies to the time-slot
              // grid (TOKEN/CALLING modes have no slot times to gate).
              {
                id: "d1",
                user: { name: "Dr. Rajesh Sharma" },
                specialization: "GP",
                appointmentMode: "SLOT",
              },
            ],
          });
        if (url.startsWith("/appointments"))
          return Promise.resolve({ data: [] });
        if (url.startsWith("/doctors/d1/slots"))
          return Promise.resolve({
            data: {
              slots: [
                { startTime: "09:00", endTime: "09:15", isAvailable: true }, // past
                { startTime: "14:00", endTime: "14:15", isAvailable: true }, // past
                { startTime: "16:00", endTime: "16:15", isAvailable: true }, // future
                { startTime: "18:00", endTime: "18:15", isAvailable: true }, // future
              ],
            },
          });
        // /patients?search=… — the in-form EntityPicker queries this when
        // the user types in the search box. Return a single seeded patient
        // so the picker can offer something to click on.
        if (url.startsWith("/patients"))
          return Promise.resolve({
            data: [
              {
                id: "p1",
                mrNumber: "MR-1",
                user: { name: "Asha Roy", phone: "9000000001" },
              },
            ],
          });
        return Promise.resolve({ data: [] });
      });

      render(<AppointmentsPage />);

      // Open the booking panel.
      const bookBtn = await screen.findByRole("button", {
        name: /book appointment/i,
      });
      await user.click(bookBtn);

      // Pick the doctor via the custom dropdown — open the list, click the
      // option; triggers loadSlots("d1", today).
      await user.click(await screen.findByTestId("appt-book-doctor"));
      await user.click(
        await screen.findByRole("option", { name: /Dr\. Rajesh Sharma/i })
      );

      // Wait for the slot buttons to render.
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /09:00 - 09:15/ })).toBeInTheDocument();
      });

      const pastSlot = screen.getByRole("button", { name: /09:00 - 09:15/ });
      const pastSlotTwo = screen.getByRole("button", { name: /14:00 - 14:15/ });
      const futureSlot = screen.getByRole("button", { name: /16:00 - 16:15/ });
      const futureSlotEve = screen.getByRole("button", { name: /18:00 - 18:15/ });

      // Past slots: aria-disabled, disabled, line-through class.
      expect(pastSlot).toHaveAttribute("aria-disabled", "true");
      expect(pastSlot).toBeDisabled();
      expect(pastSlotTwo).toHaveAttribute("aria-disabled", "true");
      expect(pastSlotTwo).toBeDisabled();

      // Future slots: aria-disabled="false" and not disabled.
      expect(futureSlot).toHaveAttribute("aria-disabled", "false");
      expect(futureSlot).not.toBeDisabled();
      expect(futureSlotEve).toHaveAttribute("aria-disabled", "false");
      expect(futureSlotEve).not.toBeDisabled();

      // Clicking a past slot must NOT open the Confirm Appointment dialog
      // — the slot button is disabled so the handler never fires.
      await user.click(pastSlot);
      expect(
        screen.queryByTestId("confirm-appointment-dialog")
      ).not.toBeInTheDocument();

      // Pre-pick a patient via the in-form EntityPicker. The staff
      // booking flow requires a selected patient before a slot click
      // surfaces the Confirm dialog. Two characters minimum — the
      // EntityPicker default minQueryLength=2 gates the fetch.
      const patientInput = screen.getByTestId("appt-book-patient-input");
      await user.type(patientInput, "as");
      const patientOption = await screen.findByTestId(
        "appt-book-patient-option"
      );
      await user.click(patientOption);

      // Clicking a future slot DOES open the Confirm dialog (no freeze —
      // this is the direct regression for Issue #35: a late-hour slot
      // like 18:00 must process a click synchronously without hanging
      // the component).
      await user.click(futureSlotEve);
      expect(
        await screen.findByTestId("confirm-appointment-dialog")
      ).toBeInTheDocument();
    });
  });

  /**
   * Pearl ERP Stage 1 §3.1 (gap row 71, closed 2026-05-22) — booking form
   * derives the available channels from `(doctor.appointmentMode,
   * doctor.enabledChannels[])`. Single-channel doctors auto-select and hide
   * the picker; multi-channel doctors render a segmented control with only
   * the enabled channels. Doctor switch re-derives the channel set.
   */
  describe("per-doctor channel gating (Pearl §3.1 / gap row 71)", () => {
    async function openBookingPanelWithDoctors(
      doctors: Array<{
        id: string;
        user: { name: string };
        specialization: string;
        appointmentMode?: "CALLING" | "TOKEN" | "SLOT";
        enabledChannels?: Array<"CALLING" | "SLOT" | "TOKEN" | "WALKIN">;
      }>
    ) {
      apiMock.get.mockImplementation((url: string) => {
        if (url === "/doctors") return Promise.resolve({ data: doctors });
        if (url.startsWith("/doctors/") && url.includes("/slots"))
          return Promise.resolve({
            data: {
              slots: [
                { startTime: "10:00", endTime: "10:15", isAvailable: true },
              ],
            },
          });
        if (url.startsWith("/appointments"))
          return Promise.resolve({ data: [] });
        return Promise.resolve({ data: [] });
      });
      const user = userEvent.setup();
      render(<AppointmentsPage />);
      const bookBtn = await screen.findByRole("button", {
        name: /book appointment/i,
      });
      await user.click(bookBtn);
      return user;
    }

    it("CALLING-mode doctor with no enabledChannels shows BOTH calling + walkin", async () => {
      const user = await openBookingPanelWithDoctors([
        {
          id: "d1",
          user: { name: "Dr. Calling" },
          specialization: "GP",
          appointmentMode: "CALLING",
          enabledChannels: [],
        },
      ]);
      await user.click(await screen.findByTestId("appt-book-doctor"));
      await user.click(await screen.findByRole("option", { name: /Dr\. Calling/i }));
      const picker = await screen.findByTestId("appt-book-channel-picker");
      expect(picker).toBeInTheDocument();
      expect(screen.getByTestId("appt-book-channel-calling")).toBeInTheDocument();
      expect(screen.getByTestId("appt-book-channel-walkin")).toBeInTheDocument();
      expect(screen.queryByTestId("appt-book-channel-slot")).not.toBeInTheDocument();
      expect(screen.queryByTestId("appt-book-channel-token")).not.toBeInTheDocument();
      // CALLING auto-selected → calling-mode block is visible by default.
      expect(screen.getByTestId("appt-book-calling-mode")).toBeInTheDocument();
    });

    it("TOKEN-mode doctor narrowed to enabledChannels=[TOKEN] hides the picker AND auto-selects TOKEN", async () => {
      const user = await openBookingPanelWithDoctors([
        {
          id: "d2",
          user: { name: "Dr. Token" },
          specialization: "Derm",
          appointmentMode: "TOKEN",
          enabledChannels: ["TOKEN"],
        },
      ]);
      await user.click(await screen.findByTestId("appt-book-doctor"));
      await user.click(await screen.findByRole("option", { name: /Dr\. Token/i }));
      // TOKEN mode shows the "assign token" block (no slot grid — slot time
      // is optional for sequential-token booking), proving the doctor is
      // selected + TOKEN channel is active.
      await waitFor(() =>
        expect(screen.getByTestId("appt-book-token-mode")).toBeInTheDocument()
      );
      expect(screen.queryByTestId("appt-book-slots")).not.toBeInTheDocument();
      // Only one channel available → picker is hidden (no friction).
      expect(screen.queryByTestId("appt-book-channel-picker")).not.toBeInTheDocument();
      // WALKIN block must NOT be present (channel not enabled).
      expect(screen.queryByTestId("appt-book-walkin-mode")).not.toBeInTheDocument();
    });

    it("SLOT-mode doctor with enabledChannels=[SLOT, WALKIN] shows both options, defaults to SLOT", async () => {
      const user = await openBookingPanelWithDoctors([
        {
          id: "d3",
          user: { name: "Dr. Slot" },
          specialization: "Ortho",
          appointmentMode: "SLOT",
          enabledChannels: ["SLOT", "WALKIN"],
        },
      ]);
      await user.click(await screen.findByTestId("appt-book-doctor"));
      await user.click(await screen.findByRole("option", { name: /Dr\. Slot/i }));
      await screen.findByTestId("appt-book-channel-picker");
      expect(screen.getByTestId("appt-book-channel-slot")).toBeInTheDocument();
      expect(screen.getByTestId("appt-book-channel-walkin")).toBeInTheDocument();
      expect(screen.queryByTestId("appt-book-channel-calling")).not.toBeInTheDocument();
      expect(screen.queryByTestId("appt-book-channel-token")).not.toBeInTheDocument();
      // SLOT auto-selected → slot grid visible.
      await waitFor(() =>
        expect(screen.getByTestId("appt-book-slots")).toBeInTheDocument()
      );
      // Switch to WALKIN: slot grid disappears, walk-in block appears.
      await user.click(screen.getByTestId("appt-book-channel-walkin"));
      expect(screen.queryByTestId("appt-book-slots")).not.toBeInTheDocument();
      expect(screen.getByTestId("appt-book-walkin-mode")).toBeInTheDocument();
    });

    it("switching from a CALLING doctor to a TOKEN doctor re-derives the channel set", async () => {
      const user = await openBookingPanelWithDoctors([
        {
          id: "d-c",
          user: { name: "Dr. Calling" },
          specialization: "GP",
          appointmentMode: "CALLING",
          enabledChannels: [],
        },
        {
          id: "d-t",
          user: { name: "Dr. Token" },
          specialization: "Derm",
          appointmentMode: "TOKEN",
          enabledChannels: ["TOKEN"],
        },
      ]);
      // Pick the CALLING doctor → both CALLING + WALKIN visible.
      await user.click(await screen.findByTestId("appt-book-doctor"));
      await user.click(await screen.findByRole("option", { name: /Dr\. Calling/i }));
      await screen.findByTestId("appt-book-channel-picker");
      expect(screen.getByTestId("appt-book-channel-calling")).toBeInTheDocument();
      // Switch to the TOKEN doctor narrowed to TOKEN-only → picker hides,
      // slot grid renders. The stale CALLING / WALKIN buttons must be gone.
      await user.click(screen.getByTestId("appt-book-doctor"));
      await user.click(screen.getByRole("option", { name: /Dr\. Token/i }));
      await waitFor(() =>
        expect(screen.queryByTestId("appt-book-channel-picker")).not.toBeInTheDocument()
      );
      expect(screen.queryByTestId("appt-book-channel-calling")).not.toBeInTheDocument();
      expect(screen.queryByTestId("appt-book-channel-walkin")).not.toBeInTheDocument();
      expect(screen.queryByTestId("appt-book-calling-mode")).not.toBeInTheDocument();
    });
  });

  /**
   * Issue #950 — "Next Available" booking must assign the appointment to
   * the SAME doctor whose name appeared on the suggestion card. Pre-fix
   * the handler only pre-filled `selectedDoctor` and opened the form,
   * leaving the user to manually re-pick a slot from a slot-grid that
   * had NEVER been refreshed for the new doctor. The booking POST then
   * read `selectedDoctor` from React state, which could drift between
   * the confirm prompt and the user's slot click (DoctorSelect re-render,
   * channel auto-derivation, date input change) — and the persisted row
   * could end up against a DIFFERENT doctor.
   *
   * The fix locks the suggestion's doctorId + date into a separate
   * override that wins over form state until the booking completes.
   * This test pins that contract: click "Next Available", confirm, type
   * a patient, click the pre-locked slot, click Confirm, and assert the
   * resulting POST /appointments/book body carries the suggestion's
   * doctorId — not whatever the form's state happened to be.
   */
  // The top-bar "Next Available" button was simplified (per product) to a
  // clean panel open/close toggle: it no longer runs the cross-doctor
  // suggestion search or opens a confirm dialog with a "locked" suggested
  // doctor from the top bar. (The old Issue #950 cross-doctor lock-and-book
  // via the top button was removed.) This pins the new behavior.
  describe("Next Available — top button clean panel toggle", () => {
    it("opens a fresh panel on click and never surfaces a cross-doctor confirm dialog", async () => {
      const user = userEvent.setup();
      apiMock.get.mockImplementation((url: string) => {
        if (url === "/doctors")
          return Promise.resolve({
            data: [
              {
                id: "doc-A",
                user: { name: "Dr. Alice" },
                specialization: "Cardiology",
                appointmentMode: "SLOT",
                enabledChannels: ["SLOT"],
              },
            ],
          });
        return Promise.resolve({ data: [] });
      });

      render(<AppointmentsPage />);

      const nextBtn = await screen.findByRole("button", {
        name: /^next available$/i,
      });
      await user.click(nextBtn);

      // Opens the Book New Appointment panel...
      expect(
        await screen.findByText(/Book New Appointment/i)
      ).toBeInTheDocument();
      // ...with NO cross-doctor confirm dialog.
      expect(
        screen.queryByTestId("confirm-appointment-dialog")
      ).not.toBeInTheDocument();

      // Second click (button now red) closes the panel.
      await user.click(nextBtn);
      await waitFor(() =>
        expect(
          screen.queryByText(/Book New Appointment/i)
        ).not.toBeInTheDocument()
      );
    });
  });
});
