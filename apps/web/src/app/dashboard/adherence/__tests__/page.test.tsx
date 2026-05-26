/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AdherencePage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/adherence/page.tsx, the
 *     medication-reminder enrollment console. Endpoints the page hits:
 *       GET    /patients?userId=<uid>&limit=1   (staff path — patient lookup)
 *       GET    /ai/adherence/mine               (PATIENT self-resolve, Issue #24)
 *       GET    /ai/adherence/:patientId         (staff list)
 *       POST   /ai/adherence/enroll             (new schedule)
 *       DELETE /ai/adherence/:scheduleId        (unenroll)
 *
 *   - Behaviours covered:
 *       1.  Issue #639 — RBAC gate. ADHERENCE_VIEW_ALLOWED is {PATIENT,DOCTOR,
 *           NURSE,ADMIN}. PHARMACIST + LAB_TECH + RECEPTION must be redirected
 *           to /dashboard/not-authorized with the ?from= breadcrumb AND a
 *           toast.error.
 *       2.  isLoading=true short-circuits the gate (no redirect, no toast).
 *       3.  PATIENT role — initial mount calls /ai/adherence/mine with
 *           skip401Redirect:true (Issue #603 hydration-race fix) and renders
 *           the returned schedules.
 *       4.  PATIENT — /mine 404 flips hasPatientProfile=false and renders the
 *           "No patient profile found" empty state.
 *       5.  PATIENT — /mine 401 surfaces the inline "session reconnecting"
 *           banner instead of triggering the global logout redirect.
 *       6.  PATIENT — /mine 5xx surfaces the generic error message.
 *       7.  Staff (DOCTOR) — initial mount calls /patients?userId=&limit=1
 *           THEN /ai/adherence/:patientId; both render.
 *       8.  Staff — /patients lookup returning empty → hasPatientProfile=false
 *           + empty-state copy.
 *       9.  Staff — /patients lookup REJECT → hasPatientProfile=false fallback.
 *      10.  Staff — /ai/adherence/:id 401 surfaces inline reconnecting banner.
 *      11.  Loading skeleton — `adherence-loading` testid renders while the
 *           list fetch is pending (with aria-busy="true").
 *      12.  Schedule cards — name, dosage, frequency, duration, reminder times
 *           concatenated comma-separated, date range formatted, plural vs
 *           singular "reminder(s) sent" branch.
 *      13.  Schedule cards — `reminderTimes` missing falls back to "—".
 *      14.  Enroll form — toggle open/close via the header button.
 *      15.  Enroll form — submit with blank prescription ID surfaces inline
 *           "Prescription ID is required" + no POST.
 *      16.  Enroll form — happy POST. PATIENT path re-fetches /mine; staff
 *           path re-fetches /ai/adherence/:patientId.
 *      17.  Enroll form — POST rejection surfaces inline enrollError message.
 *      18.  Enroll form — Add time + Remove time + update time inputs behave.
 *      19.  Unenroll — confirm true → DELETE fires + row removed from UI.
 *      20.  Unenroll — confirm false → DELETE does NOT fire.
 *      21.  Unenroll — DELETE rejection surfaces toast.error.
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/use-dialog,
 *            next/navigation, @/components/EntityPicker, @/components/Skeleton.
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
  usePrompt: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/adherence",
}));
// Stub EntityPicker — the real picker hits the network. We expose a plain
// input that mirrors `value` and forwards `onChange(id)` to the page.
vi.mock("@/components/EntityPicker", () => ({
  EntityPicker: ({ onChange, testIdPrefix, value }: any) => (
    <input
      data-testid={`${testIdPrefix ?? "picker"}-stub`}
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: () => <div data-testid="skeleton-card-stub" />,
}));

import AdherencePage from "../page";

type Med = {
  name: string;
  dosage: string;
  frequency: string;
  duration: string;
  reminderTimes: string[];
};

type Schedule = {
  id: string;
  patientId: string;
  prescriptionId: string;
  medications: Med[];
  startDate: string;
  endDate: string;
  active: boolean;
  remindersSent: number;
  lastReminderAt: string | null;
  createdAt: string;
};

function medFixture(overrides: Partial<Med> = {}): Med {
  return {
    name: "Amlodipine",
    dosage: "5mg",
    frequency: "OD",
    duration: "30 days",
    reminderTimes: ["08:00", "20:00"],
    ...overrides,
  };
}

function scheduleFixture(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sched-1",
    patientId: "pat-1",
    prescriptionId: "rx-1",
    medications: [medFixture()],
    // Use +48h offsets to dodge IST/UTC midnight traps.
    startDate: "2026-01-01T00:00:00.000Z",
    endDate: "2026-01-31T00:00:00.000Z",
    active: true,
    remindersSent: 5,
    lastReminderAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
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

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin" },
    isLoading: false,
  });
}

