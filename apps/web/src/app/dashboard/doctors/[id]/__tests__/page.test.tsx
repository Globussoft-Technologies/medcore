/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * DoctorDetailPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/doctors/[id]/page.tsx`, the read-only doctor
 *     profile page introduced for Issue #213-B + extended by Pearl ERP Stage 1
 *     §2.1.2 / §3.2 / §2.1.4 (per-doctor appointment-mode editor + NMC reg #
 *     + channels/buffer knobs).
 *
 *   - Behaviours covered:
 *       1. Loading skeleton — `doctor-detail-loading` with `aria-busy="true"`
 *          renders 2 skeleton cards while the GET is in flight.
 *       2. Not-found branch — GET resolves but the row is missing from the
 *          list (the page filters client-side, no GET /doctors/:id endpoint).
 *       3. Not-found branch via GET rejection (catch → toast.error +
 *          setNotFound(true)).
 *       4. URL `id` param threads into the loader — the only GET fires against
 *          `/doctors` and the matching row is selected by id from `res.data`.
 *       5. Happy path — name, specialization, qualification, NMC reg # (with
 *          nmcRegNumber preferred over the legacy `registrationNumber`),
 *          email, phone, Active/Inactive pill, "Back to doctors" link.
 *       6. nmcRegNumber missing → falls back to legacy `registrationNumber`.
 *       7. Neither nmcRegNumber nor registrationNumber → reg # paragraph omitted.
 *       8. Qualification missing → `doctor-detail-qual` not rendered (truthy
 *          conditional branch).
 *       9. user.isActive false → red "Inactive" pill (color-class assertion).
 *      10. Schedule sort — rows sort by dayOfWeek ASC then startTime ASC and
 *          render correct DAY_NAMES; an out-of-range dayOfWeek falls back to
 *          "Day N" copy.
 *      11. Empty schedule → `doctor-detail-schedule-empty` rendered, no table.
 *      12. RBAC — `ADMIN` sees both the page-level Edit button and the
 *          AppointmentModeCard's `appointment-mode-edit` button. Non-ADMIN
 *          (e.g. DOCTOR) sees neither.
 *      13. Page-level Edit button → toast.success copy ("Edit flow coming soon").
 *      14. AppointmentModeCard summary — MODE_LABEL["TOKEN"] default, token
 *          prefix/start, daily limit, near-turn-alert, last-hour policy label,
 *          channels summary (selected list vs "All (default)"), buffer minutes,
 *          NMC reg # summary; em-dash fallbacks for null fields.
 *      15. AppointmentModeCard edit form — clicking Edit opens form;
 *          all inputs (mode select, tokenPrefix, tokenStartNumber, dailyLimit,
 *          nearTurn, policy select, channel buttons, bufferMinutes, nmcReg)
 *          accept changes; mode-hint copy updates per CALLING/TOKEN/SLOT.
 *      16. toggleChannel — clicking a channel button toggles `data-active`
 *          and inclusion in the submitted body.
 *      17. Save success — PATCH body shape (blank text → null, numeric coerce,
 *          channels verbatim, parsedBuffer clamp >= 0), URL is
 *          `/doctors/:id/appointment-mode`, toast.success copy, form closes,
 *          parent's `setDoctor` is fed the merged record.
 *      18. Save error path — Error → toast.error message; non-Error rejection →
 *          "Failed to save appointment mode" fallback. Form stays open.
 *      19. Save buffer fallback — non-numeric/NaN bufferMinutes → 0 in body.
 *      20. Cancel button — resets form fields to current doctor values and
 *          closes the editor without firing PATCH.
 *
 *   - Mocks: @/lib/api, @/lib/store (destructured useAuthStore — NOT a
 *     selector), @/lib/toast, next/navigation (useParams threads `id: "d1"`),
 *     @/components/Skeleton passthrough.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";

const { apiMock, toastMock, routerMock, authMock } = vi.hoisted(() => ({
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
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  },
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useParams: () => ({ id: "d1" }),
  usePathname: () => "/dashboard/doctors/d1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));

import DoctorDetailPage from "../page";

type Doctor = {
  id: string;
  specialization: string;
  qualification: string;
  registrationNumber?: string | null;
  appointmentMode?: "CALLING" | "TOKEN" | "SLOT";
  tokenPrefix?: string | null;
  tokenStartNumber?: number | null;
  dailyAppointmentLimit?: number | null;
  nearTurnAlertThreshold?: number | null;
  lastHourPolicy?: "ACCEPT_ALL" | "BLOCK_NEW" | "WALK_IN_ONLY" | null;
  enabledChannels?: Array<"CALLING" | "SLOT" | "TOKEN" | "WALKIN">;
  bufferMinutes?: number;
  nmcRegNumber?: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    phone: string;
    isActive: boolean;
  };
  schedules: Array<{
    id?: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    slotDurationMinutes: number;
  }>;
};

function doctorFx(overrides: Partial<Doctor> = {}): Doctor {
  return {
    id: "d1",
    specialization: "Cardiology",
    qualification: "MBBS, MD",
    registrationNumber: "LEGACY-001",
    appointmentMode: "TOKEN",
    tokenPrefix: "T",
    tokenStartNumber: 1,
    dailyAppointmentLimit: 40,
    nearTurnAlertThreshold: 3,
    lastHourPolicy: "BLOCK_NEW",
    enabledChannels: ["CALLING", "SLOT"],
    bufferMinutes: 5,
    nmcRegNumber: "NMC/2024/12345",
    user: {
      id: "u1",
      name: "Rajesh Verma",
      email: "rajesh@example.test",
      phone: "9999988888",
      isActive: true,
    },
    schedules: [
      {
        id: "s1",
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "12:00",
        slotDurationMinutes: 15,
      },
      {
        id: "s2",
        dayOfWeek: 3,
        startTime: "14:00",
        endTime: "17:00",
        slotDurationMinutes: 20,
      },
    ],
    ...overrides,
  };
}

function setUser(role: string | null) {
  authMock.mockReturnValue({ user: role ? { id: "u1", role } : null });
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.patch.mockReset();
  apiMock.delete.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.info.mockReset();
  toastMock.warning.mockReset();
  Object.values(routerMock).forEach((fn: any) => fn.mockReset());
  authMock.mockReset();
  setUser("ADMIN");
});

afterEach(() => {
  cleanup();
});

describe("DoctorDetailPage — load lifecycle", () => {
  it("renders the loading skeleton with aria-busy while the GET is in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<DoctorDetailPage />);
    const loader = await screen.findByTestId("doctor-detail-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card").length).toBe(2);
  });

  it("threads the URL id by selecting the matching row from the /doctors list", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        doctorFx({ id: "d-other", user: { ...doctorFx().user, name: "Wrong" } }),
        doctorFx(),
      ],
    });
    render(<DoctorDetailPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/doctors"));
    await screen.findByText("Rajesh Verma");
    expect(screen.queryByText("Wrong")).not.toBeInTheDocument();
  });

  it("renders the not-found branch when the id is missing from the list", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<DoctorDetailPage />);
    await screen.findByTestId("doctor-detail-notfound");
    expect(screen.getByText(/Doctor not found/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to doctors/i })).toHaveAttribute(
      "href",
      "/dashboard/doctors",
    );
  });

  it("renders the not-found branch and toasts the error when the GET rejects (Error)", async () => {
    apiMock.get.mockRejectedValue(new Error("network down"));
    render(<DoctorDetailPage />);
    await screen.findByTestId("doctor-detail-notfound");
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("network down"),
    );
  });

  it("falls back to 'Failed to load doctor' on non-Error rejection", async () => {
    apiMock.get.mockRejectedValue("nope");
    render(<DoctorDetailPage />);
    await screen.findByTestId("doctor-detail-notfound");
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to load doctor"),
    );
  });

  it("handles undefined res.data gracefully (defaults to [] then not-found)", async () => {
    apiMock.get.mockResolvedValue({});
    render(<DoctorDetailPage />);
    await screen.findByTestId("doctor-detail-notfound");
  });
});

describe("DoctorDetailPage — header + profile", () => {
  it("renders name, specialization, qualification, NMC reg #, email, phone, Active pill", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.getByTestId("doctor-detail-spec")).toHaveTextContent("Cardiology");
    expect(screen.getByTestId("doctor-detail-qual")).toHaveTextContent("MBBS, MD");
    expect(screen.getByTestId("doctor-detail-regno")).toHaveTextContent(
      "NMC Reg #NMC/2024/12345",
    );
    expect(screen.getByText("rajesh@example.test")).toBeInTheDocument();
    expect(screen.getByText("9999988888")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("prefers nmcRegNumber over the legacy registrationNumber when both exist", async () => {
    apiMock.get.mockResolvedValue({
      data: [doctorFx({ nmcRegNumber: "NMC-NEW", registrationNumber: "LEGACY" })],
    });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.getByTestId("doctor-detail-regno")).toHaveTextContent(
      "NMC Reg #NMC-NEW",
    );
  });

  it("falls back to legacy registrationNumber when nmcRegNumber is null", async () => {
    apiMock.get.mockResolvedValue({
      data: [doctorFx({ nmcRegNumber: null, registrationNumber: "LEGACY-001" })],
    });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.getByTestId("doctor-detail-regno")).toHaveTextContent(
      "NMC Reg #LEGACY-001",
    );
  });

  it("omits the reg # paragraph when both fields are null", async () => {
    apiMock.get.mockResolvedValue({
      data: [doctorFx({ nmcRegNumber: null, registrationNumber: null })],
    });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.queryByTestId("doctor-detail-regno")).not.toBeInTheDocument();
  });

  it("omits qualification suffix when qualification is empty", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx({ qualification: "" })] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.queryByTestId("doctor-detail-qual")).not.toBeInTheDocument();
  });

  it("falls back to em-dash placeholders when name/spec are blank", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        doctorFx({
          specialization: "",
          qualification: "",
          user: {
            id: "u1",
            name: "",
            email: "",
            phone: "",
            isActive: true,
          },
        }),
      ],
    });
    render(<DoctorDetailPage />);
    await screen.findByTestId("doctor-detail-page");
    expect(screen.getByTestId("doctor-detail-name")).toHaveTextContent("—");
    expect(screen.getByTestId("doctor-detail-spec")).toHaveTextContent("—");
  });

  it("renders the red Inactive pill when user.isActive is false", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        doctorFx({
          user: {
            id: "u1",
            name: "Inactive Doc",
            email: "i@example.test",
            phone: "1112223333",
            isActive: false,
          },
        }),
      ],
    });
    render(<DoctorDetailPage />);
    const pill = await screen.findByText("Inactive");
    expect(pill.className).toMatch(/bg-red-100/);
  });
});

describe("DoctorDetailPage — weekly schedule", () => {
  it("renders the empty-schedule placeholder when schedules is empty", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx({ schedules: [] })] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.getByTestId("doctor-detail-schedule-empty")).toBeInTheDocument();
    expect(
      screen.queryByTestId("doctor-detail-schedule-table"),
    ).not.toBeInTheDocument();
  });

  it("sorts schedule rows by dayOfWeek then startTime and renders DAY_NAMES", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        doctorFx({
          schedules: [
            { dayOfWeek: 3, startTime: "14:00", endTime: "17:00", slotDurationMinutes: 20 },
            { dayOfWeek: 1, startTime: "11:00", endTime: "13:00", slotDurationMinutes: 30 },
            { dayOfWeek: 1, startTime: "09:00", endTime: "10:00", slotDurationMinutes: 10 },
          ],
        }),
      ],
    });
    render(<DoctorDetailPage />);
    await screen.findByTestId("doctor-detail-schedule-table");
    const rows = screen.getAllByRole("row").slice(1); // drop header
    expect(rows.length).toBe(3);
    // First row: Monday 09:00
    expect(rows[0].textContent).toMatch(/Monday/);
    expect(rows[0].textContent).toMatch(/09:00/);
    // Second row: Monday 11:00
    expect(rows[1].textContent).toMatch(/Monday/);
    expect(rows[1].textContent).toMatch(/11:00/);
    // Third row: Wednesday 14:00
    expect(rows[2].textContent).toMatch(/Wednesday/);
    expect(rows[2].textContent).toMatch(/14:00/);
  });

  it("falls back to 'Day N' label for an out-of-range dayOfWeek", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        doctorFx({
          schedules: [
            { dayOfWeek: 9, startTime: "09:00", endTime: "10:00", slotDurationMinutes: 15 },
          ],
        }),
      ],
    });
    render(<DoctorDetailPage />);
    await screen.findByTestId("doctor-detail-schedule-table");
    expect(screen.getByText("Day 9")).toBeInTheDocument();
  });
});

describe("DoctorDetailPage — RBAC + page-level Edit", () => {
  it("ADMIN sees the page-level Edit button and the appointment-mode-edit button", async () => {
    setUser("ADMIN");
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.getByTestId("doctor-detail-edit")).toBeInTheDocument();
    expect(screen.getByTestId("appointment-mode-edit")).toBeInTheDocument();
  });

  it("DOCTOR does not see the Edit buttons", async () => {
    setUser("DOCTOR");
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.queryByTestId("doctor-detail-edit")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("appointment-mode-edit"),
    ).not.toBeInTheDocument();
  });

  it("no user (logged-out) hides the Edit buttons", async () => {
    setUser(null);
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.queryByTestId("doctor-detail-edit")).not.toBeInTheDocument();
  });

  it("clicking the page-level Edit button toasts the 'coming soon' message", async () => {
    setUser("ADMIN");
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    fireEvent.click(screen.getByTestId("doctor-detail-edit"));
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/Edit flow coming soon/),
    );
  });
});

describe("DoctorDetailPage — AppointmentModeCard summary", () => {
  it("renders MODE_LABEL[TOKEN] + token/limit/policy/channel/buffer/NMC", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.getByTestId("appointment-mode-value")).toHaveTextContent(
      "Token (sequential numbers)",
    );
    expect(screen.getByTestId("appointment-mode-channels-summary")).toHaveTextContent(
      "Calling, Slot",
    );
    expect(screen.getByTestId("appointment-mode-buffer-summary")).toHaveTextContent(
      "5 min",
    );
    expect(screen.getByTestId("appointment-mode-nmc-reg-summary")).toHaveTextContent(
      "NMC/2024/12345",
    );
    expect(screen.getByText("Block new bookings")).toBeInTheDocument();
    expect(screen.getByText("3 patients away")).toBeInTheDocument();
  });

  it("defaults appointmentMode to TOKEN when the field is missing", async () => {
    apiMock.get.mockResolvedValue({
      data: [doctorFx({ appointmentMode: undefined })],
    });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.getByTestId("appointment-mode-value")).toHaveTextContent(
      "Token (sequential numbers)",
    );
  });

  it("shows 'All (default)' when enabledChannels is empty", async () => {
    apiMock.get.mockResolvedValue({
      data: [doctorFx({ enabledChannels: [] })],
    });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.getByTestId("appointment-mode-channels-summary")).toHaveTextContent(
      "All (default)",
    );
  });

  it("shows '0 min' when bufferMinutes is null", async () => {
    apiMock.get.mockResolvedValue({
      data: [doctorFx({ bufferMinutes: undefined })],
    });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    expect(screen.getByTestId("appointment-mode-buffer-summary")).toHaveTextContent(
      "0 min",
    );
  });

  it("renders em-dash placeholders for every nullable summary field", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        doctorFx({
          tokenPrefix: null,
          tokenStartNumber: null,
          dailyAppointmentLimit: null,
          nearTurnAlertThreshold: null,
          lastHourPolicy: null,
          nmcRegNumber: null,
          registrationNumber: null,
        }),
      ],
    });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    // 5+ em-dashes across the summary grid.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
  });
});

describe("DoctorDetailPage — AppointmentModeCard edit form", () => {
  it("clicking Edit opens the form with the current values prefilled", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    fireEvent.click(screen.getByTestId("appointment-mode-edit"));

    expect(screen.getByTestId("appointment-mode-select")).toHaveValue("TOKEN");
    expect(screen.getByTestId("appointment-mode-token-prefix")).toHaveValue("T");
    expect(screen.getByTestId("appointment-mode-token-start")).toHaveValue(1);
    expect(screen.getByTestId("appointment-mode-daily-limit")).toHaveValue(40);
    expect(screen.getByTestId("appointment-mode-near-turn")).toHaveValue(3);
    expect(screen.getByTestId("appointment-mode-policy")).toHaveValue("BLOCK_NEW");
    expect(screen.getByTestId("appointment-mode-buffer")).toHaveValue(5);
    expect(screen.getByTestId("appointment-mode-nmc-reg")).toHaveValue(
      "NMC/2024/12345",
    );
    // CALLING + SLOT channels start active; TOKEN + WALKIN inactive.
    expect(
      screen.getByTestId("appointment-mode-channel-calling"),
    ).toHaveAttribute("data-active", "true");
    expect(
      screen.getByTestId("appointment-mode-channel-slot"),
    ).toHaveAttribute("data-active", "true");
    expect(
      screen.getByTestId("appointment-mode-channel-token"),
    ).toHaveAttribute("data-active", "false");
    expect(
      screen.getByTestId("appointment-mode-channel-walkin"),
    ).toHaveAttribute("data-active", "false");
  });

  it("changing the mode select updates the helper-text copy for each mode", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    fireEvent.click(screen.getByTestId("appointment-mode-edit"));

    const sel = screen.getByTestId("appointment-mode-select");

    fireEvent.change(sel, { target: { value: "CALLING" } });
    expect(screen.getByText(/arrival order/i)).toBeInTheDocument();

    fireEvent.change(sel, { target: { value: "SLOT" } });
    expect(screen.getByText(/fixed HH:MM slot/i)).toBeInTheDocument();

    fireEvent.change(sel, { target: { value: "TOKEN" } });
    expect(screen.getByText(/sequential token number/i)).toBeInTheDocument();
  });

  it("toggleChannel — clicking a channel button flips data-active state", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    fireEvent.click(screen.getByTestId("appointment-mode-edit"));

    const tokenBtn = screen.getByTestId("appointment-mode-channel-token");
    expect(tokenBtn).toHaveAttribute("data-active", "false");
    fireEvent.click(tokenBtn);
    expect(tokenBtn).toHaveAttribute("data-active", "true");
    fireEvent.click(tokenBtn);
    expect(tokenBtn).toHaveAttribute("data-active", "false");
  });

  it("Save — submits canonical PATCH body, calls onUpdated with merged record, closes form", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    apiMock.patch.mockResolvedValue({
      data: {
        appointmentMode: "SLOT",
        tokenPrefix: "Z",
        tokenStartNumber: 100,
        dailyAppointmentLimit: 60,
        nearTurnAlertThreshold: 5,
        lastHourPolicy: "ACCEPT_ALL",
        nmcRegNumber: "NMC/9999",
        enabledChannels: ["CALLING", "SLOT", "TOKEN"],
        bufferMinutes: 10,
      },
    });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    fireEvent.click(screen.getByTestId("appointment-mode-edit"));

    fireEvent.change(screen.getByTestId("appointment-mode-select"), {
      target: { value: "SLOT" },
    });
    fireEvent.change(screen.getByTestId("appointment-mode-token-prefix"), {
      target: { value: "Z" },
    });
    fireEvent.change(screen.getByTestId("appointment-mode-token-start"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByTestId("appointment-mode-daily-limit"), {
      target: { value: "60" },
    });
    fireEvent.change(screen.getByTestId("appointment-mode-near-turn"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByTestId("appointment-mode-policy"), {
      target: { value: "ACCEPT_ALL" },
    });
    fireEvent.change(screen.getByTestId("appointment-mode-nmc-reg"), {
      target: { value: "NMC/9999" },
    });
    fireEvent.change(screen.getByTestId("appointment-mode-buffer"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("appointment-mode-channel-token"));

    fireEvent.click(screen.getByTestId("appointment-mode-save"));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/doctors/d1/appointment-mode",
        expect.objectContaining({
          appointmentMode: "SLOT",
          tokenPrefix: "Z",
          tokenStartNumber: 100,
          dailyAppointmentLimit: 60,
          nearTurnAlertThreshold: 5,
          lastHourPolicy: "ACCEPT_ALL",
          nmcRegNumber: "NMC/9999",
          enabledChannels: ["CALLING", "SLOT", "TOKEN"],
          bufferMinutes: 10,
        }),
      ),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Appointment mode updated"),
    );
    // Form closes — summary is back.
    expect(screen.getByTestId("appointment-mode-summary")).toBeInTheDocument();
    // Mode label reflects merged record.
    expect(screen.getByTestId("appointment-mode-value")).toHaveTextContent(
      "Slot (fixed appointment times)",
    );
  });

  it("Save — blank text fields → null in body; numeric coerce; channels verbatim", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        doctorFx({
          tokenPrefix: null,
          tokenStartNumber: null,
          dailyAppointmentLimit: null,
          nearTurnAlertThreshold: null,
          lastHourPolicy: null,
          nmcRegNumber: null,
          registrationNumber: null,
          enabledChannels: [],
          bufferMinutes: 0,
        }),
      ],
    });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    fireEvent.click(screen.getByTestId("appointment-mode-edit"));
    // Leave everything blank, just click Save.
    fireEvent.click(screen.getByTestId("appointment-mode-save"));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    const body = apiMock.patch.mock.calls[0][1];
    expect(body.tokenPrefix).toBeNull();
    expect(body.tokenStartNumber).toBeNull();
    expect(body.dailyAppointmentLimit).toBeNull();
    expect(body.nearTurnAlertThreshold).toBeNull();
    expect(body.lastHourPolicy).toBeNull();
    expect(body.nmcRegNumber).toBeNull();
    expect(body.enabledChannels).toEqual([]);
    // bufferMinutes default "0" → 0
    expect(body.bufferMinutes).toBe(0);
  });

  it("Save — non-numeric bufferMinutes falls back to 0", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    fireEvent.click(screen.getByTestId("appointment-mode-edit"));
    fireEvent.change(screen.getByTestId("appointment-mode-buffer"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("appointment-mode-save"));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch.mock.calls[0][1].bufferMinutes).toBe(0);
  });

  it("Save — Error rejection surfaces toast.error with the message; form stays open", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    apiMock.patch.mockRejectedValue(new Error("server kaboom"));
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    fireEvent.click(screen.getByTestId("appointment-mode-edit"));
    fireEvent.click(screen.getByTestId("appointment-mode-save"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("server kaboom"),
    );
    // Form stays open — Save button still rendered.
    expect(screen.getByTestId("appointment-mode-save")).toBeInTheDocument();
  });

  it("Save — non-Error rejection falls back to 'Failed to save appointment mode'", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    apiMock.patch.mockRejectedValue("string-error");
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    fireEvent.click(screen.getByTestId("appointment-mode-edit"));
    fireEvent.click(screen.getByTestId("appointment-mode-save"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Failed to save appointment mode",
      ),
    );
  });

  it("Cancel — resets form to current doctor values and closes the editor without firing PATCH", async () => {
    apiMock.get.mockResolvedValue({ data: [doctorFx()] });
    render(<DoctorDetailPage />);
    await screen.findByText("Rajesh Verma");
    fireEvent.click(screen.getByTestId("appointment-mode-edit"));
    // Dirty a few fields
    fireEvent.change(screen.getByTestId("appointment-mode-token-prefix"), {
      target: { value: "DIRTY" },
    });
    fireEvent.click(screen.getByTestId("appointment-mode-channel-token"));
    // Cancel
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    // Editor closes — summary visible again, PATCH never fired.
    expect(screen.getByTestId("appointment-mode-summary")).toBeInTheDocument();
    expect(apiMock.patch).not.toHaveBeenCalled();
    // Re-open editor — fields are reset to current doctor values.
    fireEvent.click(screen.getByTestId("appointment-mode-edit"));
    expect(screen.getByTestId("appointment-mode-token-prefix")).toHaveValue("T");
    expect(
      screen.getByTestId("appointment-mode-channel-token"),
    ).toHaveAttribute("data-active", "false");
  });
});
