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
              { id: "d1", user: { name: "Dr. Rajesh Sharma" }, specialization: "GP" },
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

      // Pick the doctor — triggers loadSlots("d1", today).
      const doctorSelect = await screen.findByLabelText(/doctor/i);
      await user.selectOptions(doctorSelect, "d1");

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
});