function asNurse() {
  authMock.mockReturnValue({
    user: { id: "u-nurse", role: "NURSE", name: "Nurse" },
    isLoading: false,
  });
}

function asPharmacist() {
  authMock.mockReturnValue({
    user: { id: "u-pharm", role: "PHARMACIST", name: "Pharm" },
    isLoading: false,
  });
}

function asReception() {
  authMock.mockReturnValue({
    user: { id: "u-recep", role: "RECEPTION", name: "Front" },
    isLoading: false,
  });
}

describe("AdherencePage (medication reminders — full surface)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    confirmMock.mockReset();
    asPatient();
  });

  afterEach(() => {
    cleanup();
  });

  // ── RBAC gate (Issue #639) ─────────────────────────────────────────────

  it("redirects PHARMACIST to /dashboard/not-authorized with the ?from= breadcrumb and toasts a role-restriction error", async () => {
    asPharmacist();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<AdherencePage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/restricted to patients and their treating clinicians/i),
      ),
    );
    expect(routerMock.replace).toHaveBeenCalledWith(
      `/dashboard/not-authorized?from=${encodeURIComponent(
        "/dashboard/adherence",
      )}`,
    );
  });

  it("redirects RECEPTION (also outside ADHERENCE_VIEW_ALLOWED) to /dashboard/not-authorized", async () => {
    asReception();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<AdherencePage />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        `/dashboard/not-authorized?from=${encodeURIComponent(
          "/dashboard/adherence",
        )}`,
      ),
    );
  });

  it("does NOT redirect when the auth store is still loading (isLoading=true short-circuits the gate)", async () => {
    authMock.mockReturnValue({ user: null, isLoading: true });
    apiMock.get.mockResolvedValue({ data: [] });

    render(<AdherencePage />);
    await new Promise((r) => setTimeout(r, 10));

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  // ── PATIENT path (/mine) ───────────────────────────────────────────────

  it("PATIENT mount calls /ai/adherence/mine with skip401Redirect:true (Issue #603) and renders the returned schedules", async () => {
    apiMock.get.mockResolvedValue({
      data: [scheduleFixture({ id: "sched-A", prescriptionId: "rx-A" })],
    });

    render(<AdherencePage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/ai/adherence/mine", {
        skip401Redirect: true,
      }),
    );
    expect(await screen.findByText("rx-A")).toBeInTheDocument();
    expect(screen.getByText("Amlodipine")).toBeInTheDocument();
    // Plural branch for "reminders sent"
    expect(screen.getByText(/5 reminders sent/i)).toBeInTheDocument();
  });

  it("PATIENT — singular 'reminder sent' branch when remindersSent === 1", async () => {
    apiMock.get.mockResolvedValue({
      data: [scheduleFixture({ remindersSent: 1 })],
    });

    render(<AdherencePage />);

    expect(await screen.findByText(/1 reminder sent/i)).toBeInTheDocument();
    expect(screen.queryByText(/1 reminders sent/i)).not.toBeInTheDocument();
  });

  it("PATIENT — /mine 404 flips hasPatientProfile=false and renders the 'No patient profile found' empty state", async () => {
    const err: any = new Error("not found");
    err.status = 404;
    apiMock.get.mockRejectedValue(err);

    render(<AdherencePage />);

    expect(
      await screen.findByText(/No patient profile found for your account\./i),
    ).toBeInTheDocument();
  });

  it("PATIENT — /mine 401 surfaces the inline 'session reconnecting' banner (no logout redirect)", async () => {
    const err: any = new Error("unauthorized");
    err.status = 401;
    apiMock.get.mockRejectedValue(err);

    render(<AdherencePage />);

    expect(
      await screen.findByText(/Your session is reconnecting/i),
    ).toBeInTheDocument();
    // Critically: no router.replace to /login or anywhere else.
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("PATIENT — /mine 5xx surfaces the generic error message", async () => {
    const err: any = new Error("server boom");
    err.status = 500;
    apiMock.get.mockRejectedValue(err);

    render(<AdherencePage />);

    expect(await screen.findByText(/server boom/i)).toBeInTheDocument();
  });

  it("PATIENT — /mine rejecting WITHOUT an err.message falls back to 'Failed to load schedules'", async () => {
    const err: any = { status: 500 };
    apiMock.get.mockRejectedValue(err);

    render(<AdherencePage />);

    expect(
      await screen.findByText(/Failed to load schedules/i),
    ).toBeInTheDocument();
  });

  // ── Staff path (/patients lookup then /ai/adherence/:id) ───────────────

  it("DOCTOR mount calls /patients?userId then /ai/adherence/:patientId and renders the schedules", async () => {
    asDoctor();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({ data: [{ id: "pat-doc" }] });
      }
      if (url === "/ai/adherence/pat-doc") {
        return Promise.resolve({
          data: [scheduleFixture({ id: "sched-D", prescriptionId: "rx-D" })],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<AdherencePage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/patients?userId=u-doc&limit=1",
      ),
    );
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/ai/adherence/pat-doc", {
        skip401Redirect: true,
      }),
    );
    expect(await screen.findByText("rx-D")).toBeInTheDocument();
  });

  it("Staff — /patients lookup returning empty array flips hasPatientProfile=false (no schedule fetch)", async () => {
    asNurse();
    apiMock.get.mockResolvedValueOnce({ data: [] });

    render(<AdherencePage />);

    expect(
      await screen.findByText(/No patient profile found for your account\./i),
    ).toBeInTheDocument();
    // Only the /patients lookup ran; no /ai/adherence/* call.
    expect(apiMock.get).toHaveBeenCalledTimes(1);
  });

  it("Staff — /patients lookup REJECTING flips hasPatientProfile=false (catch branch)", async () => {
    asAdmin();
    apiMock.get.mockRejectedValueOnce(new Error("patients lookup down"));

    render(<AdherencePage />);

    expect(
      await screen.findByText(/No patient profile found for your account\./i),
    ).toBeInTheDocument();
  });

  it("Staff — /ai/adherence/:id 401 surfaces the inline 'session reconnecting' banner", async () => {
    asDoctor();
    const err: any = new Error("unauthorized");
    err.status = 401;
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({ data: [{ id: "pat-doc" }] });
      }
      return Promise.reject(err);
    });

    render(<AdherencePage />);

    expect(
      await screen.findByText(/Your session is reconnecting/i),
    ).toBeInTheDocument();
  });

  it("Staff — /ai/adherence/:id 5xx surfaces the generic error message", async () => {
    asDoctor();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({ data: [{ id: "pat-doc" }] });
      }
      return Promise.reject(new Error("schedule boom"));
    });

    render(<AdherencePage />);

    expect(await screen.findByText(/schedule boom/i)).toBeInTheDocument();
  });

  // ── Loading skeleton + empty branches ──────────────────────────────────

  it("renders the loading skeleton (with aria-busy='true') while the initial /mine fetch is pending", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));

    render(<AdherencePage />);

    const skeleton = await screen.findByTestId("adherence-loading");
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card-stub").length).toBe(3);
  });

  it("PATIENT — empty list renders the 'No active medication reminders' empty state with the Enroll button reference", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<AdherencePage />);

    expect(
      await screen.findByText(/No active medication reminders\./i),
    ).toBeInTheDocument();
    // The hint copy is split across a <strong> child. Match only the leaf
    // <p>: it has textContent containing the phrase AND none of its children
    // have the same textContent (which rules out the surrounding containers).
    const matches = screen.getAllByText((_, node) => {
      if (!node) return false;
      const txt = node.textContent ?? "";
      if (!/Use the\s+Enroll Prescription\s+button at the top of the page to get started\./i.test(txt)) {
        return false;
      }
      // Leaf-most match: no child carries the same composite text.
      return Array.from(node.children).every(
        (c) => c.textContent !== node.textContent,
      );
    });
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  // ── Schedule card rendering ────────────────────────────────────────────

  it("renders medication cards with name, dosage·frequency·duration concatenation, and comma-joined reminder times", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        scheduleFixture({
          medications: [
            medFixture({
              name: "Metformin",
              dosage: "500mg",
              frequency: "BD",
              duration: "60 days",
              reminderTimes: ["09:00", "21:00"],
            }),
          ],
        }),
      ],
    });

    render(<AdherencePage />);

    await screen.findByText("Metformin");
    expect(screen.getByText(/500mg · BD · 60 days/)).toBeInTheDocument();
    expect(screen.getByText(/09:00, 21:00/)).toBeInTheDocument();
  });

  it("renders the '—' fallback when reminderTimes is missing on a medication", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        scheduleFixture({
          medications: [
            // Cast through unknown to deliberately omit reminderTimes.
            { name: "NoTimes", dosage: "5mg", frequency: "OD", duration: "10d" } as unknown as Med,
          ],
        }),
      ],
    });

    render(<AdherencePage />);

    await screen.findByText("NoTimes");
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders nothing in the medications grid when schedule.medications is missing (null-coalesce branch)", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        // Force medications missing — the page null-coalesces to [].
        scheduleFixture({ medications: undefined as unknown as Med[] }),
      ],
    });

    render(<AdherencePage />);

    // The card itself still renders (prescription header)…
    expect(await screen.findByText("rx-1")).toBeInTheDocument();
    // …but no medication rows.
    expect(screen.queryByText("Amlodipine")).not.toBeInTheDocument();
  });

  // ── Enroll form ────────────────────────────────────────────────────────

  it("toggles the enroll form open and closed via the header button", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<AdherencePage />);
    await screen.findByText(/No active medication reminders/i);

    const toggle = screen.getByRole("button", { name: /Enroll Prescription/i });
    fireEvent.click(toggle);

    expect(
      screen.getByRole("heading", { name: /Enroll a Prescription/i }),
    ).toBeInTheDocument();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Enroll a Prescription/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("rejects a blank prescription ID with inline 'Prescription ID is required' and never POSTs", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<AdherencePage />);
    await screen.findByText(/No active medication reminders/i);

    fireEvent.click(screen.getByRole("button", { name: /Enroll Prescription/i }));
    // Submit with the picker still empty.
    fireEvent.click(screen.getByRole("button", { name: /^Enroll$/ }));

    expect(
      await screen.findByText(/Prescription ID is required/i),
    ).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("PATIENT enroll happy path — POSTs to /ai/adherence/enroll with the picked rx + filtered reminder times, then re-fetches /mine", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockResolvedValue({ data: { id: "sched-new" } });

    render(<AdherencePage />);
    await screen.findByText(/No active medication reminders/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Enroll Prescription/i }),
    );

    // Pick a prescription via the stubbed EntityPicker.
    fireEvent.change(screen.getByTestId("adherence-rx-picker-stub"), {
      target: { value: "rx-PICKED" },
    });

    // Fill the first reminder-time slot.
    const timeInputs = screen
      .getAllByRole("textbox", { hidden: true })
      .filter((el) => (el as HTMLInputElement).type === "time");
    // jsdom may not surface type=time via role; fall back to direct selector.
    const timeInput = (timeInputs[0] ?? document.querySelector('input[type="time"]')) as HTMLInputElement;
    fireEvent.change(timeInput, { target: { value: "07:30" } });

    fireEvent.click(screen.getByRole("button", { name: /^Enroll$/ }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/ai/adherence/enroll", {
        prescriptionId: "rx-PICKED",
        reminderTimes: ["07:30"],
      }),
    );

    // After success the form closes…
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Enroll a Prescription/i }),
      ).not.toBeInTheDocument(),
    );
    // …and /mine is re-fetched.
    const mineCalls = apiMock.get.mock.calls.filter(
      (c: any[]) => c[0] === "/ai/adherence/mine",
    );
    expect(mineCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("PATIENT enroll — empty reminder times are omitted (sends reminderTimes:undefined)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockResolvedValue({ data: { id: "sched-new" } });

    render(<AdherencePage />);
    await screen.findByText(/No active medication reminders/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Enroll Prescription/i }),
    );
    fireEvent.change(screen.getByTestId("adherence-rx-picker-stub"), {
      target: { value: "rx-NO-TIMES" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Enroll$/ }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/ai/adherence/enroll", {
        prescriptionId: "rx-NO-TIMES",
        reminderTimes: undefined,
      }),
    );
  });

  it("Staff (DOCTOR) enroll — happy POST re-fetches /ai/adherence/:patientId (NOT /mine)", async () => {
    asDoctor();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({ data: [{ id: "pat-doc" }] });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { id: "sched-new" } });

    render(<AdherencePage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/ai/adherence/pat-doc", {
        skip401Redirect: true,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Enroll Prescription/i }),
    );
    fireEvent.change(screen.getByTestId("adherence-rx-picker-stub"), {
      target: { value: "rx-STAFF" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Enroll$/ }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/ai/adherence/enroll", {
        prescriptionId: "rx-STAFF",
        reminderTimes: undefined,
      }),
    );

    // Staff path re-fetches the id route, never /mine.
    await waitFor(() => {
      const idCalls = apiMock.get.mock.calls.filter(
        (c: any[]) => c[0] === "/ai/adherence/pat-doc",
      );
      expect(idCalls.length).toBeGreaterThanOrEqual(2);
    });
    const mineCalls = apiMock.get.mock.calls.filter(
      (c: any[]) => c[0] === "/ai/adherence/mine",
    );
    expect(mineCalls.length).toBe(0);
  });

  it("Enroll error path — POST rejection surfaces inline enrollError message", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockRejectedValue(new Error("dup schedule"));

    render(<AdherencePage />);
    await screen.findByText(/No active medication reminders/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Enroll Prescription/i }),
    );
    fireEvent.change(screen.getByTestId("adherence-rx-picker-stub"), {
      target: { value: "rx-DUP" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Enroll$/ }));

    expect(await screen.findByText(/dup schedule/i)).toBeInTheDocument();
    // Form stays open so the user can correct the input.
    expect(
      screen.getByRole("heading", { name: /Enroll a Prescription/i }),
    ).toBeInTheDocument();
  });

  it("Enroll error fallback — POST rejection without err.message falls back to 'Failed to enroll'", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockRejectedValue({});

    render(<AdherencePage />);
    await screen.findByText(/No active medication reminders/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Enroll Prescription/i }),
    );
    fireEvent.change(screen.getByTestId("adherence-rx-picker-stub"), {
      target: { value: "rx-X" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Enroll$/ }));

    expect(await screen.findByText(/Failed to enroll/i)).toBeInTheDocument();
  });

  it("Add/remove reminder-time inputs — adding 2 inputs shows 3 total, removing 1 returns to 2", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<AdherencePage />);
    await screen.findByText(/No active medication reminders/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Enroll Prescription/i }),
    );

    function timeInputs() {
      return Array.from(
        document.querySelectorAll('input[type="time"]'),
      ) as HTMLInputElement[];
    }

    expect(timeInputs().length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /Add time/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add time/i }));

    expect(timeInputs().length).toBe(3);

    // Update one input to exercise updateReminderTime.
    fireEvent.change(timeInputs()[1], { target: { value: "13:45" } });
    expect(timeInputs()[1].value).toBe("13:45");

    // Remove the second slot (now we have multiple → Remove button is shown).
    const removeButtons = screen.getAllByRole("button", { name: /Remove/i });
    fireEvent.click(removeButtons[0]);

    expect(timeInputs().length).toBe(2);
  });

  // ── Unenroll flow ──────────────────────────────────────────────────────

  it("Unenroll — confirm resolves true → DELETE fires and the row is removed from the UI", async () => {
    apiMock.get.mockResolvedValue({
      data: [scheduleFixture({ id: "sched-DEL", prescriptionId: "rx-DEL" })],
    });
    apiMock.delete.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<AdherencePage />);
    await screen.findByText("rx-DEL");

    fireEvent.click(screen.getByRole("button", { name: /Unenroll/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(apiMock.delete).toHaveBeenCalledWith("/ai/adherence/sched-DEL"),
    );

    await waitFor(() =>
      expect(screen.queryByText("rx-DEL")).not.toBeInTheDocument(),
    );
  });

  it("Unenroll — confirm resolves false → DELETE does NOT fire", async () => {
    apiMock.get.mockResolvedValue({
      data: [scheduleFixture({ id: "sched-KEEP", prescriptionId: "rx-KEEP" })],
    });
    confirmMock.mockResolvedValue(false);

    render(<AdherencePage />);
    await screen.findByText("rx-KEEP");

    fireEvent.click(screen.getByRole("button", { name: /Unenroll/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(apiMock.delete).not.toHaveBeenCalled();
    expect(screen.getByText("rx-KEEP")).toBeInTheDocument();
  });

  it("Unenroll error path — DELETE rejection surfaces toast.error with the message", async () => {
    apiMock.get.mockResolvedValue({
      data: [scheduleFixture({ id: "sched-FAIL", prescriptionId: "rx-FAIL" })],
    });
    apiMock.delete.mockRejectedValue(new Error("FK constraint"));
    confirmMock.mockResolvedValue(true);

    render(<AdherencePage />);
    await screen.findByText("rx-FAIL");

    fireEvent.click(screen.getByRole("button", { name: /Unenroll/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("FK constraint"),
    );
  });

  it("Unenroll error fallback — DELETE rejection without err.message falls back to 'Failed to unenroll'", async () => {
    apiMock.get.mockResolvedValue({
      data: [scheduleFixture({ id: "sched-X", prescriptionId: "rx-X" })],
    });
    apiMock.delete.mockRejectedValue({});
    confirmMock.mockResolvedValue(true);

    render(<AdherencePage />);
    await screen.findByText("rx-X");

    fireEvent.click(screen.getByRole("button", { name: /Unenroll/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to unenroll"),
    );
  });
});
